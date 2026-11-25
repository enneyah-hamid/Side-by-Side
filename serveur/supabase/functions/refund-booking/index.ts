// Annulation avec remboursement selon les règles affichées (48 h / 24 h, Privilège 24 h)
import { stripe, admin, json, cors, currentUser, cents, event } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await currentUser(req);
    const { booking_id } = await req.json();
    const { data: b } = await admin.from("bookings").select("*").eq("id", booking_id).single();
    if (!b || (b.client_id !== me.id && b.companion_id !== me.id && me.role !== "admin")) return json({ error: "Introuvable" }, 404);
    if (!["en_attente", "acceptee", "confirmee"].includes(b.status)) return json({ error: "Annulation impossible à ce stade" }, 409);

    const { data: s } = await admin.from("settings").select("*").single();
    const hours = (new Date(b.starts_at).getTime() - Date.now()) / 3_600_000;
    const byCompanion = me.id === b.companion_id;
    const privilege = !byCompanion && !!me.privilege_since;
    let pct = 100;
    if (!byCompanion) pct = hours >= 48 || (privilege && hours >= 24) ? s.cancel_early_pct : hours >= 24 ? s.cancel_mid_pct : s.cancel_late_pct;

    let refund = 0;
    if (b.stripe_payment_intent_id && b.status === "confirmee") {
      refund = Math.round((Number(b.amount_total) - Number(b.gift_used)) * pct) / 100;
      if (refund > 0) {
        const r = await stripe.refunds.create({ payment_intent: b.stripe_payment_intent_id, amount: cents(refund) });
        await admin.from("ledger").insert({ booking_id: b.id, kind: "Remboursement", amount: -refund, stripe_object_id: r.id });
      }
    }
    await admin.from("bookings").update({ status: "annulee" }).eq("id", b.id);
    await event(b.id, "annulee", me.id, `remboursement ${pct} %`);
    return json({ ok: true, refund, pct });
  } catch (e) { return json({ error: (e as Error).message }, 400); }
});
