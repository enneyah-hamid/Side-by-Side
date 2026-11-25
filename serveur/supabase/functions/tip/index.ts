// Pourboire : 100 % reversé à l'accompagnateur (aucune commission), un seul par réservation
import { stripe, stripeReady, admin, json, serve, currentUser, cents, HttpError } from "../_shared/clients.ts";

serve(async (req) => {
  const me = await currentUser(req);
  const { booking_id, amount } = await req.json();
  const a = Math.round(Number(amount) * 100) / 100;
  if (!(a >= 1 && a <= 500)) throw new HttpError(400, "Montant entre 1 et 500 €");
  const { data: b } = await admin.from("bookings").select("*, companions(stripe_account_id, payouts_enabled)").eq("id", booking_id).single();
  if (!b || b.client_id !== me.id) throw new HttpError(404, "Introuvable");
  if (!["terminee", "versement", "cloturee"].includes(b.status) || Number(b.tip) > 0) throw new HttpError(409, "Pourboire impossible");
  if (!b.companions?.stripe_account_id || !b.companions.payouts_enabled) throw new HttpError(409, "L'accompagnateur ne peut pas encore recevoir de pourboire");
  if (!stripeReady()) throw new HttpError(503, "Le paiement en ligne sera disponible très bientôt.");
  if (!me.stripe_customer_id) throw new HttpError(409, "Aucun moyen de paiement enregistré");
  const pi = await stripe.paymentIntents.create({
    amount: cents(a), currency: "eur", customer: me.stripe_customer_id, automatic_payment_methods: { enabled: true },
    transfer_data: { destination: b.companions.stripe_account_id },
    metadata: { booking_id: b.id, kind: "tip" }, description: `Pourboire · ${b.ref}`,
  }, { idempotencyKey: `tip-${b.id}-${cents(a)}` });             // double clic : même paiement
  return json({ client_secret: pi.client_secret });
});
