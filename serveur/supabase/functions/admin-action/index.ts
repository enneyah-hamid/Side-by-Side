// Espace de gestion Side by Side (sidebyside.zyntell.fr/gestion)
// Chaque appel : rôle admin + compte administrateur actif + TOTP (aal2) + session active (< 15 min d'inactivité).
// Opérations sensibles : nouvelle saisie du code TOTP de moins de 5 minutes (requireStepUp).
// Gestion des administrateurs et des paramètres : super-administrateur uniquement.
// Toutes les données proviennent de la base de production ; chaque décision est journalisée.
import { stripe, admin, json, serve, requireAdmin, requireSuper, requireStepUp, cents, event, audit, notify, notifyAdmins, HttpError, transition, authEvent, endAdminSession, type AdminCtx } from "../_shared/clients.ts";
import { releasePayout } from "../_shared/payout.ts";

const PAGE = 50;
const signed = async (bucket: string, path?: string | null, sec = 600) => path ? (await admin.storage.from(bucket).createSignedUrl(path, sec)).data?.signedUrl ?? null : null;
const txt = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const page = (b: any) => Math.max(0, Number(b.page ?? 0) | 0);
const isoOr = (v: unknown, d: Date) => { const t = Date.parse(String(v ?? "")); return isNaN(t) ? d.toISOString() : new Date(t).toISOString(); };
const PAID = ["confirmee", "controle", "verifie", "en_cours", "fin_declaree", "double_attente", "terminee", "versement", "cloturee", "a_verifier", "incident", "contestee"];
const ALLOWED_WHEN_PASSWORD_CHANGE = new Set(["me", "ping"]);
async function names(ids: string[]) {
  const u = [...new Set(ids.filter(Boolean))];
  if (!u.length) return {} as Record<string, string>;
  const { data } = await admin.from("profiles").select("id, first_name, last_name").in("id", u);
  return Object.fromEntries((data ?? []).map((p: any) => [p.id, `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim()]));
}
async function targetGuard(me: AdminCtx, userId: string) {
  const { data: acc } = await admin.from("admin_accounts").select("level, revoked_at").eq("user_id", userId).maybeSingle();
  if (acc && !acc.revoked_at) {
    if (acc.level === "super") throw new HttpError(403, "Le compte du dirigeant ne peut pas être modifié depuis l'espace de gestion");
    requireSuper(me);
  }
}

serve(async (req) => {
  const me = await requireAdmin(req);
  const body = await req.json().catch(() => ({}));
  const a = String(body.action ?? "");
  if (me.must_change_password && !ALLOWED_WHEN_PASSWORD_CHANGE.has(a)) throw new HttpError(403, "Changez d'abord votre mot de passe provisoire.");
  switch (a) {
    // ---------------- Session ----------------
    case "ping": return json({ ok: true });
    case "me": return json({ id: me.id, email: me.email, first_name: me.first_name, level: me.level, must_change_password: me.must_change_password });

    // ---------------- Tableau de bord ----------------
    case "overview": {   // conservé : dossiers à traiter (identités, profils, litiges, alertes, missions)
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [ids, comps, disputes, alerts, review, logs] = await Promise.all([
        admin.from("identity_checks").select("id, user_id, doc_path, selfie_path, created_at, profiles!identity_checks_user_id_fkey(first_name, last_name, birth_date, role)").eq("status", "pending").order("created_at").limit(PAGE),
        admin.from("companions").select("id, bio, hourly_rate, tier, categories, verified, video_interview_ok, legal_status, tax_id, admin_status, admin_doc_path, profiles!companions_id_fkey(first_name, last_name, city, identity_verified, suspended)").or("verified.eq.false,admin_status.eq.en_cours").limit(PAGE),
        admin.from("disputes").select("*, bookings(ref, status, amount_total, amount_payout)").eq("status", "ouvert").order("deadline").limit(PAGE),
        admin.from("safety_alerts").select("*, bookings(ref)").gte("created_at", since).order("created_at", { ascending: false }).limit(PAGE),
        admin.from("bookings").select("id, ref, status, starts_at, amount_total, payout_error").in("status", ["a_verifier", "incident", "contestee"]).order("starts_at").limit(PAGE),
        admin.from("audit_log").select("*").order("created_at", { ascending: false }).limit(PAGE),
      ]);
      const identity = await Promise.all((ids.data ?? []).map(async (x: any) => ({ ...x, doc_url: await signed("documents", x.doc_path), selfie_url: await signed("documents", x.selfie_path) })));
      const companions = await Promise.all((comps.data ?? []).map(async (c: any) => ({ ...c, admin_doc_url: await signed("documents", c.admin_doc_path) })));
      const { data: counts } = await admin.rpc("adm_counts");
      await audit(me.id, "Consultation des dossiers à traiter (pièces d'identité incluses)");
      return json({ identity, companions, disputes: disputes.data ?? [], alerts: alerts.data ?? [], review: review.data ?? [], logs: logs.data ?? [], counts: counts ?? {} });
    }
    case "dashboard": {
      const days = [7, 30, 90, 365].includes(Number(body.days)) ? Number(body.days) : 0;
      const to = new Date(Date.now() + 86_400_000), from = days ? new Date(Date.now() - days * 86_400_000) : new Date("2020-01-01");
      const [{ data: counts }, { data: finance }, { data: notes }] = await Promise.all([
        admin.rpc("adm_counts"), admin.rpc("adm_finance", { p_from: from.toISOString(), p_to: to.toISOString() }),
        admin.from("notifications").select("id, body, kind, created_at, read_at, booking_id").eq("user_id", me.id).order("created_at", { ascending: false }).limit(20),
      ]);
      return json({ counts: counts ?? {}, finance: finance ?? {}, notifications: notes ?? [] });
    }
    case "notifications_read": {
      await admin.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", me.id).is("read_at", null);
      return json({ ok: true });
    }

    // ---------------- Membres (clients et accompagnateurs) ----------------
    case "users": {
      const role = ["client", "companion"].includes(body.role) ? body.role : "";
      const status = ["suspendu", "non_verifie", "a_valider"].includes(body.status) ? body.status : "";
      const { data, error } = await admin.rpc("adm_users", { p_role: role, p_q: txt(body.q, 80), p_status: status, p_limit: PAGE, p_offset: page(body) * PAGE });
      if (error) throw error;
      return json({ users: data ?? [], total: Number(data?.[0]?.total ?? 0), page: page(body), size: PAGE });
    }
    case "user_detail": {
      const id = txt(body.user_id, 40);
      const { data: p } = await admin.from("profiles").select("*").eq("id", id).maybeSingle();
      if (!p || p.role === "admin") throw new HttpError(404, "Membre introuvable");
      const [{ data: email }, { data: c }, { data: bk }, { data: idc }, { data: tickets }, { data: logs }, { data: photos }] = await Promise.all([
        admin.rpc("adm_email", { p_user: id }),
        admin.from("companions").select("*").eq("id", id).maybeSingle(),
        admin.from("bookings").select("id, ref, status, starts_at, hours, amount_total, client_id, companion_id").or(`client_id.eq.${id},companion_id.eq.${id}`).order("starts_at", { ascending: false }).limit(20),
        admin.from("identity_checks").select("id, status, reason, created_at, reviewed_at").eq("user_id", id).order("created_at", { ascending: false }).limit(5),
        admin.from("support_tickets").select("id, ref, subject, status, created_at").eq("user_id", id).order("created_at", { ascending: false }).limit(10),
        admin.from("audit_log").select("created_at, action, actor_id").eq("ref", id).order("created_at", { ascending: false }).limit(20),
        admin.from("companion_photos").select("id, status, created_at, storage_path, is_reference").eq("companion_id", id).order("created_at", { ascending: false }).limit(6),
      ]);
      let insurance = null;
      if (c) { const r = await admin.from("companion_insurances").select("insurer, policy_number, starts_on, ends_on, status").eq("companion_id", id).order("created_at", { ascending: false }).limit(3); insurance = r.error ? null : r.data; }
      const photoUrls = await Promise.all((photos ?? []).map(async (x: any) => ({ ...x, url: await signed("photos", x.storage_path, 300) })));
      const nm = await names((logs ?? []).map((l: any) => l.actor_id));
      await audit(me.id, "Consultation d'une fiche membre", id);
      return json({ profile: { ...p, email }, companion: c ? { ...c, admin_doc_url: await signed("documents", c.admin_doc_path) } : null, bookings: bk ?? [], identity: idc ?? [],
        tickets: tickets ?? [], logs: (logs ?? []).map((l: any) => ({ ...l, actor: nm[l.actor_id] ?? "Système" })), photos: photoUrls, insurance });
    }
    case "suspend": {
      requireStepUp(me);
      const uid = txt(body.user_id, 40);
      if (uid === me.id) throw new HttpError(400, "Impossible de vous suspendre vous-même");
      await targetGuard(me, uid);
      const reason = txt(body.reason, 300);
      if (reason.length < 5) throw new HttpError(400, "Indiquez le motif (5 caractères minimum)");
      const { data: p } = await admin.from("profiles").update({ suspended: !!body.suspended }).eq("id", uid).select("id").single();
      if (!p) throw new HttpError(404, "Membre introuvable");
      await audit(me.id, `${body.suspended ? "Suspension" : "Réactivation"} du compte : ${reason}`, p.id);
      await notify(p.id, body.suspended ? "Votre compte est suspendu. Vous pouvez contester cette décision auprès de l'assistance (contact@zyntell.fr)." : "Votre compte est réactivé.", null, "compte");
      return json({ ok: true });
    }

    // ---------------- Vérifications ----------------
    case "identity_review": {
      const reason = txt(body.reason, 300);
      if (!body.approve && reason.length < 5) throw new HttpError(400, "Indiquez le motif du refus (5 caractères minimum)");
      const { data: c } = await admin.from("identity_checks").update({ status: body.approve ? "approved" : "refused", reason: reason || null, reviewed_by: me.id, reviewed_at: new Date().toISOString() })
        .eq("id", body.check_id).eq("status", "pending").select().single();
      if (!c) throw new HttpError(409, "Dossier déjà traité");
      if (body.approve) await admin.from("profiles").update({ identity_verified: true }).eq("id", c.user_id);
      await audit(me.id, `Identité ${body.approve ? "validée" : "refusée"}${reason ? ` : ${reason}` : ""}`, c.user_id);
      await notify(c.user_id, body.approve ? "Votre identité est vérifiée. Vous pouvez réserver." : `Votre pièce d'identité n'a pas pu être validée : ${reason}. Déposez-en une nouvelle.`, null, "verification");
      return json({ ok: true });
    }
    case "companion_review": {
      const patch: Record<string, unknown> = { verified: !!body.approve, video_interview_ok: !!body.approve && body.video_ok !== false };
      if (body.tier && ["Standard", "Prestige"].includes(body.tier)) patch.tier = body.tier;
      if (body.approve) {
        const { data: pr } = await admin.from("profiles").select("identity_verified").eq("id", body.companion_id).maybeSingle();
        if (!pr?.identity_verified) throw new HttpError(409, "Vérifiez d'abord l'identité de l'accompagnateur");
      }
      const { data: c } = await admin.from("companions").update(patch).eq("id", body.companion_id).select().single();
      if (!c) throw new HttpError(404, "Accompagnateur introuvable");
      await audit(me.id, `Profil accompagnateur ${body.approve ? "validé" : "refusé"}${body.tier ? ` (${body.tier})` : ""}`, c.id);
      await notify(c.id, body.approve ? "Votre profil est validé : il est désormais visible des clients." : "Votre profil n'a pas été validé. Contactez l'assistance.", null, "verification");
      return json({ ok: true });
    }
    case "admin_review": {   // dossier administratif de l'accompagnateur (statut, SIRET, justificatif) — anomalie A4
      const reason = txt(body.reason, 300);
      if (!body.approve && reason.length < 5) throw new HttpError(400, "Indiquez le motif du refus (5 caractères minimum)");
      const { data: c } = await admin.from("companions").update({ admin_status: body.approve ? "valide" : "refuse" }).eq("id", body.companion_id).eq("admin_status", "en_cours").select("id").single();
      if (!c) throw new HttpError(409, "Dossier déjà traité");
      await audit(me.id, `Dossier administratif ${body.approve ? "validé" : "refusé"}${reason ? ` : ${reason}` : ""}`, c.id);
      await notify(c.id, body.approve ? "Votre dossier administratif est validé." : `Votre dossier administratif est refusé : ${reason}. Transmettez un nouveau justificatif.`, null, "verification");
      return json({ ok: true });
    }
    case "photos": {   // photos à vérifier — anomalie A5
      const { data } = await admin.from("companion_photos").select("id, companion_id, storage_path, is_reference, ai_suspect, created_at, companions!inner(id, profiles!companions_id_fkey(first_name, last_name, city))").eq("status", "pending").order("created_at").limit(PAGE);
      const list = await Promise.all((data ?? []).map(async (x: any) => {
        const { data: cur } = await admin.from("companion_photos").select("storage_path").eq("companion_id", x.companion_id).eq("status", "ok").eq("is_reference", false).order("created_at", { ascending: false }).limit(1);
        return { ...x, url: await signed("photos", x.storage_path, 300), current_url: await signed("photos", cur?.[0]?.storage_path, 300) };
      }));
      return json({ photos: list });
    }
    case "photo_review": {
      const reason = txt(body.reason, 200);
      if (!body.approve && reason.length < 5) throw new HttpError(400, "Indiquez le motif du refus (5 caractères minimum)");
      const { data: ph } = await admin.from("companion_photos").update({ status: body.approve ? "ok" : "refused" }).eq("id", body.photo_id).eq("status", "pending").select("id, companion_id").single();
      if (!ph) throw new HttpError(409, "Photo déjà traitée");
      await audit(me.id, `Photo ${body.approve ? "validée" : "refusée"}${reason ? ` : ${reason}` : ""}`, ph.companion_id);
      await notify(ph.companion_id, body.approve ? "Votre nouvelle photo est validée : elle est visible sur votre profil." : `Votre photo n'a pas été validée : ${reason}. Envoyez une photo réelle et récente.`, null, "verification");
      return json({ ok: true });
    }
    case "reviews": {
      const st = ["moderation", "publie", "masque", "aveugle"].includes(body.status) ? body.status : "moderation";
      const { data } = await admin.from("reviews").select("id, booking_id, author_id, target_id, stars, body, status, created_at, bookings(ref)").eq("status", st).order("created_at", { ascending: false }).limit(PAGE);
      const nm = await names((data ?? []).flatMap((r: any) => [r.author_id, r.target_id]));
      return json({ reviews: (data ?? []).map((r: any) => ({ ...r, author: nm[r.author_id] ?? "", target: nm[r.target_id] ?? "" })) });
    }
    case "review_moderate": {
      const status = body.publish ? "publie" : "masque";
      const { data: r } = await admin.from("reviews").update({ status }).eq("id", body.review_id).select("id, author_id, bookings(ref)").single();
      if (!r) throw new HttpError(404, "Avis introuvable");
      await audit(me.id, `Avis ${body.publish ? "publié" : "masqué"}${body.reason ? ` : ${txt(body.reason, 200)}` : ""}`, (r as any).bookings?.ref ?? r.id);
      return json({ ok: true });
    }

    // ---------------- Réservations, transactions, finances ----------------
    case "bookings": {
      let q = admin.from("bookings").select("id, ref, status, starts_at, hours, category, place, amount_total, amount_commission, amount_client_fee, amount_payout, client_id, companion_id, created_at", { count: "exact" });
      if (body.status) q = q.eq("status", txt(body.status, 30));
      if (body.q) q = q.ilike("ref", `%${txt(body.q, 20).replace(/[%_]/g, "")}%`);
      if (body.from) q = q.gte("starts_at", isoOr(body.from, new Date(0)));
      if (body.to) q = q.lt("starts_at", isoOr(body.to, new Date(8.64e15)));
      const { data, count, error } = await q.order("starts_at", { ascending: false }).range(page(body) * PAGE, page(body) * PAGE + PAGE - 1);
      if (error) throw error;
      const nm = await names((data ?? []).flatMap((b: any) => [b.client_id, b.companion_id]));
      return json({ bookings: (data ?? []).map((b: any) => ({ ...b, client: nm[b.client_id] ?? "", companion: nm[b.companion_id] ?? "" })), total: count ?? 0, page: page(body), size: PAGE });
    }
    case "booking_detail": {
      const { data: b } = await admin.from("bookings").select("*").eq("id", txt(body.booking_id, 40)).maybeSingle();
      if (!b) throw new HttpError(404, "Réservation introuvable");
      const [{ data: ev }, { data: led }, { data: disp }, { data: inv }] = await Promise.all([
        admin.from("booking_events").select("status, note, actor, created_at").eq("booking_id", b.id).order("created_at"),
        admin.from("ledger").select("kind, amount, stripe_object_id, created_at").eq("booking_id", b.id).order("created_at"),
        admin.from("disputes").select("id, reason, status, decision, created_at").eq("booking_id", b.id),
        admin.from("invoices").select("number, kind, total, created_at").eq("booking_id", b.id),
      ]);
      const nm = await names([b.client_id, b.companion_id, ...(ev ?? []).map((e: any) => e.actor)]);
      const { meeting_code_hash: _h, stripe_payment_intent_id: pi, ...safe } = b;
      await audit(me.id, "Consultation d'une réservation", b.ref);
      return json({ booking: { ...safe, has_payment: !!pi, client: nm[b.client_id], companion: nm[b.companion_id] }, events: (ev ?? []).map((e: any) => ({ ...e, actor_name: nm[e.actor] ?? "Système" })), ledger: led ?? [], disputes: disp ?? [], invoices: inv ?? [] });
    }
    case "transactions": {
      let q = admin.from("ledger").select("id, kind, amount, stripe_object_id, created_at, booking_id, bookings(ref)", { count: "exact" });
      if (body.kind) q = q.ilike("kind", `${txt(body.kind, 30).replace(/[%_]/g, "")}%`);
      if (body.from) q = q.gte("created_at", isoOr(body.from, new Date(0)));
      if (body.to) q = q.lt("created_at", isoOr(body.to, new Date(8.64e15)));
      const { data, count, error } = await q.order("created_at", { ascending: false }).range(page(body) * PAGE, page(body) * PAGE + PAGE - 1);
      if (error) throw error;
      return json({ transactions: data ?? [], total: count ?? 0, page: page(body), size: PAGE });
    }
    case "finance": {
      const from = isoOr(body.from, new Date("2020-01-01")), to = isoOr(body.to, new Date(Date.now() + 86_400_000));
      const { data, error } = await admin.rpc("adm_finance", { p_from: from, p_to: to });
      if (error) throw error;
      const { data: s } = await admin.from("settings").select("client_fee_pct, companion_fee_pct, privilege_fee_pct, vat_pct").single();
      return json({ finance: data, rules: s, from, to });
    }

    // ---------------- Litiges et remboursements ----------------
    case "disputes": {
      const st = body.status === "decide" ? "decide" : "ouvert";
      const { data } = await admin.from("disputes").select("*, bookings(ref, status, amount_total, amount_payout)").eq("status", st).order(st === "ouvert" ? "deadline" : "created_at", { ascending: st === "ouvert" }).limit(PAGE);
      return json({ disputes: data ?? [] });
    }
    case "dispute_decide": {
      requireStepUp(me);
      // decision : "payout" (versement à l'accompagnateur) ou "refund" (remboursement du client, refund_pct %)
      const note = txt(body.note, 1000);
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

    // ---------------- Assistance ----------------
    case "support_list": {
      const st = ["ouverte", "en_cours", "repondue", "resolue", "fermee"].includes(body.status) ? body.status : "";
      let q = admin.from("support_tickets").select("id, ref, user_id, category, subject, status, priority, created_at, last_message_at, booking_id, bookings(ref)", { count: "exact" });
      if (st) q = q.eq("status", st); else q = q.in("status", ["ouverte", "en_cours"]);
      if (body.q) q = q.or(`ref.ilike.%${txt(body.q, 20).replace(/[%_,()]/g, "")}%,subject.ilike.%${txt(body.q, 40).replace(/[%_,()]/g, "")}%`);
      const { data, count, error } = await q.order("priority", { ascending: true }).order("last_message_at", { ascending: false }).range(page(body) * PAGE, page(body) * PAGE + PAGE - 1);
      if (error) throw error;
      const nm = await names((data ?? []).map((t: any) => t.user_id));
      return json({ tickets: (data ?? []).map((t: any) => ({ ...t, user: nm[t.user_id] ?? "" })), total: count ?? 0, page: page(body), size: PAGE });
    }
    case "support_detail": {
      const { data: t } = await admin.from("support_tickets").select("*, bookings(ref)").eq("id", txt(body.ticket_id, 40)).maybeSingle();
      if (!t) throw new HttpError(404, "Demande introuvable");
      const { data: m } = await admin.from("support_messages").select("id, author_id, from_staff, body, created_at").eq("ticket_id", t.id).order("created_at");
      const nm = await names([t.user_id, ...(m ?? []).map((x: any) => x.author_id)]);
      const { data: email } = await admin.rpc("adm_email", { p_user: t.user_id });
      const { data: p } = await admin.from("profiles").select("role, phone, city").eq("id", t.user_id).maybeSingle();
      return json({ ticket: { ...t, user: nm[t.user_id], email, role: p?.role, phone: p?.phone, city: p?.city }, messages: (m ?? []).map((x: any) => ({ ...x, author: x.from_staff ? "Assistance Side by Side" : nm[x.author_id] ?? "" })) });
    }
    case "support_reply": {
      const msg = txt(body.body, 3000);
      if (msg.length < 2) throw new HttpError(400, "Message vide");
      const { data: t } = await admin.from("support_tickets").select("id, ref, user_id, status, booking_id").eq("id", txt(body.ticket_id, 40)).maybeSingle();
      if (!t) throw new HttpError(404, "Demande introuvable");
      if (t.status === "fermee") throw new HttpError(409, "Demande fermée");
      await admin.from("support_messages").insert({ ticket_id: t.id, author_id: me.id, from_staff: true, body: msg });
      const status = ["en_cours", "resolue", "fermee"].includes(body.status) ? body.status : "repondue";
      await admin.from("support_tickets").update({ status, assigned_to: me.id, updated_at: new Date().toISOString(), last_message_at: new Date().toISOString() }).eq("id", t.id);
      await notify(t.user_id, `Assistance ${t.ref} : ${msg.slice(0, 300)}`, t.booking_id, "assistance");
      await audit(me.id, `Réponse à la demande d'assistance (${status})`, t.ref);
      return json({ ok: true });
    }
    case "support_status": {
      const status = ["ouverte", "en_cours", "repondue", "resolue", "fermee"].includes(body.status) ? body.status : null;
      if (!status) throw new HttpError(400, "Statut inconnu");
      const { data: t } = await admin.from("support_tickets").update({ status, updated_at: new Date().toISOString(), assigned_to: me.id }).eq("id", txt(body.ticket_id, 40)).select("ref, user_id").single();
      if (!t) throw new HttpError(404, "Demande introuvable");
      if (status === "fermee" || status === "resolue") await notify(t.user_id, `Votre demande ${t.ref} est ${status === "fermee" ? "fermée" : "résolue"}.`, null, "assistance");
      await audit(me.id, `Demande d'assistance : statut « ${status} »`, t.ref);
      return json({ ok: true });
    }

    // ---------------- Annonces ----------------
    case "announcements": {
      const { data } = await admin.from("announcements").select("*").order("created_at", { ascending: false }).limit(30);
      return json({ announcements: data ?? [] });
    }
    case "announce": {
      requireStepUp(me);
      const aud = ["all", "client", "companion"].includes(body.audience) ? body.audience : null;
      const msg = txt(body.body, 400);
      if (!aud || msg.length < 5) throw new HttpError(400, "Choisissez le public et rédigez le message (5 caractères minimum)");
      let q = admin.from("profiles").select("id").eq("suspended", false);
      q = aud === "all" ? q.in("role", ["client", "business", "companion"]) : aud === "client" ? q.in("role", ["client", "business"]) : q.eq("role", "companion");
      const { data: ids } = await q;
      const rows = (ids ?? []).map((p: any) => ({ user_id: p.id, body: msg, kind: "annonce" }));
      for (let i = 0; i < rows.length; i += 500) await admin.from("notifications").insert(rows.slice(i, i + 500));
      await admin.from("announcements").insert({ audience: aud, body: msg, created_by: me.id, recipients: rows.length });
      await audit(me.id, `Annonce envoyée (${aud}, ${rows.length} destinataire(s))`, null);
      return json({ ok: true, recipients: rows.length });
    }

    // ---------------- Journal ----------------
    case "audit": {
      let q = admin.from("audit_log").select("id, created_at, action, ref, actor_id", { count: "exact" });
      if (body.q) q = q.ilike("action", `%${txt(body.q, 60).replace(/[%_]/g, "")}%`);
      if (body.ref) q = q.eq("ref", txt(body.ref, 60));
      if (body.from) q = q.gte("created_at", isoOr(body.from, new Date(0)));
      if (body.to) q = q.lt("created_at", isoOr(body.to, new Date(8.64e15)));
      const { data, count } = await q.order("created_at", { ascending: false }).range(page(body) * PAGE, page(body) * PAGE + PAGE - 1);
      const nm = await names((data ?? []).map((l: any) => l.actor_id));
      return json({ logs: (data ?? []).map((l: any) => ({ ...l, actor: nm[l.actor_id] ?? "Système" })), total: count ?? 0, page: page(body), size: PAGE });
    }
    case "auth_events": {
      const { data, count } = await admin.from("admin_auth_events").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(page(body) * PAGE, page(body) * PAGE + PAGE - 1);
      return json({ events: data ?? [], total: count ?? 0, page: page(body), size: PAGE });
    }

    // ---------------- Paramètres (super-administrateur) ----------------
    case "settings_get": {
      const { data } = await admin.from("settings").select("*").single();
      return json({ settings: data, editable: me.level === "super" });
    }
    case "settings_update": {
      requireSuper(me); requireStepUp(me);
      const R: Record<string, [number, number]> = { client_fee_pct: [0, 30], companion_fee_pct: [0, 40], privilege_fee_pct: [0, 30], privilege_price_eur: [0, 100], vat_pct: [0, 30],
        referral_eur: [0, 100], min_hours: [1, 12], max_hours: [1, 24], cancel_early_pct: [0, 100], cancel_mid_pct: [0, 100], cancel_late_pct: [0, 100], noshow_pct: [0, 100], dispute_days: [1, 30] };
      const { data: before } = await admin.from("settings").select("*").single();
      const patch: Record<string, unknown> = {};
      for (const [k, [lo, hi]] of Object.entries(R)) if (body.settings?.[k] !== undefined) {
        const v = Number(body.settings[k]);
        if (!isFinite(v) || v < lo || v > hi) throw new HttpError(400, `Valeur hors limites pour ${k} (${lo} à ${hi})`);
        patch[k] = v;
      }
      if (body.settings?.insurance_required !== undefined && before && "insurance_required" in before) patch.insurance_required = !!body.settings.insurance_required;
      if (Number(patch.min_hours ?? before?.min_hours) > Number(patch.max_hours ?? before?.max_hours)) throw new HttpError(400, "La durée minimale dépasse la durée maximale");
      if (!Object.keys(patch).length) throw new HttpError(400, "Aucune modification");
      const changes = Object.entries(patch).filter(([k, v]) => String((before as any)?.[k]) !== String(v)).map(([k, v]) => `${k} : ${(before as any)?.[k]} → ${v}`);
      await admin.from("settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1);
      await admin.from("audit_log").insert({ actor_id: me.id, action: `Paramètres modifiés : ${changes.join(" ; ") || "aucun changement"}`.slice(0, 500), ref: "settings", details: { before, patch } });
      await notifyAdmins(`Paramètres de la plateforme modifiés par le dirigeant : ${changes.join(" ; ")}`.slice(0, 400), null, "admin");
      return json({ ok: true, changes });
    }

    // ---------------- Administrateurs (super-administrateur) ----------------
    case "admins": {
      const { data } = await admin.rpc("adm_admins");
      return json({ admins: data ?? [], can_manage: me.level === "super" });
    }
    case "admin_create": {
      requireSuper(me); requireStepUp(me);
      const email = txt(body.email, 200).toLowerCase(), first = txt(body.first_name, 60), last = txt(body.last_name, 60);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || first.length < 2 || last.length < 1) throw new HttpError(400, "Indiquez l'e-mail, le prénom et le nom");
      const { data: exists } = await admin.rpc("adm_user_by_email", { p_email: email });
      if (exists) throw new HttpError(409, "Cette adresse est déjà utilisée par un compte : utilisez une adresse dédiée à l'administration");
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*+-=?";
      const rnd = crypto.getRandomValues(new Uint32Array(22));
      const temp = Array.from(rnd, (n) => alphabet[n % alphabet.length]).join("") + "Aa9!";
      const { data: u, error } = await admin.auth.admin.createUser({ email, password: temp, email_confirm: true, user_metadata: { first_name: first, last_name: last, terms: true } });
      if (error || !u?.user) throw new HttpError(400, "Création impossible : " + (error?.message ?? ""));
      await admin.from("profiles").update({ role: "admin", suspended: false }).eq("id", u.user.id);
      await admin.from("admin_accounts").insert({ user_id: u.user.id, level: "admin", must_change_password: true, created_by: me.id });
      await audit(me.id, `Création d'un administrateur : ${email}`, u.user.id);
      await notifyAdmins(`Nouvel administrateur créé : ${first} ${last} (${email}).`, null, "admin");
      // Mot de passe provisoire affiché UNE SEULE FOIS au dirigeant, jamais enregistré dans le journal
      return json({ ok: true, user_id: u.user.id, temporary_password: temp });
    }
    case "admin_revoke": {
      requireSuper(me); requireStepUp(me);
      const uid = txt(body.user_id, 40);
      if (uid === me.id) throw new HttpError(400, "Le dirigeant ne peut pas retirer son propre accès");
      const { data: acc } = await admin.from("admin_accounts").select("level").eq("user_id", uid).is("revoked_at", null).maybeSingle();
      if (!acc) throw new HttpError(404, "Administrateur introuvable");
      await admin.from("admin_accounts").update({ revoked_at: new Date().toISOString() }).eq("user_id", uid);
      await admin.from("profiles").update({ role: "client", suspended: true }).eq("id", uid);
      const { data: sess } = await admin.from("admin_sessions").select("session_id").eq("user_id", uid).is("ended_at", null);
      for (const s of sess ?? []) await endAdminSession(s.session_id, "acces_retire");
      await audit(me.id, "Accès administrateur retiré", uid);
      return json({ ok: true });
    }
    case "admin_reset_totp": {   // téléphone perdu : l'administrateur réassocie une application à sa prochaine connexion
      requireSuper(me); requireStepUp(me);
      const uid = txt(body.user_id, 40);
      if (uid === me.id) throw new HttpError(400, "Pour votre propre compte, suivez la procédure de récupération du dirigeant");
      const { data: acc } = await admin.from("admin_accounts").select("level").eq("user_id", uid).is("revoked_at", null).maybeSingle();
      if (!acc) throw new HttpError(404, "Administrateur introuvable");
      const { data: f } = await admin.auth.admin.mfa.listFactors({ userId: uid });
      for (const x of f?.factors ?? []) await admin.auth.admin.mfa.deleteFactor({ userId: uid, id: x.id });
      const { data: sess } = await admin.from("admin_sessions").select("session_id").eq("user_id", uid).is("ended_at", null);
      for (const s of sess ?? []) await endAdminSession(s.session_id, "totp_reinitialise");
      await admin.from("admin_accounts").update({ must_change_password: true }).eq("user_id", uid);
      await authEvent("totp_reset", { user_id: uid, req });
      await audit(me.id, "Double authentification réinitialisée (nouvelle association et nouveau mot de passe exigés)", uid);
      return json({ ok: true });
    }
    case "admin_unlock": {
      requireSuper(me); requireStepUp(me);
      const email = txt(body.email, 200).toLowerCase();
      await admin.from("admin_lockouts").upsert({ email, fails: 0, locked_until: null, updated_at: new Date().toISOString() });
      await authEvent("unlocked", { email, req });
      await audit(me.id, `Déblocage de l'accès : ${email}`, null);
      return json({ ok: true });
    }
    default: throw new HttpError(400, "Action inconnue");
  }
});
