// Actions sur une réservation qui ne passent pas par un paiement :
// accepter, refuser (accompagnateur), signer la fiche de mission (client).
// Chaque action vérifie le rôle de la personne et l'état de la réservation, de façon atomique.
import { admin, json, serve, currentUser, event, notify, HttpError, transition, stripeReady } from "../_shared/clients.ts";

serve(async (req) => {
  const me = await currentUser(req);
  const { booking_id, action } = await req.json();
  const { data: b } = await admin.from("bookings").select("*").eq("id", booking_id).single();
  if (!b || (b.client_id !== me.id && b.companion_id !== me.id)) throw new HttpError(404, "Réservation introuvable");
  const isCompanion = b.companion_id === me.id, now = new Date().toISOString();
  switch (action) {
    case "accept": {
      if (!isCompanion || b.status !== "en_attente") throw new HttpError(409, "Demande déjà traitée");
      if (new Date(b.starts_at).getTime() < Date.now()) throw new HttpError(409, "Rendez-vous déjà passé");
      // Vérifications obligatoires avant toute mission rémunérée
      const { data: cp } = await admin.from("companions").select("verified, video_interview_ok, payouts_enabled").eq("id", me.id).single();
      if (!me.identity_verified) throw new HttpError(403, "Terminez d'abord la vérification de votre identité");
      if (!cp?.verified || !cp.video_interview_ok) throw new HttpError(403, "Votre profil doit d'abord être validé par l'équipe Side by Side");
      if (stripeReady() && !cp.payouts_enabled) throw new HttpError(403, "Configurez d'abord votre compte de versement (Stripe)");
      if (!(await transition(b.id, ["en_attente"], { status: "acceptee", mission_signed_companion: now }))) throw new HttpError(409, "Demande déjà traitée");
      await event(b.id, "acceptee", me.id, "accepté et fiche signée par l'accompagnateur");
      await notify(b.client_id, `${me.first_name} a accepté ${b.ref}. Signez la fiche de mission puis réglez la réservation.`, b.id, "reservation");
      break;
    }
    case "refuse": {
      if (!isCompanion || b.status !== "en_attente") throw new HttpError(409, "Demande déjà traitée");
      if (!(await transition(b.id, ["en_attente"], { status: "refusee" }))) throw new HttpError(409, "Demande déjà traitée");
      await event(b.id, "refusee", me.id);
      await notify(b.client_id, `${me.first_name} a décliné ${b.ref}. Aucun montant n'a été débité.`, b.id, "reservation");
      break;
    }
    case "sign": {
      if (isCompanion || b.status !== "acceptee" || b.mission_signed_client) throw new HttpError(409, "Signature impossible");
      const { data } = await admin.from("bookings").update({ mission_signed_client: now }).eq("id", b.id).eq("status", "acceptee").is("mission_signed_client", null).select("id");
      if (!data?.length) throw new HttpError(409, "Signature impossible");
      await event(b.id, null, me.id, "fiche de mission signée par le client");
      break;
    }
    default: throw new HttpError(400, "Action inconnue");
  }
  return json({ ok: true });
});
