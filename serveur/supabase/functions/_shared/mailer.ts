// E-mails de Side by Side aux couleurs de la marque (bleu nuit et doré), envoyés par Resend.
// Inactif tant que la clé RESEND_API_KEY n'est pas enregistrée dans les secrets Supabase :
// aucune adresse n'est alors utilisée et rien n'est envoyé.
export const LANGS = ["fr", "en", "es", "it", "de", "pt", "ar"] as const;
type Lang = typeof LANGS[number];
const L = (lang?: string | null): Lang => (LANGS as readonly string[]).includes(lang ?? "") ? lang as Lang : "fr";

// Catégories de préférences (Compte → Notifications) et objets des e-mails
export const KIND_PREF: Record<string, "resa" | "msg" | "rappel"> = {
  reservation: "resa", annulation: "resa", paiement: "resa", prolongation: "resa", fin: "resa", versement: "resa", litige: "resa",
  message: "msg", rappel: "rappel", assurance: "resa", fiscal: "resa", assistance: "msg",
};
const SUBJ: Record<string, Record<Lang, string>> = {
  reservation: { fr: "Votre réservation Side by Side", en: "Your Side by Side booking", es: "Su reserva Side by Side", it: "La sua prenotazione Side by Side", de: "Ihre Side by Side Buchung", pt: "A sua reserva Side by Side", ar: "حجزك على Side by Side" },
  annulation: { fr: "Annulation d'une réservation", en: "Booking cancelled", es: "Reserva cancelada", it: "Prenotazione annullata", de: "Buchung storniert", pt: "Reserva cancelada", ar: "إلغاء حجز" },
  rappel: { fr: "Rappel : votre rendez-vous Side by Side", en: "Reminder: your Side by Side appointment", es: "Recordatorio: su cita Side by Side", it: "Promemoria: il suo appuntamento Side by Side", de: "Erinnerung: Ihr Side by Side Termin", pt: "Lembrete: o seu encontro Side by Side", ar: "تذكير: موعدك على Side by Side" },
  message: { fr: "Nouveau message sur Side by Side", en: "New message on Side by Side", es: "Nuevo mensaje en Side by Side", it: "Nuovo messaggio su Side by Side", de: "Neue Nachricht auf Side by Side", pt: "Nova mensagem no Side by Side", ar: "رسالة جديدة على Side by Side" },
  assistance: { fr: "Réponse de l'assistance Side by Side", en: "Reply from Side by Side support", es: "Respuesta del soporte de Side by Side", it: "Risposta dell'assistenza Side by Side", de: "Antwort vom Side by Side Support", pt: "Resposta do apoio Side by Side", ar: "رد من دعم Side by Side" },
  default: { fr: "Side by Side : nouvelle notification", en: "Side by Side: new notification", es: "Side by Side: nueva notificación", it: "Side by Side: nuova notifica", de: "Side by Side: neue Benachrichtigung", pt: "Side by Side: nova notificação", ar: "Side by Side: إشعار جديد" },
};
const UI: Record<Lang, { open: string; why: string; pref: string; hello: string }> = {
  fr: { hello: "Bonjour", open: "Ouvrir l'application", why: "Vous recevez cet e-mail car vous utilisez Side by Side.", pref: "Gérez vos préférences dans Compte → Notifications." },
  en: { hello: "Hello", open: "Open the app", why: "You are receiving this email because you use Side by Side.", pref: "Manage your preferences in Account → Notifications." },
  es: { hello: "Hola", open: "Abrir la aplicación", why: "Recibe este correo porque utiliza Side by Side.", pref: "Gestione sus preferencias en Cuenta → Notificaciones." },
  it: { hello: "Buongiorno", open: "Apri l'app", why: "Riceve questa e-mail perché utilizza Side by Side.", pref: "Gestisca le preferenze in Account → Notifiche." },
  de: { hello: "Hallo", open: "App öffnen", why: "Sie erhalten diese E-Mail, weil Sie Side by Side nutzen.", pref: "Einstellungen unter Konto → Benachrichtigungen." },
  pt: { hello: "Olá", open: "Abrir a aplicação", why: "Recebe este e-mail porque utiliza o Side by Side.", pref: "Gira as suas preferências em Conta → Notificações." },
  ar: { hello: "مرحبًا", open: "افتح التطبيق", why: "تتلقى هذه الرسالة لأنك تستخدم Side by Side.", pref: "يمكنك إدارة تفضيلاتك من الحساب ← الإشعارات." },
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const APP_LINK = "fr.zyntell.sidebyside://open";

// Mise en page commune, lisible sur smartphone (600 px maximum, styles en ligne)
export function brandedHtml(o: { lang?: string | null; title: string; body: string; button?: { label: string; url: string }; firstName?: string | null }) {
  const lg = L(o.lang), t = UI[lg], dir = lg === "ar" ? "rtl" : "ltr";
  return `<!doctype html><html lang="${lg}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title></head>
<body style="margin:0;background:#060D1F;font-family:Helvetica,Arial,sans-serif;color:#EDE6D6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#060D1F"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#0B1730;border:1px solid #2A3A5C;border-radius:14px">
<tr><td align="center" style="padding:28px 24px 8px"><div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;letter-spacing:4px;color:#D4AF6A">SIDE BY SIDE</div>
<div style="font-family:Georgia,serif;font-style:italic;font-size:15px;color:#D4AF6A;opacity:.85">moments</div><div style="height:1px;background:#D4AF6A;opacity:.35;margin:18px 40px 0"></div></td></tr>
<tr><td style="padding:18px 28px 8px;font-size:16px;line-height:1.55"><h1 style="font-family:Georgia,serif;font-weight:normal;font-size:22px;color:#F5EFE2;margin:0 0 14px">${esc(o.title)}</h1>
${o.firstName ? `<p style="margin:0 0 12px">${t.hello} ${esc(o.firstName)},</p>` : ""}<p style="margin:0 0 18px">${esc(o.body)}</p></td></tr>
${o.button ? `<tr><td align="center" style="padding:6px 28px 26px"><a href="${esc(o.button.url)}" style="display:inline-block;background:#D4AF6A;color:#060D1F;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:999px;font-size:16px">${esc(o.button.label)}</a></td></tr>` : ""}
<tr><td style="padding:16px 28px 26px;font-size:12px;line-height:1.5;color:#9AA6BF;border-top:1px solid #2A3A5C">${t.why} ${t.pref}<br>Side by Side — Zyntell, 14 rue de Binche, 76150 Maromme, France · contact@zyntell.fr</td></tr>
</table></td></tr></table></body></html>`;
}

export function mailFor(kind: string, lang: string | null | undefined, body: string, firstName?: string | null) {
  const lg = L(lang), subject = (SUBJ[kind] ?? SUBJ.default)[lg];
  return { subject, html: brandedHtml({ lang: lg, title: subject, body, firstName, button: { label: UI[lg].open, url: APP_LINK } }), text: `${subject}\n\n${body}\n\n${UI[lg].why}` };
}

export const mailReady = () => !!Deno.env.get("RESEND_API_KEY");
export async function sendMail(to: string, m: { subject: string; html: string; text: string }) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { sent: false, reason: "non configuré" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("MAIL_FROM") ?? "Side by Side <no-reply@zyntell.fr>", to: [to], subject: m.subject, html: m.html, text: m.text }),
  });
  return { sent: r.ok, reason: r.ok ? "" : `Resend ${r.status}` };
}
