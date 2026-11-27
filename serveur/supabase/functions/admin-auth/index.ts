// Connexion à l'espace de gestion (sidebyside.zyntell.fr/gestion)
// - mot de passe puis code TOTP (Google Authenticator) obligatoires
// - 5 échecs (mot de passe ou code) : compte bloqué 15 minutes, équipe et titulaire alertés
// - chaque connexion, échec, blocage, déconnexion et nouvel appareil est inscrit dans le journal (sans jamais le mot de passe)
// - nouvelle saisie du code avant toute opération sensible (step-up)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { admin, json, serve, HttpError, requireAdmin, authEvent, endAdminSession, jwtPayload, clientIp, clientUa, notifyAdmins, audit, currentUser } from "../_shared/clients.ts";
import { brandedHtml, mailReady, sendMail } from "../_shared/mailer.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const MAX_FAILS = 5, LOCK_MIN = 15;
const GENERIC = "Identifiants incorrects.";
const anonClient = () => createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase().slice(0, 200);

async function lockState(email: string) {
  const { data } = await admin.from("admin_lockouts").select("*").eq("email", email).maybeSingle();
  const until = data?.locked_until ? Date.parse(data.locked_until) : 0;
  return { locked: until > Date.now(), minutes: Math.max(1, Math.ceil((until - Date.now()) / 60000)), fails: data?.fails ?? 0 };
}
async function securityMail(userId: string | null, subject: string, body: string) {
  if (!mailReady()) return;
  const { data: acc } = await admin.from("admin_accounts").select("user_id, level").is("revoked_at", null);
  const ids = new Set<string>((acc ?? []).filter((a: any) => a.level === "super").map((a: any) => a.user_id));
  if (userId) ids.add(userId);
  for (const id of ids) {
    const { data: u } = await admin.auth.admin.getUserById(id);
    const to = u?.user?.email;
    if (to) await sendMail(to, { subject, html: brandedHtml({ lang: "fr", title: subject, body }), text: `${subject}\n\n${body}` }).catch(() => {});
  }
}
// Échec : compteur par adresse e-mail, blocage temporaire au 5e échec
async function fail(req: Request, email: string, userId: string | null, ev: "login_fail" | "mfa_fail" | "stepup_fail") {
  await authEvent(ev, { user_id: userId, email, req });
  const { data } = await admin.from("admin_lockouts").select("fails").eq("email", email).maybeSingle();
  const fails = (data?.fails ?? 0) + 1;
  if (fails >= MAX_FAILS) {
    await admin.from("admin_lockouts").upsert({ email, fails: 0, locked_until: new Date(Date.now() + LOCK_MIN * 60_000).toISOString(), updated_at: new Date().toISOString() });
    await authEvent("locked", { user_id: userId, email, req });
    if (userId) {
      const { data: sess } = await admin.from("admin_sessions").select("session_id").eq("user_id", userId).is("ended_at", null);
      for (const s of sess ?? []) await endAdminSession(s.session_id, "blocage");
    }
    const msg = `Alerte sécurité : ${MAX_FAILS} échecs de connexion pour ${email}. Accès bloqué ${LOCK_MIN} minutes (adresse IP ${clientIp(req) ?? "inconnue"}).`;
    await notifyAdmins(msg, null, "securite");
    await securityMail(userId, "Alerte sécurité : accès administrateur bloqué", msg);
  } else {
    await admin.from("admin_lockouts").upsert({ email, fails, updated_at: new Date().toISOString() });
    if (fails === 3) await notifyAdmins(`Alerte sécurité : 3 échecs de connexion consécutifs pour ${email}.`, null, "securite");
  }
}
async function isActiveAdmin(userId: string) {
  const { data: p } = await admin.from("profiles").select("role, suspended").eq("id", userId).maybeSingle();
  const { data: a } = await admin.from("admin_accounts").select("level, revoked_at, must_change_password").eq("user_id", userId).maybeSingle();
  return p?.role === "admin" && !p.suspended && a && !a.revoked_at ? a : null;
}
// Mot de passe administrateur fort : 14 caractères, minuscule, majuscule, chiffre, symbole, et absent des fuites connues
async function passwordProblem(pw: string, email: string) {
  if (pw.length < 14) return "14 caractères minimum.";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) return "Utilisez des minuscules, des majuscules, des chiffres et des symboles.";
  if (email && pw.toLowerCase().includes(email.split("@")[0])) return "Le mot de passe ne doit pas contenir votre identifiant.";
  try {   // Have I Been Pwned (gratuit, anonyme : seuls les 5 premiers caractères de l'empreinte SHA-1 sont envoyés)
    const h = [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(pw)))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    const r = await fetch(`https://api.pwnedpasswords.com/range/${h.slice(0, 5)}`, { signal: AbortSignal.timeout(3000) });
    if (r.ok && (await r.text()).split("\n").some((l) => l.split(":")[0] === h.slice(5))) return "Ce mot de passe figure dans des fuites de données connues : choisissez-en un autre.";
  } catch (_) { /* service indisponible : contrôle local uniquement */ }
  return null;
}
const sessionOut = (s: any) => ({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at });

serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  switch (body.action) {
    // 1. Mot de passe
    case "login": {
      const email = normEmail(body.email), password = String(body.password ?? "");
      if (!email || !password) throw new HttpError(400, GENERIC);
      const st = await lockState(email);
      if (st.locked) { await authEvent("refused", { email, req }); throw new HttpError(423, `Accès bloqué après plusieurs échecs. Réessayez dans ${st.minutes} min.`); }
      const c = anonClient();
      const { data, error } = await c.auth.signInWithPassword({ email, password });
      if (error || !data.session) { await fail(req, email, null, "login_fail"); throw new HttpError(401, GENERIC); }
      const acc = await isActiveAdmin(data.user.id);
      if (!acc) {   // compte existant mais non administrateur : même réponse qu'un mauvais mot de passe
        await c.auth.signOut({ scope: "local" }).catch(() => {});   // ne ferme que cette tentative, pas l'application mobile du membre
        await fail(req, email, data.user.id, "login_fail");
        throw new HttpError(401, GENERIC);
      }
      await authEvent("login_ok", { user_id: data.user.id, email, req });
      const { data: f } = await c.auth.mfa.listFactors();
      const verified = (f?.totp ?? []).find((x: any) => x.status === "verified");
      return json({ ok: true, session: sessionOut(data.session), totp: verified ? { factor_id: verified.id } : null, level: acc.level });
    }
    // 2. Code TOTP (première activation ou connexion) : ouvre la session de gestion
    case "mfa_verify": {
      const c = anonClient();
      const { error: se } = await c.auth.setSession({ access_token: String(body.access_token ?? ""), refresh_token: String(body.refresh_token ?? "") });
      if (se) throw new HttpError(401, "Session expirée : reconnectez-vous.");
      const { data: u } = await c.auth.getUser();
      if (!u?.user) throw new HttpError(401, "Session expirée : reconnectez-vous.");
      const email = normEmail(u.user.email), uid = u.user.id;
      const acc = await isActiveAdmin(uid);
      if (!acc) throw new HttpError(403, "Accès réservé à l'équipe Side by Side");
      const st = await lockState(email);
      if (st.locked) throw new HttpError(423, `Accès bloqué après plusieurs échecs. Réessayez dans ${st.minutes} min.`);
      const { data: f } = await c.auth.mfa.listFactors();
      const factor = (f?.all ?? []).find((x: any) => x.factor_type === "totp" && (body.factor_id ? x.id === body.factor_id : x.status === "verified"));
      if (!factor) throw new HttpError(400, "Aucune application d'authentification associée.");
      const code = String(body.code ?? "").replace(/\D/g, "");
      const { data: v, error } = code.length === 6 ? await c.auth.mfa.challengeAndVerify({ factorId: factor.id, code }) : { data: null, error: { message: "format" } };
      if (error || !v) { await fail(req, email, uid, "mfa_fail"); throw new HttpError(401, "Code incorrect."); }
      const tok = (v as any).access_token;
      const sid = String(jwtPayload(tok).session_id ?? "");
      if (!sid) throw new HttpError(500, "Session invalide");
      await admin.from("admin_sessions").upsert({ session_id: sid, user_id: uid, last_seen_at: new Date().toISOString(), stepup_at: new Date().toISOString(), ip: clientIp(req), user_agent: clientUa(req), ended_at: null, end_reason: null });
      await admin.from("admin_lockouts").upsert({ email, fails: 0, locked_until: null, updated_at: new Date().toISOString() });
      // Nouvel appareil : navigateur jamais vu pour ce compte depuis 180 jours
      const { data: seen } = await admin.from("admin_auth_events").select("id").eq("user_id", uid).eq("event", "mfa_ok").eq("user_agent", clientUa(req) ?? "").gte("created_at", new Date(Date.now() - 180 * 86_400_000).toISOString()).limit(1);
      const { count: before } = await admin.from("admin_auth_events").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("event", "mfa_ok");
      await authEvent("mfa_ok", { user_id: uid, email, req });
      if ((before ?? 0) > 0 && !(seen ?? []).length) {
        await authEvent("new_device", { user_id: uid, email, req });
        const msg = `Connexion à l'espace de gestion depuis un nouvel appareil pour ${email} (adresse IP ${clientIp(req) ?? "inconnue"}). Si ce n'est pas vous, prévenez immédiatement le dirigeant.`;
        await notifyAdmins(msg, null, "securite");
        await securityMail(uid, "Alerte sécurité : nouvelle connexion administrateur", msg);
      }
      return json({ ok: true, session: sessionOut(v), level: acc.level, must_change_password: acc.must_change_password });
    }
    // 3. Nouvelle authentification avant une opération sensible
    case "stepup": {
      const me = await requireAdmin(req);
      const c = anonClient();
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
      const { error: se } = await c.auth.setSession({ access_token: token, refresh_token: String(body.refresh_token ?? "") });
      if (se) throw new HttpError(401, "Session expirée : reconnectez-vous.");
      const { data: f } = await c.auth.mfa.listFactors();
      const factor = (f?.totp ?? []).find((x: any) => x.status === "verified");
      const code = String(body.code ?? "").replace(/\D/g, "");
      const { data: v, error } = factor && code.length === 6 ? await c.auth.mfa.challengeAndVerify({ factorId: factor.id, code }) : { data: null, error: { message: "code" } };
      if (error || !v) { await fail(req, normEmail(me.email), me.id, "stepup_fail"); throw new HttpError(401, "Code incorrect."); }
      await admin.from("admin_sessions").update({ stepup_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq("session_id", me.session_id);
      await authEvent("stepup_ok", { user_id: me.id, email: me.email, req });
      return json({ ok: true, session: sessionOut(v) });
    }
    // 4. Changement du mot de passe (obligatoire à la première connexion d'un administrateur créé par le dirigeant)
    case "change_password": {
      const me = await requireAdmin(req);
      const pw = String(body.password ?? "");
      const pb = await passwordProblem(pw, normEmail(me.email));
      if (pb) throw new HttpError(400, pb);
      const { error } = await admin.auth.admin.updateUserById(me.id, { password: pw });
      if (error) throw new HttpError(400, "Mot de passe refusé : choisissez-en un autre.");
      await admin.from("admin_accounts").update({ must_change_password: false }).eq("user_id", me.id);
      await authEvent("password_changed", { user_id: me.id, email: me.email, req });
      await audit(me.id, "Mot de passe administrateur modifié", me.id);
      return json({ ok: true });
    }
    // 5. Déconnexion (volontaire ou après inactivité constatée par le navigateur)
    case "logout": {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
      const sid = String(jwtPayload(token).session_id ?? "");
      try {
        const me = await currentUser(req);
        if (sid) await endAdminSession(sid, body.reason === "inactivite" ? "inactivite" : "deconnexion");
        await authEvent(body.reason === "inactivite" ? "timeout" : "logout", { user_id: me.id, email: me.email, req });
        await admin.auth.admin.signOut(token).catch(() => {});
      } catch (_) { /* jeton déjà expiré : rien à fermer */ }
      return json({ ok: true });
    }
    default: throw new HttpError(400, "Action inconnue");
  }
});
