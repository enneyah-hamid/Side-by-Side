// Annulation avec remboursement selon les règles affichées (48 h / 24 h, Privilège 24 h).
// Atomique : une réservation n'est annulée, et remboursée, qu'une seule fois.
import { stripe, admin, json, serve, currentUser, cents, event, notify, HttpError, transition, adminOrNull, requireStepUp, audit } from "../_shared/clients.ts";

serve(async (req) => {
  const me = await currentUser(req);
  const { booking_id } = await req.json();
  const { data: b } = await admin.from("bookings").select("*").eq("id", booking_id).single();
  // Équipe : uniquement depuis l'espace de gestion (session active) et après une nouvelle saisie du code TOTP
  const adm = me.role === "admin" ? await adminOrNull(req) : null;
  if (adm) requireStepUp(adm);
  const isAdmin = !!adm;
  if (!b || (b.client_id !== me.id && b.companion_id !== me.id && !isAdmin)) throw new HttpError(404, "Introuvable");
  if (!["en_attente", "acceptee", "confirmee", "controle"].includes(b.status)) throw new HttpError(409, "Annulation impossible à ce stade");

  const { data: s } = await admin.from("settings").select("*").single();
  const hours = (new Date(b.starts_at).getTime() - Date.now()) / 3_600_000;
  const byClient = me.id === b.client_id;
  const { data: cl } = await admin.from("profiles").select("privilege_since").eq("id", b.client_id).single();
  const privilege = !!cl?.privilege_since;
  let pct = 100;                                         // annulation par l'accompagnateur ou l'équipe : 100 %
  if (byClient) pct = hours >= 48 || (privilege && hours >= 24) ? s.cancel_early_pct : hours >= 24 ? s.cancel_mid_pct : s.cancel_late_pct;

  // 1. Passage à « annulée » : un seul appel réussit, les suivants s'arrêtent ici
  const done = await transition(b.id, [b.status], { status: "annulee", payment_lock_at: null });
  if (!done) throw new HttpError(409, "Réservation déjà modifiée");
  await admin.from("booking_secrets").delete().eq("booking_id", b.id);

  let refund = 0, giftBack = 0;
  if (b.status === "confirmee" || b.status === "controle") {
    if (b.stripe_payment_intent_id) {
      refund = Math.round((Number(b.amount_total) - Number(b.gift_used)) * pct) / 100;
      if (refund > 0) {
        const r = await stripe.refunds.create({ payment_intent: b.stripe_payment_intent_id, amount: cents(refund) }, { idempotencyKey: `refund-${b.id}` });
        const { error } = await admin.from("ledger").insert({ booking_id: b.id, kind: "Remboursement", amount: -refund, stripe_object_id: r.id });
        if (error && error.code !== "23505") throw error;
      }
    }
    const { data } = await admin.rpc("refund_gift", { p_booking: b.id, p_pct: pct });
    giftBack = Number(data ?? 0);
  } else {
    // Pas encore payé : le paiement ouvert est annulé et la carte cadeau libérée.
    // S'il aboutissait malgré tout, le webhook le rembourserait automatiquement.
    if (b.stripe_payment_intent_id) { try { await stripe.paymentIntents.cancel(b.stripe_payment_intent_id); } catch (_) { /* déjà payé ou déjà annulé */ } }
    await admin.rpc("release_gift", { p_booking: b.id });
  }
  await event(b.id, "annulee", me.id, `remboursement ${pct} %${giftBack ? ` · ${giftBack} € rendus sur la carte cadeau` : ""}`);
  const other = me.id === b.client_id ? b.companion_id : b.client_id;
  await notify(other, `${b.ref} a été annulée.`, b.id, "annulation");
  if (isAdmin) {
    await notify(b.client_id, `${b.ref} a été annulée par l'équipe Side by Side.`, b.id, "annulation");
    await notify(b.companion_id, `${b.ref} a été annulée par l'équipe Side by Side.`, b.id, "annulation");
    await audit(me.id, `Annulation par l'équipe (${pct} % remboursé${refund ? ` : ${refund} €` : ""})`, b.ref);
  }
  return json({ ok: true, refund, gift_back: giftBack, pct });
});
