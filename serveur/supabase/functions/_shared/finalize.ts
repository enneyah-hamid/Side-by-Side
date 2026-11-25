// Confirmation d'une réservation payée — atomique : un même paiement ne peut confirmer qu'une seule fois
import { admin, event, notify, rand6, transition } from "./clients.ts";

export async function finalize(bookingId: string, piId: string | null): Promise<any | null> {
  const b = await transition(bookingId, ["acceptee"], { status: "confirmee", payment_lock_at: null });
  if (!b) return null;                                        // déjà confirmée, annulée ou expirée
  await admin.rpc("consume_gift", { p_booking: b.id });
  const paid = Math.round((Number(b.amount_total) - Number(b.gift_used)) * 100) / 100;
  if (paid > 0) {
    const { error } = await admin.from("ledger").insert({ booking_id: b.id, kind: "Encaissement", amount: paid, stripe_object_id: piId });
    if (error && error.code !== "23505") throw error;         // 23505 : déjà enregistré (rejeu)
  }
  // Code de rencontre et code de détresse, uniques à la réservation, valables jusqu'à 2 h après la fin
  let code = rand6(), distress = rand6();
  while (distress === code) distress = rand6();
  const expires = new Date(new Date(b.ends_at).getTime() + 2 * 3_600_000).toISOString();
  await admin.from("booking_secrets").upsert({ booking_id: b.id, code, distress, expires_at: expires }, { onConflict: "booking_id", ignoreDuplicates: true });
  await event(b.id, "paiement_confirme", null, piId ? "Stripe" : "carte cadeau");
  await event(b.id, "confirmee", null, "Système");
  await notify(b.client_id, `Paiement confirmé pour ${b.ref}. Votre code de rencontre est disponible dans la réservation.`, b.id, "paiement");
  await notify(b.companion_id, `${b.ref} est confirmée et payée.`, b.id, "paiement");
  return b;
}
