// Comptes entreprise : enregistrement de la carte (empreinte bancaire) par SetupIntent.
// La carte est ensuite débitée à chaque réservation, hors session, dans la limite du plafond mensuel.
import { stripe, stripeReady, admin, json, serve, currentUser, HttpError } from "../_shared/clients.ts";

serve(async (req) => {
  {
    if (!stripeReady()) throw new HttpError(503, "Le paiement en ligne sera disponible très bientôt.");
    const me = await currentUser(req);
    const { data: biz } = await admin.from("business_accounts").select("*").eq("id", me.id).single();
    if (!biz) throw new HttpError(404, "Compte entreprise introuvable");
    let customer = me.stripe_customer_id;
    if (!customer) {
      customer = (await stripe.customers.create({ name: biz.company_name, metadata: { profile_id: me.id, siret: biz.siret } }, { idempotencyKey: `cus-${me.id}` })).id;
      await admin.from("profiles").update({ stripe_customer_id: customer }).eq("id", me.id);
    }
    const si = await stripe.setupIntents.create({ customer, usage: "off_session", payment_method_types: ["card"], metadata: { profile_id: me.id } }, { idempotencyKey: `si-${me.id}-${new Date().toISOString().slice(0, 13)}` });
    return json({ client_secret: si.client_secret });   // la carte est confirmée dans l'app avec Stripe Elements / PaymentSheet
  }
});
