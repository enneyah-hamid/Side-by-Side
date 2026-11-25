// Facture mensuelle des comptes entreprise (à planifier le 1er de chaque mois)
import { admin, json } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  if (!Deno.env.get("INTERNAL_KEY") || req.headers.get("x-internal-key") !== Deno.env.get("INTERNAL_KEY")) return json({ error: "Interdit" }, 403);
  const end = new Date(); end.setDate(1); end.setHours(0, 0, 0, 0);
  const start = new Date(end); start.setMonth(start.getMonth() - 1);
  const { data: rows } = await admin.from("bookings").select("business_id, amount_total")
    .not("business_id", "is", null).gte("starts_at", start.toISOString()).lt("starts_at", end.toISOString()).neq("status", "annulee");
  const totals = new Map<string, number>();
  for (const r of rows ?? []) totals.set(r.business_id, (totals.get(r.business_id) ?? 0) + Number(r.amount_total));
  const y = start.getFullYear(), m = String(start.getMonth() + 1).padStart(2, "0");
  for (const [bizId, total] of totals) {
    await admin.from("invoices").insert({ number: `FE-${y}${m}-${bizId.slice(0, 6).toUpperCase()}`, kind: "business_monthly", recipient_id: bizId, total });
  }
  return json({ ok: true, invoices: totals.size });
});
