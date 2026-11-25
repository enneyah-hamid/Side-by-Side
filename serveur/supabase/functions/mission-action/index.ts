// Déroulement d'une prestation, contrôlé côté serveur :
// présence (1 h avant), code de rencontre (unique, expirant, 5 essais), code de détresse silencieux,
// début et fin validés par les deux parties, interruption pour sécurité, litige, prolongation payée.
import { stripe, stripeReady, admin, json, serve, currentUser, cents, event, notify, notifyAdmins, HttpError, transition, sha256, r2 } from "../_shared/clients.ts";
import { releasePayout } from "../_shared/payout.ts";
import { price } from "../_shared/pricing.ts";

const H = 3_600_000;

serve(async (req) => {
  const me = await currentUser(req);
  const body = await req.json();
  const { booking_id, action } = body;
  const { data: b } = await admin.from("bookings").select("*").eq("id", booking_id).single();
  if (!b || (b.client_id !== me.id && b.companion_id !== me.id)) throw new HttpError(404, "Réservation introuvable");
  const who = b.companion_id === me.id ? "companion" : "client", other = who === "client" ? b.companion_id : b.client_id;
  const start = new Date(b.starts_at).getTime(), end = new Date(b.ends_at).getTime(), t = Date.now(), now = new Date().toISOString();
  const openWindow = async () => {            // la vérification s'ouvre 1 h avant le rendez-vous
    if (b.status === "confirmee" && t >= start - H) { await transition(b.id, ["confirmee"], { status: "controle" }); b.status = "controle"; }
  };

  switch (action) {
    case "get_code": {                                   // le client présente ce code à l'accompagnateur
      if (who !== "client" || !["confirmee", "controle"].includes(b.status)) throw new HttpError(409, "Code indisponible");
      const { data: s } = await admin.from("booking_secrets").select("code, distress, expires_at, used_at, locked").eq("booking_id", b.id).single();
      if (!s || s.used_at || s.locked || new Date(s.expires_at).getTime() < t) throw new HttpError(409, "Code indisponible");
      return json({ code: s.code, distress: s.distress, expires_at: s.expires_at });
    }
    case "presence": {
      await openWindow();
      if (b.status !== "controle") throw new HttpError(409, "La confirmation s'ouvre 1 h avant le rendez-vous");
      const col = who === "client" ? "presence_client" : "presence_companion";
      await admin.from("bookings").update({ [col]: now }).eq("id", b.id).is(col, null);
      await event(b.id, null, me.id, "présence confirmée");
      await notify(other, `${me.first_name} a confirmé sa présence pour ${b.ref}.`, b.id, "rappel");
      return json({ ok: true });
    }
    case "set_pin": {                                    // code de détresse personnel (6 chiffres)
      const pin = String(body.pin ?? "");
      if (!/^\d{6}$/.test(pin)) throw new HttpError(400, "Le code doit comporter 6 chiffres");
      await admin.from("user_secrets").upsert({ user_id: me.id, distress_pin_hash: await sha256(`${me.id}:${pin}`), updated_at: now });
      return json({ ok: true });
    }
    case "verify_code": {                                // saisi par l'accompagnateur au moment de la rencontre
      if (who !== "companion") throw new HttpError(403, "Le code est saisi par l'accompagnateur");
      await openWindow();
      if (b.status !== "controle" || t > end) throw new HttpError(409, "Le code ne peut être saisi qu'au moment du rendez-vous");
      const v = String(body.code ?? "").replace(/\s/g, "");
      const { data: s } = await admin.from("booking_secrets").select("*").eq("booking_id", b.id).single();
      if (!s) throw new HttpError(409, "Aucun code pour cette réservation");
      if (s.locked) throw new HttpError(423, "Code bloqué après trop d'essais. Contactez l'assistance.");
      if (s.used_at) throw new HttpError(409, "Ce code a déjà été utilisé");
      if (new Date(s.expires_at).getTime() < t) throw new HttpError(409, "Ce code a expiré");
      const { data: pinRow } = await admin.from("user_secrets").select("distress_pin_hash").eq("user_id", me.id).maybeSingle();
      const isPin = !!pinRow && /^\d{6}$/.test(v) && pinRow.distress_pin_hash === await sha256(`${me.id}:${v}`);
      const ok = v === s.code || v === s.distress || isPin;
      if (!ok) {
        const attempts = s.attempts + 1, locked = attempts >= 5;
        await admin.from("booking_secrets").update({ attempts, locked }).eq("booking_id", b.id).eq("attempts", s.attempts);
        if (locked) {
          await event(b.id, null, null, "code de rencontre bloqué après 5 essais");
          await notifyAdmins(`Code de rencontre bloqué sur ${b.ref} après 5 essais.`, b.id);
          throw new HttpError(423, "5 essais incorrects : code bloqué, la plateforme est alertée.");
        }
        throw new HttpError(400, `Code incorrect. Il reste ${5 - attempts} essai(s).`);
      }
      // Usage unique : un seul passage « non utilisé → utilisé »
      const { data: used } = await admin.from("booking_secrets").update({ used_at: now }).eq("booking_id", b.id).is("used_at", null).select("booking_id");
      if (!used?.length) throw new HttpError(409, "Ce code a déjà été utilisé");
      if (v === s.distress || isPin) {
        // Alerte silencieuse : tout semble normal pour l'autre personne, l'équipe est prévenue immédiatement
        await admin.from("safety_alerts").insert({ booking_id: b.id, user_id: isPin ? me.id : b.client_id, kind: isPin ? "code de détresse (accompagnateur)" : "code de détresse (client)" });
      }
      await transition(b.id, ["controle"], { status: "verifie" });
      await event(b.id, "verifie", null, "code de rencontre validé");
      await notify(b.client_id, `Rencontre vérifiée pour ${b.ref}.`, b.id, "debut");
      return json({ ok: true });
    }
    case "start": {
      if (b.status !== "verifie") throw new HttpError(409, "Vérifiez d'abord le code de rencontre");
      const patch: Record<string, string> = who === "client" ? { start_client: now } : { start_companion: now };
      if (b.beneficiary_name && who === "companion" && !b.start_client) patch.start_client = now;   // le proche est présent, pas le payeur
      const col = who === "client" ? "start_client" : "start_companion";
      const { data: u } = await admin.from("bookings").update(patch).eq("id", b.id).eq("status", "verifie").is(col, null).select();
      if (!u?.length) throw new HttpError(409, "Vous avez déjà validé le début");
      const x = u[0];
      if (x.start_client && x.start_companion) {
        if (await transition(b.id, ["verifie"], { status: "en_cours" })) {
          await event(b.id, "en_cours", null, `début validé · ${b.place}`);
          await notify(b.client_id, b.beneficiary_name ? `La sortie de ${b.beneficiary_name} a commencé.` : `${b.ref} : mission commencée.`, b.id, "debut");
          await notify(b.companion_id, `${b.ref} : mission commencée.`, b.id, "debut");
        }
        return json({ ok: true, started: true });
      }
      await notify(other, `${me.first_name} a commencé la mission ${b.ref}. Validez de votre côté.`, b.id, "debut");
      return json({ ok: true, started: false });
    }
    case "end": {
      if (!["en_cours", "double_attente"].includes(b.status)) throw new HttpError(409, "Action impossible");
      const col = who === "client" ? "end_client" : "end_companion";
      const { data: u } = await admin.from("bookings").update({ [col]: now }).eq("id", b.id).in("status", ["en_cours", "double_attente"]).is(col, null).select();
      if (!u?.length) throw new HttpError(409, "Vous avez déjà confirmé la fin");
      const x = u[0];
      if (x.end_client && x.end_companion) {
        if (await transition(b.id, ["en_cours", "double_attente"], { status: "terminee" })) {
          await event(b.id, "terminee", null, "double validation obtenue");
          await notify(b.client_id, `${b.ref} terminée. Vous pouvez laisser un avis.`, b.id, "fin");
          await notify(b.companion_id, `${b.ref} terminée. Versement de ${Number(b.amount_payout).toFixed(2)} € en cours.`, b.id, "fin");
          const p = await releasePayout(b.id, null);                  // en cas d'échec : nouvel essai automatique
          return json({ ok: true, finished: true, payout: p.ok });
        }
        return json({ ok: true, finished: true });
      }
      await transition(b.id, ["en_cours"], { status: "double_attente" });
      await event(b.id, "double_attente", me.id, "fin déclarée, en attente de la seconde confirmation");
      await notify(other, `${me.first_name} a déclaré la fin de ${b.ref}. Confirmez de votre côté.`, b.id, "fin");
      return json({ ok: true, finished: false });
    }
    case "interrupt": {                                  // bouton SOS : « J'interromps la mission »
      const x = await transition(b.id, ["confirmee", "controle", "verifie", "en_cours", "double_attente", "fin_declaree"], { status: "incident" });
      if (!x) throw new HttpError(409, "Action impossible");
      await admin.from("disputes").insert({ booking_id: b.id, opened_by: me.id, reason: "Incident de sécurité", description: "Prestation interrompue via le bouton SOS pour raison de sécurité.", deadline: new Date(t + 2 * 86_400_000).toISOString() });
      await admin.from("safety_alerts").insert({ booking_id: b.id, user_id: me.id, kind: "interruption de mission" });
      await event(b.id, "incident", me.id, "mission interrompue pour raison de sécurité");
      await notify(other, `${b.ref} a été interrompue. L'équipe Side by Side vous contacte.`, b.id, "incident");
      return json({ ok: true });
    }
    case "dispute": {
      const reason = String(body.reason ?? "").trim().slice(0, 80), desc = String(body.description ?? "").trim().slice(0, 2000);
      if (reason.length < 3 || desc.length < 10) throw new HttpError(400, "Décrivez le problème (10 caractères minimum)");
      if (!["controle", "verifie", "en_cours", "fin_declaree", "double_attente", "terminee", "versement", "cloturee", "a_verifier", "incident", "absence"].includes(b.status)) throw new HttpError(409, "Litige impossible à ce stade");
      const { data: s } = await admin.from("settings").select("dispute_days").single();
      const { data: d } = await admin.from("disputes").insert({ booking_id: b.id, opened_by: me.id, reason, description: desc, deadline: new Date(t + (s?.dispute_days ?? 3) * 86_400_000).toISOString() }).select().single();
      await transition(b.id, ["en_cours", "fin_declaree", "double_attente", "terminee", "a_verifier"], { status: "contestee" });   // versement gelé
      await event(b.id, "contestee", me.id, `litige : ${reason}`);
      await notify(other, `Un dossier a été ouvert sur ${b.ref}.`, b.id, "litige");
      await notifyAdmins(`Nouveau litige sur ${b.ref} : ${reason}.`, b.id);
      return json({ ok: true, dispute_id: d?.id });
    }
    case "ext_request": {                                // seul le client payeur demande une prolongation
      if (who !== "client" || b.status !== "en_cours") throw new HttpError(409, "Prolongation possible seulement pendant la prestation");
      const minutes = Number(body.minutes);
      if (![30, 60, 120].includes(minutes)) throw new HttpError(400, "Durée de prolongation invalide");
      const { data: s } = await admin.from("settings").select("*").single();
      const rate = Number(b.amount_service) / (b.hours + b.extra_minutes / 60);
      const p = price(r2(rate), minutes / 60, 0, s, !!me.privilege_since);
      const { error } = await admin.from("booking_extensions").insert({ booking_id: b.id, minutes, amount_service: p.amount_service, amount_client_fee: p.amount_client_fee, amount_vat: p.amount_vat, amount_total: p.amount_total, amount_commission: p.amount_commission, amount_payout: p.amount_payout });
      if (error) throw new HttpError(409, "Une demande est déjà en cours");
      await notify(b.companion_id, `${me.first_name} demande ${minutes} min de plus pour ${b.ref}.`, b.id, "prolongation");
      return json({ ok: true, amount: p.amount_total });
    }
    case "ext_respond": {
      if (who !== "companion") throw new HttpError(403, "Réservé à l'accompagnateur");
      const { data: x } = await admin.from("booking_extensions").update({ status: body.accept ? "accepted" : "refused" }).eq("booking_id", b.id).eq("status", "pending").select();
      if (!x?.length) throw new HttpError(409, "Aucune demande");
      await notify(b.client_id, body.accept ? `Prolongation acceptée : réglez ${Number(x[0].amount_total).toFixed(2)} € pour l'activer.` : "Prolongation refusée. L'heure de fin reste inchangée.", b.id, "prolongation");
      return json({ ok: true });
    }
    case "ext_pay": {
      if (who !== "client") throw new HttpError(403, "Réservé au client");
      const { data: e } = await admin.from("booking_extensions").select("*").eq("booking_id", b.id).eq("status", "accepted").maybeSingle();
      if (!e) throw new HttpError(409, "Rien à payer");
      if (!stripeReady()) throw new HttpError(503, "Le paiement en ligne sera disponible très bientôt.");
      const pi = await stripe.paymentIntents.create({
        amount: cents(e.amount_total), currency: "eur", customer: me.stripe_customer_id ?? undefined, transfer_group: b.ref,
        automatic_payment_methods: { enabled: true }, metadata: { booking_id: b.id, kind: "extension", extension_id: e.id },
        description: `Side by Side · prolongation ${b.ref}`,
      }, { idempotencyKey: `ext-${e.id}` });
      await admin.from("booking_extensions").update({ stripe_payment_intent_id: pi.id }).eq("id", e.id);
      return json({ client_secret: pi.client_secret, amount: Number(e.amount_total) });
    }
    default: throw new HttpError(400, "Action inconnue");
  }
});
