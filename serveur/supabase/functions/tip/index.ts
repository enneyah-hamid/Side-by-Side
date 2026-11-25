// Pourboire : 100 % reversé à l'accompagnateur (aucune commission)
import { stripe, admin, json, cors, currentUser, cents } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await currentUser(req);
    const { booking_id, amount } = await req.json();
    const a = Number(amount);
    if (!(a >= 1 && a <= 500)) return json({ error: "Montant entre 1 et 500 €" }, 400);
    const { data: b } = await admin.from("bookings").select("*, companions(stripe_account_id)").eq("id", booking_id).single();
    if (!b || b.client_id !== me.id) return json({ error: "Introuvable" }, 404);
    if (!["terminee", "versement", "cloturee"].includes(b.status) || Number(b.tip) > 0) return json({ error: "Pourboire impossible" }, 409);
    if (!me.stripe_customer_id) return json({ error: "Aucun moyen de paiement enregistré" }, 409);
    const pi = await stripe.paymentIntents.create({
      amount: cents(a), currency: "eur", customer: me.stripe_customer_id,
      automatic_payment_methods: { enabled: true },
      transfer_data: { destination: b.companions.stripe_account_id },   // 100 % à l'accompagnateur
      metadata: { booking_id: b.id, kind: "tip" }, description: `Pourboire · ${b.ref}`,
    });
    return json({ client_secret: pi.client_secret });
  } catch (e) { return json({ error: (e as Error).message }, 400); }
});
