// Tests unitaires des e-mails Side by Side (sans envoi réel : aucune clé Resend dans les tests)
import { brandedHtml, mailFor, mailReady, KIND_PREF } from "../serveur/supabase/functions/_shared/mailer.ts";
const fail = (m: string) => { throw new Error(m); };
Deno.test("M01 objet et bouton dans la langue de l'utilisateur", () => {
  const fr = mailFor("reservation", "fr", "Nouvelle demande CMP-1100.", "Camille"), en = mailFor("annulation", "en", "x"), ar = mailFor("rappel", "ar", "x");
  if (fr.subject !== "Votre réservation Side by Side" || !fr.html.includes("Ouvrir l'application") || !fr.html.includes("Bonjour Camille")) fail(fr.subject);
  if (en.subject !== "Booking cancelled" || !en.html.includes("Open the app")) fail(en.subject);
  if (!ar.html.includes('dir="rtl"')) fail("rtl");
});
Deno.test("M02 identité Side by Side : bleu nuit, doré, adaptée au téléphone", () => {
  const h = brandedHtml({ title: "T", body: "B" });
  if (!h.includes("#060D1F") || !h.includes("#D4AF6A") || !h.includes("max-width:600px") || !h.includes('name="viewport"') || !h.includes("SIDE BY SIDE")) fail("charte");
});
Deno.test("M03 contenu échappé (aucune injection HTML)", () => { if (brandedHtml({ title: "<b>", body: "<script>x</script>" }).includes("<script>")) fail("injection"); });
Deno.test("M04 langue inconnue : français par défaut", () => { if (mailFor("message", "jp", "x").subject !== "Nouveau message sur Side by Side") fail("fr"); });
Deno.test("M05 aucun envoi tant que la clé Resend n'est pas configurée", () => { if (mailReady()) fail("clé présente"); });
Deno.test("M06 préférences : réservations, messages, rappels", () => { if (KIND_PREF.reservation !== "resa" || KIND_PREF.rappel !== "rappel" || KIND_PREF.message !== "msg" || KIND_PREF.sos) fail("prefs"); });
