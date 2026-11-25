// Confirme une réservation une fois le paiement reçu
import { admin, event } from "./clients.ts";

export async function finalize(b: any, giftUsed: number, giftCode: string | null, piId: string | null) {
  const paid = Number(b.amount_total) - giftUsed;   // montant réellement encaissé par carte
  if (giftUsed > 0 && giftCode) {
    // Déduction atomique : impossible d'utiliser deux fois le même solde
    const { data: ok } = await admin.rpc("use_gift", { p_code: giftCode, p_amount: giftUsed });
    if (!ok) {
      await admin.from("audit_log").insert({ action: `Carte cadeau ${giftCode} : solde insuffisant au moment du paiement, montant à régulariser`, ref: b.ref });
      giftUsed = 0; giftCode = null;
    }
  }
  await admin.from("bookings").update({ status: "confirmee", gift_code: giftCode, gift_used: giftUsed }).eq("id", b.id);
  await admin.from("ledger").insert({ booking_id: b.id, kind: "Encaissement", amount: paid, stripe_object_id: piId });
  await event(b.id, "paiement_confirme", null, "Stripe");
  await event(b.id, "confirmee", null, "Système");
}
