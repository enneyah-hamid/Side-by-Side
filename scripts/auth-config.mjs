// Réglages de connexion du projet Supabase « Side by Side » (production), appliqués par le déploiement automatique.
// Ne modifie que les réglages listés ici (aucune donnée). Les secrets viennent des « Secrets » GitHub :
//  - toujours : adresses de retour vers l'application (liens de confirmation, mot de passe oublié, Google, Apple) ;
//  - si RESEND_API_KEY existe : envoi des e-mails par Resend (no-reply@zyntell.fr) et modèles aux couleurs de Side by Side ;
//  - si GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET existent : connexion avec Google ;
//  - si APPLE_CLIENT_ID et APPLE_SECRET existent : connexion avec Apple.
// Rien n'est affiché des valeurs secrètes.
import { readFileSync } from "node:fs";
const { SUPABASE_ACCESS_TOKEN: TOKEN, PROJECT, RESEND_API_KEY, MAIL_FROM_ADDRESS, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APPLE_CLIENT_ID, APPLE_SECRET } = process.env;
if (!TOKEN || !PROJECT) { console.log("Jeton Supabase absent : réglages de connexion ignorés."); process.exit(0); }
const T = (n) => readFileSync(new URL(`../serveur/supabase/templates/${n}.html`, import.meta.url), "utf8");
const DEEP = "fr.zyntell.sidebyside://auth/callback";
const patch = {
  site_url: DEEP,
  uri_allow_list: [DEEP, "fr.zyntell.sidebyside://**", "https://localhost/**", "capacitor://localhost/**"].join(","),
};
if (RESEND_API_KEY) Object.assign(patch, {
  smtp_host: "smtp.resend.com", smtp_port: "465", smtp_user: "resend", smtp_pass: RESEND_API_KEY,
  smtp_admin_email: MAIL_FROM_ADDRESS || "no-reply@zyntell.fr", smtp_sender_name: "Side by Side", smtp_max_frequency: 60,
  mailer_subjects_confirmation: "Bienvenue sur Side by Side : confirmez votre adresse e-mail",
  mailer_subjects_recovery: "Side by Side : réinitialisation de votre mot de passe",
  mailer_subjects_magic_link: "Side by Side : votre lien de connexion",
  mailer_subjects_email_change: "Side by Side : confirmez votre nouvelle adresse e-mail",
  mailer_templates_confirmation_content: T("confirmation"), mailer_templates_recovery_content: T("recovery"),
  mailer_templates_magic_link_content: T("magic_link"), mailer_templates_email_change_content: T("email_change"),
});
if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) Object.assign(patch, { external_google_enabled: true, external_google_client_id: GOOGLE_CLIENT_ID, external_google_secret: GOOGLE_CLIENT_SECRET });
if (APPLE_CLIENT_ID && APPLE_SECRET) Object.assign(patch, { external_apple_enabled: true, external_apple_client_id: APPLE_CLIENT_ID, external_apple_secret: APPLE_SECRET });
const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/config/auth`, {
  method: "PATCH", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(patch),
});
const keys = Object.keys(patch).filter((k) => !/pass|secret/.test(k));
if (!r.ok) {
  console.log(`::warning::Réglages de connexion non appliqués (${r.status}) : ${(await r.text()).slice(0, 300)}`);
  console.log("À faire une fois dans Supabase → Authentication → URL Configuration : Site URL = " + DEEP + " ; Redirect URLs = fr.zyntell.sidebyside://** (ou créer un jeton d'accès avec la permission auth_config_write).");
  process.exit(0);
}
console.log(`Réglages de connexion appliqués : ${keys.join(", ")}`);
console.log(`E-mails personnalisés : ${RESEND_API_KEY ? "oui (Resend)" : "non (secret RESEND_API_KEY absent)"} · Google : ${GOOGLE_CLIENT_ID ? "activé" : "non configuré"} · Apple : ${APPLE_CLIENT_ID ? "activé" : "non configuré"}`);
