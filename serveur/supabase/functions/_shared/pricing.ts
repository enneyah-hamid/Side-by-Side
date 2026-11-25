// Calcul des montants : toujours côté serveur, jamais confié au téléphone
const r2 = (n: number) => Math.round(n * 100) / 100;

export type Settings = {
  client_fee_pct: number; companion_fee_pct: number; privilege_fee_pct: number; vat_pct: number;
};

export function price(rate: number, hours: number, annex: number, s: Settings, privilege: boolean) {
  const service = r2(rate * hours);                                   // prestation
  const feePct = privilege ? s.privilege_fee_pct : s.client_fee_pct;
  const clientFee = r2(service * feePct / 100);                       // frais de service client
  const vat = r2(clientFee * s.vat_pct / 100);                        // TVA sur frais
  const commission = r2(service * s.companion_fee_pct / 100);         // retenue accompagnateur
  const total = r2(service + clientFee + vat + annex);
  const payout = r2(service - commission + annex);
  return { amount_service: service, amount_client_fee: clientFee, amount_vat: vat, amount_annex: annex,
           amount_total: total, amount_commission: commission, amount_payout: payout };
}
