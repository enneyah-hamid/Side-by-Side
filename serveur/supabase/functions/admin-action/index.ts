// Espace administrateur : chaque appel exige le rôle admin ET la double authentification (aal2).
// Chaque décision est enregistrée dans le journal d'audit.
import { stripe, admin, json, serve, requireAdmin, cents, event, audit, notify, HttpError, transition } from "../_shared/clients.ts";
import { releasePayout } from "../_shared/payout.ts";

const signed = async (path?: string | null) => path ? (await admin.storage.from("documents").createSignedUrl(path, 600)).data?.signedUrl ?? null : null;

serve(async (req) => {
  const me = await requireAdmin(req);
  const body = await req.json();
  switch (body.action) {
    case "overview": {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [ids, comps, disputes, alerts, review, logs] = await Promise.all([
        admin.from("identity_checks").select("id, user_id, doc_path, selfie_path, created_at, profiles!identity_checks_user_id_fkey(first_name, last_name, birth_date, role)").eq("status", "pending").order("created_at").limit(50),
        admin.from("companions").select("id, bio, hourly_rate, tier, categories, verified, video_interview_ok, legal_status, tax_id, admin_status, admin_doc_path, profiles!companions_id_fkey(first_name, last_name, city, identity_verified, suspended)").or("verified.eq.false,admin_status.eq.en_cours").limit(50),
        admin.from("disputes").select("*, bookings(ref, status, amount_total, amount_payout)").eq("status", "ouvert").order("deadline").limit(50),
        admin.from("safety_alerts").select("*, bookings(ref)").gte("created_at", since).order("created_at", { ascending: false }).limit(50),
        admin.from("bookings").select("id, ref, status, starts_at, amount_total, payout_error").in("status", ["a_verifier", "incident", "contestee"]).order("starts_at").limit(50),
        admin.from("audit_log").select("*").order("created_at", { ascending: false }).limit(50),
      ]);
      const identity = await Promise.all((ids.data ?? []).map(async (x) => ({ ...x, doc_url: await signed(x.doc_path), selfie_url: await signed(x.selfie_path) })));
      await audit(me.id, "Consultation du tableau de bord administrateur (pièces d'identité incluses)");
      const companions = await Promise.all((comps.data ?? []).map(async (c: any) => ({ ...c, admin_doc_url: await signed(c.admin_doc_path) })));
      return json({ identity, companions, disputes: disputes.data ?? [], alerts: alerts.data ?? [], review: review.data ?? [], logs: logs.data ?? [] });
    }
    case "identity_review": {
      const { data: c } = await admin.from("identity_checks").update({ status: body.approve ? "approved" : "refused", reason: body.reason ? String(body.reason).slice(0, 300) : null, reviewed_by: me.id, reviewed_at: new Date().toISOString() })
        .eq("id", body.check_id).eq("status", "pending").select().single();
      if (!c) throw new HttpError(409, "Dossier déjà traité");
      if (body.approve) await admin.from("profiles").update({ identity_verified: true }).eq("id", c.user_id);
      await audit(me.id, `Identité ${body.approve ? "validée" : "refusée"}${body.reason ? ` : ${body.reason}` : ""}`, c.user_id);
      await notify(c.user_id, body.approve ? "Votre identité est vérifiée. Vous pouvez réserver." : `Votre pièce d'identité n'a pas pu être validée${body.reason ? ` : ${body.reason}` : ""}. Déposez-en une nouvelle.`, null, "verification");
      return json({ ok: true });
    }
    case "companion_review": {
      const patch: Record<string, unknown> = { verified: !!body.approve, video_interview_ok: !!body.approve && body.video_ok !== false };
      if (body.tier && ["Standard", "Prestige"].includes(body.tier)) patch.tier = body.tier;
      const { data: c } = await admin.from("companions").update(patch).eq("id", body.companion_id).select().single();
      if (!c) throw new HttpError(404, "Accompagnateur introuvable");
      await audit(me.id, `Profil accompagnateur ${body.approve ? "validé" : "refusé"}${body.tier ? ` (${body.tier})` : ""}`, c.id);
      await notify(c.id, body.approve ? "Votre profil est validé : il est désormais visible des clients." : "Votre profil n'a pas été validé. Contactez l'assistance.", null, "verification");
      return json({ ok: true });
    }
    case "admin_review": {                                      // dossier administratif de l'accompagnateur (statut, SIRET, justificatif)
      const { data: c } = await admin.from("companions").update({ admin_status: body.approve ? "valide" : "refuse" }).eq("id", body.companion_id).eq("admin_status", "en_cours").select("id").single();
      if (!c) throw new HttpError(409, "Dossier déjà traité");
      await audit(me.id, `Dossier administratif ${body.approve ? "validé" : "refusé"}${body.reason ? ` : ${body.reason}` : ""}`, c.id);
      await notify(c.id, body.approve ? "Votre dossier administratif est validé." : `Votre dossier administratif est refusé${body.reason ? ` : ${body.reason}` : ""}. Transmettez un nouveau justificatif.`, null, "verification");
      return json({ ok: true });
    }
    case "suspend": {
      if (body.user_id === me.id) throw new HttpError(400, "Impossible de vous suspendre vous-même");
      const reason = String(body.reason ?? "").trim();
      if (body.suspended && reason.length < 5) throw new HttpError(400, "Indiquez le motif de la suspension");
      const { data: p } = await admin.from("profiles").update({ suspended: !!body.suspended }).eq("id", body.user_id).select("id").single();
      if (!p) throw new HttpError(404, "Membre introuvable");
      await audit(me.id, `${body.suspended ? "Suspension" : "Réactivation"} du compte${reason ? ` : ${reason}` : ""}`, p.id);
      await notify(p.id, body.suspended ? "Votre compte est suspendu. Vous pouvez contester cette décision auprès de l'assistance." : "Votre compte est réactivé.", null, "compte");
      return json({ ok: true });
    }
    case "dispute_decide": {
      // decision : "payout" (versement à l'accompagnateur) ou "refund" (remboursement du client, refund_pct %)
      const note = String(body.note ?? "").trim();
      if (note.length < 5) throw new HttpError(400, "Motivez la décision");
      const { data: d } = await admin.from("disputes").update({ status: "decide", decision: `${body.decision}${body.refund_pct != null ? ` ${body.refund_pct} %` : ""} — ${note}`.slice(0, 1000) })
        .eq("id", body.dispute_id).eq("status", "ouvert").select().single();
      if (!d) throw new HttpError(409, "Dossier déjà tranché");
      const { data: b } = await admin.from("bookings").select("*").eq("id", d.booking_id).single();
      const open = ["a_verifier", "incident", "contestee", "double_attente", "en_cours", "fin_declaree", "absence", "verifie", "controle", "confirmee"];
      let result: unknown = null;
      if (body.decision === "refund") {
        const pct = Math.max(0, Math.min(100, Number(body.refund_pct ?? 100)));
        const amount = Math.round((Number(b.amount_total) - Number(b.gift_used)) * pct) / 100;
        if (amount > 0 && b.stripe_payment_intent_id) {
          const r = await stripe.refunds.create({ payment_intent: b.stripe_payment_intent_id, amount: cents(amount) }, { idempotencyKey: `refund-dispute-${d.id}` });
          const { error } = await admin.from("ledger").insert({ booking_id: b.id, kind: "Remboursement (litige)", amount: -amount, stripe_object_id: r.id });
          if (error && error.code !== "23505") throw error;
        }
        await admin.rpc("refund_gift", { p_booking: b.id, p_pct: pct });
        if (pct < 100) {
          const payout = Math.round(Number(b.amount_payout) * (100 - pct)) / 100;
          await admin.from("bookings").update({ amount_payout: payout, end_client: b.end_client ?? new Date().toISOString(), end_companion: b.end_companion ?? new Date().toISOString() }).eq("id", b.id);
          await transition(b.id, open, { status: "terminee" });
          result = await releasePayout(b.id, me.id);
        } else {
          await transition(b.id, open, { status: "annulee" });
        }
        await notify(b.client_id, `Décision sur ${b.ref} : remboursement de ${pct} %.`, b.id, "litige");
        await notify(b.companion_id, `Décision sur ${b.ref} : remboursement du client de ${pct} %.`, b.id, "litige");
      } else if (body.decision === "payout") {
        await admin.from("bookings").update({ end_client: b.end_client ?? new Date().toISOString(), end_companion: b.end_companion ?? new Date().toISOString() }).eq("id", b.id);
        await transition(b.id, open, { status: "terminee" });
        result = await releasePayout(b.id, me.id);
        await notify(b.client_id, `Décision sur ${b.ref} : prestation considérée comme réalisée.`, b.id, "litige");
        await notify(b.companion_id, `Décision sur ${b.ref} : versement validé.`, b.id, "litige");
      } else throw new HttpError(400, "Décision inconnue");
      await event(b.id, null, me.id, `décision de litige : ${body.decision}`);
      await audit(me.id, `Litige tranché (${body.decision}) : ${note}`, b.ref);
      return json({ ok: true, payout: result });
    }
    default: throw new HttpError(400, "Action inconnue");
  }
});
