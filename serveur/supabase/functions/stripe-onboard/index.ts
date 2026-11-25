// Inscription d'un accompagnateur sur Stripe Connect (compte Express)
// L'accompagnateur renseigne lui-même son identité et son IBAN chez Stripe.
import { stripe, admin, json, cors, currentUser } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await currentUser(req);
    if (me.role !== "companion") return json({ error: "Réservé aux accompagnateurs" }, 403);
    const { data: c } = await admin.from("companions").select("stripe_account_id").eq("id", me.id).single();
    let accountId = c?.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express", country: "FR", email: (await admin.auth.admin.getUserById(me.id)).data.user?.email,
        business_type: "individual",
        capabilities: { transfers: { requested: true } },
        metadata: { profile_id: me.id },
      });
      accountId = account.id;
      await admin.from("companions").update({ stripe_account_id: accountId }).eq("id", me.id);
    }
    const origin = Deno.env.get("APP_ORIGIN") ?? "https://sidebyside.app";
    const link = await stripe.accountLinks.create({
      account: accountId, type: "account_onboarding",
      refresh_url: `${origin}/compagnon/paiements?retry=1`, return_url: `${origin}/compagnon/paiements?ok=1`,
    });
    return json({ url: link.url });
  } catch (e) { return json({ error: (e as Error).message }, 400); }
});
