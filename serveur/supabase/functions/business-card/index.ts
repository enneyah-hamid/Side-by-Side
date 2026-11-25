// Comptes entreprise : enregistrement de la carte (empreinte bancaire) par SetupIntent.
// La carte est ensuite débitée à chaque réservation, hors session, dans la limite du plafond mensuel.
import { stripe, admin, json, cors, currentUser } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await currentUser(req);
    const { data: biz } = await admin.from("business_accounts").select("*").eq("id", me.id).single();
    if (!biz) return json({ error: "Compte entreprise introuvable" }, 404);
    let customer = me.stripe_customer_id;
    if (!customer) {
      customer = (await stripe.customers.create({ name: biz.company_name, metadata: { profile_id: me.id, siret: biz.siret } })).id;
      await admin.from("profiles").update({ stripe_customer_id: customer }).eq("id", me.id);
    }
    const si = await stripe.setupIntents.create({ customer, usage: "off_session", payment_method_types: ["card"], metadata: { profile_id: me.id } });
    return json({ client_secret: si.client_secret });   // la carte est confirmée dans l'app avec Stripe Elements / PaymentSheet
  } catch (e) { return json({ error: (e as Error).message }, 400); }
});
