// Versement à l'accompagnateur — une seule fois par réservation, même si plusieurs appels arrivent ensemble
import { stripe, admin, cents, event, audit, notify, notifyAdmins, transition } from "./clients.ts";

export async function releasePayout(bookingId: string, actor: string | null = null) {
  const { data: open } = await admin.from("disputes").select("id").eq("booking_id", bookingId).eq("status", "ouvert").limit(1);
  if (open?.length) return { ok: false, reason: "Dossier de litige ouvert : versement suspendu" };

  // 1. On « réserve » le versement : seul l'appel qui fait passer terminee → versement continue
  const b = await transition(bookingId, ["terminee"], { status: "versement", payout_error: null });
  if (!b) {
    const { data: cur } = await admin.from("bookings").select("status, stripe_transfer_id").eq("id", bookingId).single();
    return { ok: !!cur?.stripe_transfer_id, already: !!cur?.stripe_transfer_id, reason: cur ? `Statut ${cur.status}` : "Introuvable" };
  }
  if (!b.end_client || !b.end_companion) {
    await transition(b.id, ["versement"], { status: "terminee", payout_error: "Double validation de fin manquante" });
    return { ok: false, reason: "Double validation de fin manquante" };
  }
  const { data: c } = await admin.from("companions").select("stripe_account_id, payouts_enabled").eq("id", b.companion_id).single();
  if (!c?.stripe_account_id || !c.payouts_enabled) {
    await transition(b.id, ["versement"], { status: "terminee", payout_error: "Compte de versement de l'accompagnateur incomplet" });
    await notify(b.companion_id, `Complétez votre compte de versement pour recevoir le paiement de ${b.ref}.`, b.id, "versement");
    return { ok: false, reason: "Compte de versement de l'accompagnateur incomplet" };
  }
  try {
    const amount = cents(b.amount_payout);
    let source: string | undefined;
    if (b.stripe_payment_intent_id) {
      const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id);
      if (pi.latest_charge && (pi.amount_received ?? 0) >= amount) source = String(pi.latest_charge);
    }
    // 2. Un virement existe déjà pour cette réservation (essai précédent interrompu) : on le reprend
    const prev = await stripe.transfers.list({ transfer_group: b.ref, limit: 20 });
    const found = prev.data.find((t: any) => t.metadata?.booking_id === b.id && !t.reversed);
    // 3. Sinon un seul virement, protégé par le verrou ci-dessus et une clé d'idempotence Stripe
    const transfer = found ?? await stripe.transfers.create({
      amount, currency: "eur", destination: c.stripe_account_id, transfer_group: b.ref,
      ...(source ? { source_transaction: source } : {}), metadata: { booking_id: b.id, ref: b.ref },
    }, { idempotencyKey: `payout-${b.id}-${new Date(b.created_at).getTime()}-${(b.payout_attempts ?? 0)}` });
    await admin.from("bookings").update({ stripe_transfer_id: transfer.id, status: "cloturee" }).eq("id", b.id).eq("status", "versement");
    const { error } = await admin.from("ledger").insert({ booking_id: b.id, kind: "Versement", amount: b.amount_payout, stripe_object_id: transfer.id });
    if (error && error.code !== "23505") throw error;
    await event(b.id, "cloturee", actor, "versement exécuté");
    await notify(b.companion_id, `Versement de ${Number(b.amount_payout).toFixed(2)} € envoyé pour ${b.ref}.`, b.id, "versement");
    return { ok: true, transfer: transfer.id };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await transition(b.id, ["versement"], { status: "terminee", payout_error: msg, payout_attempts: (b.payout_attempts ?? 0) + 1 });
    await audit(actor, `Échec du versement : ${msg}`, b.ref);
    await notifyAdmins(`Échec du versement sur ${b.ref} : nouvel essai automatique.`, b.id);
    return { ok: false, reason: "Versement en échec, nouvel essai programmé" };
  }
}
