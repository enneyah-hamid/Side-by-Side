// Versement à l'accompagnateur après la double validation « Je termine la mission ».
// Appelée par la base (déclencheur) ou par l'admin, jamais par le client.
import { stripe, admin, json, cors, cents, event } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!Deno.env.get("INTERNAL_KEY") || req.headers.get("x-internal-key") !== Deno.env.get("INTERNAL_KEY")) return json({ error: "Interdit" }, 403);
  try {
    const { booking_id } = await req.json();
    const { data: b } = await admin.from("bookings").select("*, companions(stripe_account_id, payouts_enabled)").eq("id", booking_id).single();
    if (!b) return json({ error: "Réservation introuvable" }, 404);
    if (!b.end_client || !b.end_companion) return json({ error: "Double validation de fin manquante" }, 409);
    if (b.stripe_transfer_id) return json({ ok: true, already: true });
    if (!b.companions?.payouts_enabled) return json({ error: "Compte de versement de l'accompagnateur incomplet" }, 409);

    const pi = b.stripe_payment_intent_id ? await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id) : null;
    const transfer = await stripe.transfers.create({
      amount: cents(Number(b.amount_payout)), currency: "eur",
      destination: b.companions.stripe_account_id, transfer_group: b.ref,
      ...(pi?.latest_charge ? { source_transaction: String(pi.latest_charge) } : {}),
      metadata: { booking_id: b.id, ref: b.ref },
    });
    await admin.from("bookings").update({ stripe_transfer_id: transfer.id, status: "cloturee" }).eq("id", b.id);
    await admin.from("ledger").insert({ booking_id: b.id, kind: "Versement", amount: b.amount_payout, stripe_object_id: transfer.id });
    await event(b.id, "cloturee", null, "versement exécuté");
    return json({ ok: true, transfer: transfer.id });
  } catch (e) { return json({ error: (e as Error).message }, 400); }
});
