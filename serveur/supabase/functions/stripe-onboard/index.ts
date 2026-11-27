// Inscription d'un accompagnateur sur Stripe Connect (compte Express)
// L'accompagnateur renseigne lui-même son identité et son IBAN chez Stripe.
import { stripe, stripeReady, admin, json, serve, currentUser, HttpError } from "../_shared/clients.ts";

serve(async (req) => {
  {
    if (!stripeReady()) throw new HttpError(503, "Le paiement en ligne sera disponible très bientôt.");
    const me = await currentUser(req);
    if (me.role !== "companion") throw new HttpError(403, "Réservé aux accompagnateurs");
    const { data: c } = await admin.from("companions").select("stripe_account_id").eq("id", me.id).single();
    let accountId = c?.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express", country: "FR", email: (await admin.auth.admin.getUserById(me.id)).data.user?.email,
        business_type: "individual",
        capabilities: { transfers: { requested: true } },
        metadata: { profile_id: me.id },
      }, { idempotencyKey: `acct-${me.id}` });
      accountId = account.id;
      await admin.from("companions").update({ stripe_account_id: accountId }).eq("id", me.id);
    }
    const origin = (Deno.env.get("APP_ORIGIN") ?? "").split(",").map((s) => s.trim()).filter(Boolean)[0] ?? "https://sidebyside.app";   // première adresse si plusieurs
    const link = await stripe.accountLinks.create({
      account: accountId, type: "account_onboarding",
      refresh_url: `${origin}/compagnon/paiements?retry=1`, return_url: `${origin}/compagnon/paiements?ok=1`,
    });
    return json({ url: link.url });
  }
});
