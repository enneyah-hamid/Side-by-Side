// Fin d'inscription après une connexion Google ou Apple : type de compte, date de naissance (18 ans minimum),
// pays, ville, téléphone et engagements. Possible une seule fois, tant que le profil est incomplet.
import { admin, json, serve, currentUser, audit, HttpError } from "../_shared/clients.ts";

const TZ = /^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/;
serve(async (req) => {
  const me = await currentUser(req);
  if (me.birth_date) throw new HttpError(409, "Profil déjà complété");
  const b = await req.json();
  const role = b.role === "companion" ? "companion" : "client";
  const dob = String(b.birth_date ?? ""), d = new Date(dob + "T12:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || isNaN(d.getTime())) throw new HttpError(400, "Indiquez votre date de naissance");
  const adult = new Date(); adult.setUTCFullYear(adult.getUTCFullYear() - 18);
  if (d > adult) throw new HttpError(403, "Side by Side est réservé aux personnes majeures");
  const country = String(b.country ?? "FR").toUpperCase(), city = String(b.city ?? "").trim().replace(/\s+/g, " ");
  if (!/^[A-Z]{2}$/.test(country)) throw new HttpError(400, "Pays invalide");
  if (city.length < 1 || city.length > 60) throw new HttpError(400, "Indiquez votre ville");
  const phone = String(b.phone ?? "").replace(/[\s.-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new HttpError(400, "Numéro de téléphone invalide (format international)");
  if (!b.terms || !b.privacy || !b.charter || !b.adult) throw new HttpError(400, "Acceptez les conditions, la politique de confidentialité et la charte");
  if (role === "companion" && !b.non_circumvention) throw new HttpError(400, "L'engagement de non-contournement est obligatoire");
  const first = String(b.first_name ?? me.first_name).trim().slice(0, 40), last = String(b.last_name ?? me.last_name).trim().slice(0, 60);
  if (first.length < 2 || last.length < 1) throw new HttpError(400, "Indiquez votre prénom et votre nom");
  const now = new Date().toISOString(), lang = ["fr", "en", "es", "it", "de", "pt", "ar"].includes(b.lang) ? b.lang : "fr";
  const { error } = await admin.from("profiles").update({ role, birth_date: dob, country, city, phone, first_name: first, last_name: last, lang,
    terms_accepted_at: now, privacy_accepted_at: now, charter_accepted_at: now }).eq("id", me.id).is("birth_date", null);
  if (error) throw new HttpError(409, /phone/.test(error.message) ? "Ce numéro est déjà utilisé" : "Enregistrement impossible");
  if (role === "companion") await admin.from("companions").upsert({ id: me.id, hourly_rate: 35, non_circumvention_accepted_at: now, time_zone: TZ.test(b.time_zone ?? "") ? b.time_zone : "Europe/Paris" }, { onConflict: "id", ignoreDuplicates: true });
  await audit(me.id, `Inscription complétée après connexion externe (${role === "companion" ? "accompagnateur" : "client"})`);
  return json({ ok: true, role });
});
