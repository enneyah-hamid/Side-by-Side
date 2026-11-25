// Webhook Stripe : la seule source de vérité pour « paiement reçu »
import { stripe, admin, json } from "../_shared/clients.ts";
import { finalize } from "../_shared/finalize.ts";

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature") ?? "";
  let evt;
  try {
    evt = await stripe.webhooks.constructEventAsync(await req.text(), sig, Deno.env.get("STRIPE_WEBHOOK_SECRET")!);
  } catch { return json({ error: "Signature invalide" }, 400); }

  switch (evt.type) {
    case "payment_intent.succeeded": {
      const pi = evt.data.object as any;
      if (pi.metadata.kind === "tip") {
        await admin.from("bookings").update({ tip: pi.amount / 100 }).eq("id", pi.metadata.booking_id);
        await admin.from("ledger").insert({ booking_id: pi.metadata.booking_id, kind: "Pourboire", amount: pi.amount / 100, stripe_object_id: pi.id });
      } else if (pi.metadata.booking_id) {
        const { data: b } = await admin.from("bookings").select("*").eq("id", pi.metadata.booking_id).single();
        if (b && b.status === "acceptee") await finalize(b, Number(pi.metadata.gift_used || 0), pi.metadata.gift_code || null, pi.id);
      }
      break;
    }
    case "setup_intent.succeeded": {                 // empreinte bancaire entreprise enregistrée
      const si = evt.data.object as any;
      await admin.from("business_accounts").update({ stripe_payment_method_id: si.payment_method, card_saved_at: new Date().toISOString(), active: true })
        .eq("id", si.metadata.profile_id);
      break;
    }
    case "account.updated": {                        // dossier Stripe de l'accompagnateur complété
      const a = evt.data.object as any;
      await admin.from("companions").update({ payouts_enabled: !!a.payouts_enabled }).eq("stripe_account_id", a.id);
      break;
    }
    case "charge.dispute.created": {                 // contestation bancaire : alerte admin
      const d = evt.data.object as any;
      await admin.from("audit_log").insert({ action: `Contestation bancaire Stripe ${d.id}`, ref: d.payment_intent });
      break;
    }
  }
  return json({ received: true });
});
