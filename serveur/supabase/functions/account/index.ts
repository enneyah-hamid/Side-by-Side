// RGPD : export de mes données et suppression de mon compte.
// Les pièces comptables (factures, encaissements) sont conservées 10 ans (obligation légale),
// mais rattachées à un compte anonymisé.
import { admin, json, serve, currentUser, audit, HttpError } from "../_shared/clients.ts";

const ACTIVE = ["en_attente", "acceptee", "paiement_confirme", "confirmee", "controle", "verifie", "en_cours", "fin_declaree", "double_attente", "terminee", "versement", "a_verifier", "incident", "contestee"];

serve(async (req) => {
  const me = await currentUser(req);
  const { action, confirm } = await req.json();
  if (action === "export") {
    const q = (t: string, col: string) => admin.from(t).select("*").eq(col, me.id);
    const [companion, bookingsC, bookingsP, messages, reviews, notifications, identity, invoices, alerts] = await Promise.all([
      admin.from("companions").select("*").eq("id", me.id).maybeSingle(), q("bookings", "client_id"), q("bookings", "companion_id"),
      q("messages", "sender_id"), q("reviews", "author_id"), q("notifications", "user_id"),
      admin.from("identity_checks").select("status, created_at, reviewed_at").eq("user_id", me.id), q("invoices", "recipient_id"), q("safety_alerts", "user_id")]);
    const { aal: _a, ...profile } = me;
    const strip = (rows: any[] | null) => (rows ?? []).map(({ stripe_payment_intent_id: _1, stripe_transfer_id: _2, payment_lock_at: _3, ...r }) => r);
    await audit(me.id, "Export RGPD de ses données");
    return json({ exported_at: new Date().toISOString(), profile, companion: companion.data, bookings: [...strip(bookingsC.data), ...strip(bookingsP.data)],
      messages: messages.data, reviews: reviews.data, notifications: notifications.data, identity_checks: identity.data, invoices: invoices.data, safety_alerts: alerts.data });
  }
  if (action === "delete") {
    if (confirm !== "SUPPRIMER") throw new HttpError(400, "Confirmez en écrivant SUPPRIMER");
    const { count } = await admin.from("bookings").select("id", { count: "exact", head: true }).or(`client_id.eq.${me.id},companion_id.eq.${me.id}`).in("status", ACTIVE);
    if ((count ?? 0) > 0) throw new HttpError(409, "Terminez ou annulez d'abord vos réservations en cours");
    // Documents d'identité et photos supprimés
    for (const bucket of ["documents", "photos"]) {
      const { data: files } = await admin.storage.from(bucket).list(me.id, { limit: 1000 });
      if (files?.length) await admin.storage.from(bucket).remove(files.map((f) => `${me.id}/${f.name}`));
    }
    await Promise.all([
      admin.from("identity_checks").delete().eq("user_id", me.id), admin.from("push_tokens").delete().eq("user_id", me.id),
      admin.from("user_secrets").delete().eq("user_id", me.id), admin.from("notifications").delete().eq("user_id", me.id),
      admin.from("companion_photos").delete().eq("companion_id", me.id),
    ]);
    await admin.from("profiles").update({ first_name: "Compte supprimé", last_name: "-", phone: null, city: null, trusted_contact: null, suspended: true, stripe_customer_id: null }).eq("id", me.id);
    await admin.from("companions").update({ bio: null, area: null, verified: false, tax_id: null, postal_address: null }).eq("id", me.id);
    await admin.auth.admin.updateUserById(me.id, { email: `supprime-${me.id}@invalid.sidebyside`, ban_duration: "876000h", user_metadata: {} });
    await audit(me.id, "Suppression du compte (données personnelles anonymisées)");
    return json({ ok: true });
  }
  throw new HttpError(400, "Action inconnue");
});
