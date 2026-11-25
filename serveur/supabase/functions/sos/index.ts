// Bouton SOS : l'alerte est enregistrée et l'équipe Side by Side est prévenue immédiatement
// (notification en temps réel aux administrateurs, par déclencheur en base).
// Les secours ne sont jamais appelés automatiquement : l'application propose d'appeler le 112.
import { admin, json, serve, currentUser, rateLimit, HttpError } from "../_shared/clients.ts";

const KINDS: Record<string, string> = { sos: "SOS", report: "signalement SOS", location: "partage de position", contact: "contact de confiance prévenu" };

serve(async (req) => {
  const me = await currentUser(req);
  const { booking_id, kind = "sos", latitude, longitude } = await req.json();
  if (!KINDS[kind]) throw new HttpError(400, "Type d'alerte inconnu");
  await rateLimit(me.id, "sos", 20, 10);
  if (booking_id) {
    const { data: b } = await admin.from("bookings").select("client_id, companion_id").eq("id", booking_id).maybeSingle();
    if (!b || (b.client_id !== me.id && b.companion_id !== me.id)) throw new HttpError(404, "Réservation introuvable");
  }
  const lat = latitude == null ? null : Number(latitude), lng = longitude == null ? null : Number(longitude);
  const { error } = await admin.from("safety_alerts").insert({ booking_id: booking_id ?? null, user_id: me.id, kind: KINDS[kind],
    latitude: Number.isFinite(lat) ? lat : null, longitude: Number.isFinite(lng) ? lng : null });
  if (error) throw error;
  return json({ ok: true, emergency_number: "112", trusted_contact: me.trusted_contact ?? null });
});
