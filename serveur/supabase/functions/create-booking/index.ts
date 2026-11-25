// Création d'une demande de réservation : vérifie le créneau et calcule le prix côté serveur
import { admin, json, cors, currentUser, event } from "../_shared/clients.ts";
import { price } from "../_shared/pricing.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await currentUser(req);
    if (!me.identity_verified) return json({ error: "Vérifiez d'abord votre identité" }, 403);
    const { companion_id, category, starts_at, hours, place, language, note, annex = 0, experience_id, beneficiary } = await req.json();
    const { data: s } = await admin.from("settings").select("*").single();
    const { data: c } = await admin.from("companions").select("*").eq("id", companion_id).single();
    if (!c || !c.verified || !c.video_interview_ok) return json({ error: "Accompagnateur indisponible" }, 404);
    const start = new Date(starts_at), h = Number(hours);
    if (start.getTime() < Date.now() + 24 * 3_600_000) return json({ error: "Réservation au moins 24 h à l'avance" }, 400);
    if (!(h >= s.min_hours && h <= s.max_hours)) return json({ error: "Durée non autorisée" }, 400);
    if (!place || String(place).trim().length < 4) return json({ error: "Indiquez le lieu du rendez-vous" }, 400);
    if (!c.categories.includes(category)) return json({ error: "Activité non proposée" }, 400);
    const end = new Date(start.getTime() + h * 3_600_000);
    const { data: clash } = await admin.from("bookings").select("id, starts_at, hours")
      .eq("companion_id", companion_id).in("status", ["en_attente","acceptee","confirmee","controle","verifie","en_cours"])
      .lt("starts_at", end.toISOString()).gte("starts_at", new Date(start.getTime() - 12 * 3_600_000).toISOString());
    if ((clash ?? []).some((x) => new Date(x.starts_at).getTime() + x.hours * 3_600_000 > start.getTime()))
      return json({ error: "Créneau déjà réservé" }, 409);

    // Réservation pour un proche
    let ben: Record<string, unknown> = {};
    if (beneficiary) {
      const name = String(beneficiary.name ?? "").trim(), phone = String(beneficiary.phone ?? "").replace(/[\s.-]/g, "");
      if (name.length < 2 || !/^(?:\+33|0)[1-9]\d{8}$/.test(phone) || !beneficiary.consent) return json({ error: "Informations du proche incomplètes" }, 400);
      ben = { beneficiary_name: name.slice(0, 40), beneficiary_relation: String(beneficiary.relation ?? "Autre").slice(0, 30), beneficiary_phone: phone,
              beneficiary_needs: Array.isArray(beneficiary.needs) ? beneficiary.needs.slice(0, 6).map(String) : [],
              beneficiary_info: String(beneficiary.info ?? "").slice(0, 400), beneficiary_consent_at: new Date().toISOString() };
    }
    const p = price(Number(c.hourly_rate), h, Number(annex) || 0, s, !!me.privilege_since);
    const { data: b, error } = await admin.from("bookings").insert({
      client_id: me.id, companion_id, category, starts_at: start.toISOString(), hours: h,
      place: String(place).trim(), language, note, experience_id, status: "en_attente", ...p, ...ben,
    }).select().single();
    if (error) throw error;
    await event(b.id, "en_attente", me.id, "demande créée");
    return json({ booking: b });
  } catch (e) { return json({ error: (e as Error).message }, 400); }
});
