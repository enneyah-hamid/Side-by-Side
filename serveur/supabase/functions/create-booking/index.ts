// Création d'une demande de réservation : toutes les règles sont vérifiées ici, côté serveur
import { admin, json, serve, currentUser, event, notify, rateLimit, HttpError } from "../_shared/clients.ts";
import { price } from "../_shared/pricing.ts";

// Jour (lundi = 0) et heure décimale à Paris, quel que soit le fuseau du téléphone
function paris(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { wd: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday), h: Number(p.hour) + Number(p.minute) / 60, day: `${p.year}-${p.month}-${p.day}` };
}

serve(async (req) => {
  const me = await currentUser(req);
  if (!me.identity_verified) throw new HttpError(403, "Vérifiez d'abord votre identité");
  if (me.role === "companion") throw new HttpError(403, "Un compte accompagnateur ne peut pas réserver");
  await rateLimit(me.id, "booking", 15, 24 * 60);                       // pas plus de 15 demandes par 24 h
  const { companion_id, category, starts_at, hours, place, language, note, annex = 0, experience_id, beneficiary } = await req.json();
  const { data: s } = await admin.from("settings").select("*").single();
  const { data: c } = await admin.from("companions").select("*, profiles!companions_id_fkey(suspended, first_name)").eq("id", companion_id).maybeSingle();
  if (!c || !c.verified || !c.video_interview_ok || c.profiles?.suspended || companion_id === me.id) throw new HttpError(404, "Accompagnateur indisponible");
  const start = new Date(starts_at), h = Number(hours), an = Number(annex);
  if (isNaN(start.getTime())) throw new HttpError(400, "Indiquez la date et l'heure");
  if (start.getTime() < Date.now() + 24 * 3_600_000) throw new HttpError(400, "Réservation au moins 24 h à l'avance");
  if (start.getTime() > Date.now() + 366 * 24 * 3_600_000) throw new HttpError(400, "Date trop lointaine");
  if (!Number.isInteger(h) || h < s.min_hours || h > s.max_hours) throw new HttpError(400, "Durée non autorisée");
  if (!Number.isFinite(an) || an < 0 || an > 1000) throw new HttpError(400, "Frais annexes invalides");
  if (!place || String(place).trim().length < 4 || String(place).length > 200) throw new HttpError(400, "Indiquez le lieu du rendez-vous");
  if (!c.categories.includes(category)) throw new HttpError(400, "Activité non proposée");
  if (note && String(note).length > 1000) throw new HttpError(400, "Message trop long");
  // Disponibilités de l'accompagnateur (jours, horaires, jours bloqués) à l'heure de Paris
  const P = paris(start);
  if (!(c.work_days ?? []).map(Number).includes(P.wd)) throw new HttpError(400, `${c.profiles?.first_name ?? "L'accompagnateur"} n'est pas disponible ce jour-là`);
  if (P.h < c.hour_from || P.h + h > c.hour_to) throw new HttpError(400, `Disponible de ${c.hour_from} h à ${c.hour_to} h`);
  const { data: blocked } = await admin.from("companion_blocked_days").select("day").eq("companion_id", companion_id).eq("day", P.day);
  if (blocked?.length) throw new HttpError(400, "Accompagnateur indisponible ce jour-là");
  if (experience_id) {
    const { data: x } = await admin.from("experiences").select("id").eq("id", experience_id).eq("companion_id", companion_id).eq("status", "ok").maybeSingle();
    if (!x) throw new HttpError(400, "Expérience indisponible");
  }
  // Réservation pour un proche
  let ben: Record<string, unknown> = {};
  if (beneficiary) {
    const name = String(beneficiary.name ?? "").trim(), phone = String(beneficiary.phone ?? "").replace(/[\s.-]/g, "");
    if (name.length < 2 || !/^(?:\+33|0)[1-9]\d{8}$/.test(phone) || !beneficiary.consent) throw new HttpError(400, "Informations du proche incomplètes");
    ben = { beneficiary_name: name.slice(0, 40), beneficiary_relation: String(beneficiary.relation ?? "Autre").slice(0, 30), beneficiary_phone: phone,
            beneficiary_needs: Array.isArray(beneficiary.needs) ? beneficiary.needs.slice(0, 6).map((x: unknown) => String(x).slice(0, 40)) : [],
            beneficiary_info: String(beneficiary.info ?? "").slice(0, 400), beneficiary_consent_at: new Date().toISOString() };
  }
  const p = price(Number(c.hourly_rate), h, Math.round(an * 100) / 100, s, !!me.privilege_since);
  // La base refuse tout chevauchement (contrainte d'exclusion), même pour deux demandes simultanées
  const { data: b, error } = await admin.from("bookings").insert({
    client_id: me.id, companion_id, category, starts_at: start.toISOString(), hours: h,
    place: String(place).trim(), language: language ? String(language).slice(0, 30) : null, note: note ? String(note) : null,
    experience_id: experience_id ?? null, status: "en_attente", buffer_min: c.travel_buffer_min ?? 0, ...p, ...ben,
  }).select().single();
  if (error) { if (error.code === "23P01") throw new HttpError(409, "Créneau déjà réservé"); throw error; }
  await event(b.id, "en_attente", me.id, "demande créée");
  await notify(companion_id, `Nouvelle demande ${b.ref} de ${me.first_name}.`, b.id, "reservation");
  return json({ booking: b });
});
