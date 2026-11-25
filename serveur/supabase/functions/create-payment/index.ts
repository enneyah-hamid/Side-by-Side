// Paiement d'une réservation acceptée.
// Modèle « charges et virements séparés » : le client paie Side by Side (Zyntell),
// l'argent reste sur le compte de la plateforme jusqu'à la double validation de fin,
// puis release-payout vire la part de l'accompagnateur.
import { stripe, admin, json, cors, currentUser, cents } from "../_shared/clients.ts";
import { finalize } from "../_shared/finalize.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await currentUser(req);
    const { booking_id, gift_code } = await req.json();
    const { data: b } = await admin.from("bookings").select("*").eq("id", booking_id).single();
    if (!b || b.client_id !== me.id) return json({ error: "Réservation introuvable" }, 404);
    if (b.status !== "acceptee") return json({ error: "Paiement impossible à ce stade" }, 409);
    if (!b.mission_signed_client) return json({ error: "Signez d'abord la fiche de mission" }, 409);

    // Carte cadeau ou crédit de parrainage
    let giftUsed = 0;
    if (gift_code) {
      const { data: g } = await admin.from("gift_cards").select("*").eq("code", String(gift_code).toUpperCase()).single();
      if (!g || g.balance <= 0 || new Date(g.expires_at) < new Date() || (g.owner_id && g.owner_id !== me.id))
        return json({ error: "Code de carte cadeau invalide" }, 400);
      giftUsed = Math.min(g.balance, b.amount_total);
    }
    const toPay = Math.round((b.amount_total - giftUsed) * 100) / 100;

    // Client Stripe
    let customer = me.stripe_customer_id;
    if (!customer) {
      customer = (await stripe.customers.create({ metadata: { profile_id: me.id }, name: `${me.first_name} ${me.last_name}` })).id;
      await admin.from("profiles").update({ stripe_customer_id: customer }).eq("id", me.id);
    }

    // Compte entreprise : paiement hors session sur la carte enregistrée (empreinte bancaire)
    const { data: biz } = await admin.from("business_accounts").select("*").eq("id", me.id).maybeSingle();
    if (biz?.active) {
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const { data: month } = await admin.from("bookings").select("amount_total")
        .eq("business_id", me.id).gte("starts_at", monthStart.toISOString()).neq("status", "annulee");
      const used = (month ?? []).reduce((a, x) => a + Number(x.amount_total), 0);
      if (used + b.amount_total > biz.monthly_limit_eur) return json({ error: "Plafond mensuel atteint" }, 409);
    }

    if (toPay <= 0) {
      await finalize(b, giftUsed, gift_code, null);
      return json({ paid: true });
    }

    const pi = await stripe.paymentIntents.create({
      amount: cents(toPay), currency: "eur", customer,
      transfer_group: b.ref,
      metadata: { booking_id: b.id, ref: b.ref, gift_code: gift_code ?? "", gift_used: String(giftUsed) },
      description: `Side by Side · réservation ${b.ref}`,
      ...(biz?.active
        ? { payment_method: biz.stripe_payment_method_id, off_session: true, confirm: true }
        : { automatic_payment_methods: { enabled: true } }),
    });
    await admin.from("bookings").update({ stripe_payment_intent_id: pi.id, business_id: biz?.active ? me.id : null }).eq("id", b.id);
    // La confirmation définitive arrive par le webhook (payment_intent.succeeded)
    return json({ client_secret: pi.client_secret, status: pi.status });
  } catch (e) { return json({ error: (e as Error).message }, 400); }
});

