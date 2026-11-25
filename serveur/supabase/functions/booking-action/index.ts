// Actions sur une réservation qui ne passent pas par un paiement :
// accepter, refuser (accompagnateur), signer la fiche de mission (client).
// Chaque action vérifie le rôle de la personne et l'état de la réservation.
import { admin, json, cors, currentUser, event } from "../_shared/clients.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await currentUser(req);
    const { booking_id, action } = await req.json();
    const { data: b } = await admin.from("bookings").select("*").eq("id", booking_id).single();
    if (!b || (b.client_id !== me.id && b.companion_id !== me.id)) return json({ error: "Réservation introuvable" }, 404);
    const isCompanion = b.companion_id === me.id, now = new Date().toISOString();
    let patch: Record<string, unknown> | null = null, status: string | null = null, note = "";

    switch (action) {
      case "accept":
        if (!isCompanion || b.status !== "en_attente") return json({ error: "Demande déjà traitée" }, 409);
        if (new Date(b.starts_at).getTime() < Date.now()) return json({ error: "Rendez-vous déjà passé" }, 409);
        patch = { status: "acceptee", mission_signed_companion: now }; status = "acceptee"; note = "accepté et fiche signée par l'accompagnateur";
        break;
      case "refuse":
        if (!isCompanion || b.status !== "en_attente") return json({ error: "Demande déjà traitée" }, 409);
        patch = { status: "refusee" }; status = "refusee";
        break;
      case "sign":
        if (isCompanion || b.status !== "acceptee" || b.mission_signed_client) return json({ error: "Signature impossible" }, 409);
        patch = { mission_signed_client: now }; note = "fiche de mission signée par le client";
        break;
      default:
        return json({ error: "Action inconnue" }, 400);
    }
    const { error } = await admin.from("bookings").update(patch).eq("id", b.id).eq("status", b.status);   // pas de double traitement
    if (error) throw error;
    await event(b.id, status as any, me.id, note);
    return json({ ok: true });
  } catch (e) { return json({ error: (e as Error).message }, 400); }
});
