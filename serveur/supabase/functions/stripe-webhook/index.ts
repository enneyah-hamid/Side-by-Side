// Webhook Stripe : la seule source de vérité pour « paiement reçu ».
// Chaque événement est traité une seule fois ; un paiement qui ne correspond pas exactement
// à une réservation payable est remboursé automatiquement.
import { stripe, admin, json, cents, event, audit, notify, notifyAdmins, PAID, transition } from "../_shared/clients.ts";
import { finalize } from "../_shared/finalize.ts";

async function autoRefund(pi: any, why: string, bookingId?: string, ref?: string) {
  const r = await stripe.refunds.create({ payment_intent: pi.id, ...(pi.transfer_data ? { reverse_transfer: true } : {}) }, { idempotencyKey: `auto-refund-${pi.id}` });
  const { error } = await admin.from("ledger").insert({ booking_id: bookingId ?? null, kind: "Remboursement automatique", amount: -pi.amount / 100, stripe_object_id: r.id });
  if (error && error.code !== "23505") throw error;
  await audit(null, `Paiement ${pi.id} remboursé automatiquement : ${why}`, ref ?? null);
  await notifyAdmins(`Paiement remboursé automatiquement${ref ? ` sur ${ref}` : ""} : ${why}.`, bookingId);
}

async function handle(evt: any) {
  const o = evt.data.object as any;
  switch (evt.type) {
    case "payment_intent.succeeded": {
      const kind = o.metadata?.kind ?? "booking", bid = o.metadata?.booking_id;
      if (!bid) return;
      const { data: b } = await admin.from("bookings").select("*").eq("id", bid).maybeSingle();
      if (!b) return autoRefund(o, "réservation introuvable");
      if (o.currency !== "eur") return autoRefund(o, "devise inattendue", b.id, b.ref);
      if (kind === "tip") {
        const { data: t } = await admin.from("bookings").update({ tip: o.amount / 100 }).eq("id", b.id).eq("tip", 0).select("id");
        if (!t?.length) return autoRefund(o, "pourboire déjà versé", b.id, b.ref);
        const { error } = await admin.from("ledger").insert({ booking_id: b.id, kind: "Pourboire", amount: o.amount / 100, stripe_object_id: o.id });
        if (error && error.code !== "23505") throw error;
        await notify(b.companion_id, `Vous avez reçu un pourboire de ${(o.amount / 100).toFixed(2)} € pour ${b.ref}.`, b.id, "paiement");
        return;
      }
      if (kind === "extension") {
        const { data: x } = await admin.from("booking_extensions").update({ status: "paid" }).eq("id", o.metadata.extension_id).eq("status", "accepted").eq("stripe_payment_intent_id", o.id).select();
        const e = x?.[0];
        if (!e || cents(e.amount_total) !== o.amount || !["en_cours", "double_attente"].includes(b.status)) return autoRefund(o, "prolongation non applicable", b.id, b.ref);
        const { error } = await admin.from("bookings").update({
          extra_minutes: b.extra_minutes + e.minutes,
          amount_service: Number(b.amount_service) + Number(e.amount_service), amount_client_fee: Number(b.amount_client_fee) + Number(e.amount_client_fee),
          amount_vat: Number(b.amount_vat) + Number(e.amount_vat), amount_total: Number(b.amount_total) + Number(e.amount_total),
          amount_commission: Number(b.amount_commission) + Number(e.amount_commission), amount_payout: Number(b.amount_payout) + Number(e.amount_payout),
        }).eq("id", b.id).eq("extra_minutes", b.extra_minutes);
        if (error) {                                               // ex. : la prolongation chevauche la réservation suivante
          await admin.from("booking_extensions").update({ status: "expired" }).eq("id", e.id);
          return autoRefund(o, "prolongation impossible (créneau suivant déjà réservé)", b.id, b.ref);
        }
        const { error: le } = await admin.from("ledger").insert({ booking_id: b.id, kind: "Encaissement (prolongation)", amount: o.amount / 100, stripe_object_id: o.id });
        if (le && le.code !== "23505") throw le;
        await event(b.id, null, b.client_id, `prolongation payée : +${e.minutes} min`);
        await notify(b.companion_id, `Prolongation de ${e.minutes} min payée pour ${b.ref}.`, b.id, "prolongation");
        await notify(b.client_id, `Prolongation de ${e.minutes} min active.`, b.id, "prolongation");
        return;
      }
      // Paiement de la réservation : même identifiant, même montant, même devise, sinon remboursement
      if (PAID.includes(b.status) && b.stripe_payment_intent_id === o.id) return;        // déjà traité
      const expected = cents(Number(b.amount_total) - Number(b.gift_used));
      if (b.stripe_payment_intent_id !== o.id) return autoRefund(o, "second paiement pour la même réservation", b.id, b.ref);
      if (o.amount !== expected) return autoRefund(o, `montant inattendu (${o.amount / 100} € au lieu de ${expected / 100} €)`, b.id, b.ref);
      const done = await finalize(b.id, o.id);
      if (!done) {
        const { data: now } = await admin.from("bookings").select("status, stripe_payment_intent_id").eq("id", b.id).single();
        if (now && PAID.includes(now.status) && now.stripe_payment_intent_id === o.id) return;   // confirmé par un envoi simultané
        return autoRefund(o, `réservation au statut « ${now?.status ?? b.status} » au moment du paiement`, b.id, b.ref);
      }
      return;
    }
    case "payment_intent.payment_failed": {
      const bid = o.metadata?.booking_id;
      if (bid && (o.metadata?.kind ?? "booking") === "booking") {
        const { data: b } = await admin.from("bookings").select("client_id, ref").eq("id", bid).maybeSingle();
        await notify(b?.client_id, `Le paiement de ${b?.ref ?? "votre réservation"} n'a pas abouti. Vous pouvez réessayer.`, bid, "paiement");
      }
      return;
    }
    case "payment_intent.canceled": {
      const bid = o.metadata?.booking_id;
      if (bid && (o.metadata?.kind ?? "booking") === "booking") {
        const { data: b } = await admin.from("bookings").select("status, stripe_payment_intent_id").eq("id", bid).maybeSingle();
        if (b && b.stripe_payment_intent_id === o.id && !PAID.includes(b.status)) await admin.rpc("release_gift", { p_booking: bid });
      }
      return;
    }
    case "charge.refunded": {                                       // remboursements faits depuis le tableau de bord Stripe aussi
      const { data: b } = await admin.from("bookings").select("id").eq("stripe_payment_intent_id", o.payment_intent).maybeSingle();
      for (const r of o.refunds?.data ?? []) {
        const { error } = await admin.from("ledger").insert({ booking_id: b?.id ?? null, kind: "Remboursement", amount: -r.amount / 100, stripe_object_id: r.id });
        if (error && error.code !== "23505") throw error;
      }
      return;
    }
    case "charge.dispute.created": {                               // contestation bancaire : versement gelé, dossier ouvert
      const { data: b } = await admin.from("bookings").select("*").eq("stripe_payment_intent_id", o.payment_intent).maybeSingle();
      if (b) {
        await transition(b.id, ["confirmee", "controle", "verifie", "en_cours", "fin_declaree", "double_attente", "terminee", "a_verifier", "incident"], { status: "contestee" });
        await admin.from("disputes").insert({ booking_id: b.id, opened_by: b.client_id, reason: "Contestation de paiement", description: `Contestation bancaire Stripe ${o.id} (${o.reason ?? "motif non précisé"})`, deadline: new Date(Date.now() + 7 * 86_400_000).toISOString() });
        await event(b.id, "contestee", null, "contestation bancaire");
      }
      await audit(null, `Contestation bancaire Stripe ${o.id}`, b?.ref ?? o.payment_intent);
      await notifyAdmins(`Contestation bancaire${b ? ` sur ${b.ref}` : ""} : répondre dans le tableau de bord Stripe avant l'échéance.`, b?.id);
      return;
    }
    case "setup_intent.succeeded": {                               // empreinte bancaire entreprise enregistrée
      if (!o.metadata?.profile_id) return;
      await admin.from("business_accounts").update({ stripe_payment_method_id: o.payment_method, card_saved_at: new Date().toISOString(), active: true }).eq("id", o.metadata.profile_id);
      return;
    }
    case "account.updated": {                                      // dossier Stripe de l'accompagnateur complété
      await admin.from("companions").update({ payouts_enabled: !!o.payouts_enabled }).eq("stripe_account_id", o.id);
      return;
    }
  }
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return json({ error: "Webhook non configuré" }, 503);
  let evt;
  try { evt = await stripe.webhooks.constructEventAsync(await req.text(), req.headers.get("stripe-signature") ?? "", secret); }
  catch { return json({ error: "Signature invalide" }, 400); }

  // Dédoublonnage : Stripe peut envoyer plusieurs fois le même événement
  await admin.from("stripe_events").upsert({ id: evt.id, type: evt.type }, { onConflict: "id", ignoreDuplicates: true });
  const { data: seen } = await admin.from("stripe_events").select("processed_at").eq("id", evt.id).single();
  if (seen?.processed_at) return json({ received: true, duplicate: true });
  try { await handle(evt); }
  catch (e) { console.error(e); return json({ error: "Traitement à reprendre" }, 500); }  // Stripe renverra l'événement
  await admin.from("stripe_events").update({ processed_at: new Date().toISOString() }).eq("id", evt.id).is("processed_at", null);
  return json({ received: true });
});
