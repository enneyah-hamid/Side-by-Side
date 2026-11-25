// Facture mensuelle des comptes entreprise (planifiée le 1er de chaque mois) : réservations payées uniquement
import { admin, json, serve, requireInternal, PAID } from "../_shared/clients.ts";

serve(async (req) => {
  requireInternal(req);
  const end = new Date(); end.setDate(1); end.setHours(0, 0, 0, 0);
  const start = new Date(end); start.setMonth(start.getMonth() - 1);
  const { data: rows } = await admin.from("bookings").select("business_id, amount_total")
    .not("business_id", "is", null).gte("starts_at", start.toISOString()).lt("starts_at", end.toISOString()).in("status", PAID);
  const totals = new Map<string, number>();
  for (const r of rows ?? []) totals.set(r.business_id, (totals.get(r.business_id) ?? 0) + Number(r.amount_total));
  const y = start.getFullYear(), m = String(start.getMonth() + 1).padStart(2, "0");
  let created = 0;
  for (const [bizId, total] of totals) {
    const { error } = await admin.from("invoices").insert({ number: `FE-${y}${m}-${bizId.slice(0, 8).toUpperCase()}`, kind: "business_monthly", recipient_id: bizId, total: Math.round(total * 100) / 100 });
    if (!error) created++;                                   // déjà émise : le numéro unique empêche le doublon
  }
  return json({ ok: true, invoices: created });
});
