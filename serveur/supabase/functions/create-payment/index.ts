// Paiement d'une réservation acceptée — un seul paiement possible par réservation.
// Modèle « charges et virements séparés » : le client paie Side by Side (Zyntell),
// l'argent reste sur le compte de la plateforme jusqu'à la double validation de fin.
import { stripe, stripeReady, admin, json, serve, currentUser, cents, rateLimit, HttpError, PAID } from "../_shared/clients.ts";
import { finalize } from "../_shared/finalize.ts";

const REUSABLE = ["requires_payment_method", "requires_confirmation", "requires_action"];

serve(async (req) => {
  const me = await currentUser(req);
  const { booking_id, gift_code } = await req.json();
  const { data: b0 } = await admin.from("bookings").select("*").eq("id", booking_id).single();
  if (!b0 || b0.client_id !== me.id) throw new HttpError(404, "Réservation introuvable");
  if (PAID.includes(b0.status)) return json({ paid: true });
  if (b0.status !== "acceptee") throw new HttpError(409, "Paiement impossible à ce stade");
  if (!b0.mission_signed_client) throw new HttpError(409, "Signez d'abord la fiche de mission");
  if (new Date(b0.starts_at).getTime() < Date.now() + 2 * 3_600_000) throw new HttpError(409, "Délai de paiement dépassé");

  // Un paiement déjà ouvert pour cette réservation est réutilisé (double clic, réseau coupé, retour arrière)
  if (b0.stripe_payment_intent_id) {
    const pi = await stripe.paymentIntents.retrieve(b0.stripe_payment_intent_id);
    if (pi.status === "succeeded" || pi.status === "processing") return json({ paid: pi.status === "succeeded", status: pi.status });
    if (REUSABLE.includes(pi.status)) return json({ client_secret: pi.client_secret, status: pi.status, amount: pi.amount / 100 });
  }
  // Verrou : un seul appel à la fois peut créer le paiement
  const lockAt = new Date().toISOString();
  const { data: locked } = await admin.from("bookings").update({ payment_lock_at: lockAt }).eq("id", b0.id).eq("status", "acceptee")
    .or(`payment_lock_at.is.null,payment_lock_at.lt.${new Date(Date.now() - 60_000).toISOString()}`).select();
  if (!locked?.length) throw new HttpError(409, "Paiement déjà en cours. Patientez quelques secondes.");
  const b = locked[0];
  const unlock = () => admin.from("bookings").update({ payment_lock_at: null }).eq("id", b.id).eq("payment_lock_at", lockAt);
  let heldNow = false;
  try {
    // Carte cadeau : le solde est réservé atomiquement (impossible de le dépenser deux fois)
    let giftUsed = 0;
    if (gift_code) {
      await rateLimit(me.id, "gift", 10, 60);
      const { data, error } = await admin.rpc("hold_gift", { p_booking: b.id, p_code: String(gift_code).trim().toUpperCase().slice(0, 40), p_user: me.id, p_max: b.amount_total });
      if (error) throw new HttpError(400, /Carte cadeau déjà/.test(error.message) ? "Carte cadeau déjà utilisée pour cette réservation" : "Code de carte cadeau invalide");
      giftUsed = Number(data); heldNow = true;
    } else {
      const { data: h } = await admin.from("gift_holds").select("amount").eq("booking_id", b.id).eq("status", "held").maybeSingle();
      giftUsed = Number(h?.amount ?? 0);
    }
    await admin.from("bookings").update({ gift_used: giftUsed }).eq("id", b.id);
    const toPay = Math.round((Number(b.amount_total) - giftUsed) * 100) / 100;
    if (toPay <= 0) {
      await finalize(b.id, null); heldNow = false;
      return json({ paid: true });
    }
    if (!stripeReady()) throw new HttpError(503, "Le paiement en ligne sera disponible très bientôt.");

    // Client Stripe
    let customer = me.stripe_customer_id;
    if (!customer) {
      customer = (await stripe.customers.create({ metadata: { profile_id: me.id }, name: `${me.first_name} ${me.last_name}` }, { idempotencyKey: `cus-${me.id}` })).id;
      await admin.from("profiles").update({ stripe_customer_id: customer }).eq("id", me.id);
    }
    // Compte entreprise : paiement sur la carte enregistrée, dans la limite du plafond mensuel (réservations payées uniquement)
    const { data: biz } = await admin.from("business_accounts").select("*").eq("id", me.id).maybeSingle();
    if (biz?.active) {
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const { data: month } = await admin.from("bookings").select("amount_total").eq("business_id", me.id).gte("starts_at", monthStart.toISOString()).in("status", PAID);
      const used = (month ?? []).reduce((a, x) => a + Number(x.amount_total), 0);
      if (used + Number(b.amount_total) > Number(biz.monthly_limit_eur)) throw new HttpError(409, "Plafond mensuel atteint");
    }
    const pi = await stripe.paymentIntents.create({
      amount: cents(toPay), currency: "eur", customer, transfer_group: b.ref,
      metadata: { booking_id: b.id, ref: b.ref, kind: "booking", gift_used: String(giftUsed) },
      description: `Side by Side · réservation ${b.ref}`,
      ...(biz?.active ? { payment_method: biz.stripe_payment_method_id, off_session: true, confirm: true } : { automatic_payment_methods: { enabled: true } }),
    }, { idempotencyKey: `pi-${b.id}-${lockAt}` });
    await admin.from("bookings").update({ stripe_payment_intent_id: pi.id, business_id: biz?.active ? me.id : null, payment_lock_at: null }).eq("id", b.id);
    // La confirmation définitive arrive uniquement par le webhook signé de Stripe
    heldNow = false;
    return json({ client_secret: pi.client_secret, status: pi.status, amount: toPay });
  } catch (e) {
    if (heldNow) { await admin.rpc("release_gift", { p_booking: b.id }); await admin.from("bookings").update({ gift_used: 0 }).eq("id", b.id); }
    throw e;
  } finally { await unlock(); }
});
