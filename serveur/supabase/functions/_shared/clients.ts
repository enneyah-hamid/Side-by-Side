// Clients partagés par toutes les fonctions serveur Side by Side
import Stripe from "npm:stripe@14.25.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { KIND_PREF, mailFor, mailReady, sendMail } from "./mailer.ts";

// La clé se règle dans les secrets Supabase. STRIPE_API_HOST ne sert qu'aux tests (serveur Stripe simulé).
const stripeHost = Deno.env.get("STRIPE_API_HOST");
export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "cle-stripe-a-configurer", {
  apiVersion: "2024-06-20" as Stripe.LatestApiVersion,   // version figée du compte (bibliothèque 14.x typée 2023-10-16)
  ...(stripeHost ? { host: stripeHost, port: Number(Deno.env.get("STRIPE_API_PORT") ?? 12111), protocol: "http" as const } : {}),
});
export const stripeReady = () => !!Deno.env.get("STRIPE_SECRET_KEY");

// Client « service » : contourne la RLS, uniquement côté serveur
export const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Origines autorisées : l'application Android (https://localhost), iOS (capacitor://localhost)
// l'espace de gestion (https://sidebyside.zyntell.fr/gestion) et le site web indiqué dans APP_ORIGIN
// (plusieurs adresses séparées par des virgules).
const ORIGINS = new Set(["https://localhost", "capacitor://localhost", "http://localhost", "https://sidebyside.zyntell.fr",
  ...(Deno.env.get("APP_ORIGIN") ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);
export function corsHeaders(req: Request): Record<string, string> {
  const o = req.headers.get("Origin") ?? "";
  return {
    ...(ORIGINS.has(o) ? { "Access-Control-Allow-Origin": o, "Vary": "Origin" } : {}),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
/** @deprecated conservé pour compatibilité : les en-têtes CORS sont ajoutés par serve() */
export const cors = { "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Point d'entrée commun : préflight CORS, erreurs propres, aucun détail technique renvoyé à l'utilisateur
export function serve(fn: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    const h = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: h });
    let res: Response;
    try { res = await fn(req); }
    catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      if (!(e instanceof HttpError)) console.error(e);
      res = json({ error: e instanceof HttpError ? e.message : publicMessage(e) }, status);
    }
    for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
    return res;
  });
}
function publicMessage(e: unknown) {
  const m = (e as Error)?.message ?? "";
  if (/bookings_no_overlap|exclusion/i.test(m)) return "Créneau déjà réservé";
  if (/Code de carte cadeau invalide|Carte cadeau déjà utilisée/.test(m)) return m.match(/(Code de carte cadeau invalide|Carte cadeau déjà utilisée[^"]*)/)![0];
  return "Opération impossible pour le moment. Réessayez.";
}

// Identifie l'utilisateur à partir de son jeton de connexion Supabase
export async function currentUser(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Non connecté");
  const { data: profile } = await admin.from("profiles").select("*").eq("id", data.user.id).single();
  if (!profile || profile.suspended) throw new HttpError(403, "Compte indisponible");
  return { ...profile, aal: jwtClaim(token, "aal") ?? "aal1", email: data.user.email };
}
function jwtClaim(token: string, k: string) {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))[k]; } catch { return null; }
}
// ---------------------------------------------------------------------------------------------
// Espace administrateur (sidebyside.zyntell.fr/gestion)
// Chaque appel exige : rôle admin + compte administrateur actif + double authentification (aal2)
// + session ouverte par l'espace de gestion, active depuis moins de 15 minutes + compte non bloqué.
// ---------------------------------------------------------------------------------------------
export const ADMIN_IDLE_MS = 15 * 60_000;
export const STEPUP_MAX_S = Number(Deno.env.get("ADMIN_STEPUP_SECONDS") ?? 300);   // 5 minutes (raccourci dans les tests)
export function jwtPayload(token: string): Record<string, any> {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; }
}
export const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 64) || null;
export const clientUa = (req: Request) => (req.headers.get("user-agent") ?? "").slice(0, 300) || null;
export async function authEvent(event: string, o: { user_id?: string | null; email?: string | null; req?: Request }) {
  await admin.from("admin_auth_events").insert({ event, user_id: o.user_id ?? null, email: o.email ? o.email.toLowerCase() : null,
    ip: o.req ? clientIp(o.req) : null, user_agent: o.req ? clientUa(o.req) : null });
}
export async function endAdminSession(sessionId: string, reason: string) {
  await admin.from("admin_sessions").update({ ended_at: new Date().toISOString(), end_reason: reason }).eq("session_id", sessionId).is("ended_at", null);
}
export async function requireAdmin(req: Request, opts: { touch?: boolean } = {}) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  const me = await currentUser(req);
  if (me.role !== "admin") throw new HttpError(403, "Accès réservé à l'équipe Side by Side");
  if (me.aal !== "aal2") throw new HttpError(403, "Double authentification requise");
  const p = jwtPayload(token);
  const { data: acc } = await admin.from("admin_accounts").select("level, revoked_at, must_change_password").eq("user_id", me.id).maybeSingle();
  if (!acc || acc.revoked_at) throw new HttpError(403, "Accès réservé à l'équipe Side by Side");
  const { data: lock } = await admin.from("admin_lockouts").select("locked_until").eq("email", (me.email ?? "").toLowerCase()).maybeSingle();
  if (lock?.locked_until && Date.parse(lock.locked_until) > Date.now()) throw new HttpError(423, "Compte temporairement bloqué après plusieurs échecs.");
  const sid = String(p.session_id ?? "");
  const { data: s } = sid ? await admin.from("admin_sessions").select("*").eq("session_id", sid).eq("user_id", me.id).maybeSingle() : { data: null };
  if (!s || s.ended_at) throw new HttpError(401, "Session expirée : reconnectez-vous.");
  if (Date.now() - Date.parse(s.last_seen_at) > ADMIN_IDLE_MS) {
    await endAdminSession(sid, "inactivite");
    await authEvent("timeout", { user_id: me.id, email: me.email, req });
    throw new HttpError(401, "Session fermée après 15 minutes d'inactivité : reconnectez-vous.");
  }
  if (opts.touch !== false) await admin.from("admin_sessions").update({ last_seen_at: new Date().toISOString() }).eq("session_id", sid);
  return { ...me, level: acc.level as "super" | "admin", must_change_password: !!acc.must_change_password, session_id: sid, amr: (p.amr ?? []) as { method: string; timestamp: number }[] };
}
export type AdminCtx = Awaited<ReturnType<typeof requireAdmin>>;
export function requireSuper(me: AdminCtx) {
  if (me.level !== "super") throw new HttpError(403, "Action réservée au super-administrateur (dirigeant)");
}
// Opération sensible : un code TOTP doit avoir été saisi il y a moins de 5 minutes (nouvelle authentification)
export function requireStepUp(me: AdminCtx) {
  const t = Math.max(0, ...me.amr.filter((x: { method: string; timestamp: number }) => x.method === "totp").map((x: { method: string; timestamp: number }) => Number(x.timestamp) || 0));
  if (!t || Date.now() / 1000 - t > STEPUP_MAX_S) throw new HttpError(428, "Confirmation requise : saisissez un nouveau code de double authentification.");
}
// Pour les fonctions partagées (ex. annulation) : contexte administrateur si l'appel vient de l'espace de gestion, sinon null
export async function adminOrNull(req: Request) {
  try { return await requireAdmin(req); } catch { return null; }
}
// Comparaison à temps constant (clé interne)
export function safeEqual(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
export function requireInternal(req: Request) {
  const k = Deno.env.get("INTERNAL_KEY");
  if (!k || k.length < 24 || !safeEqual(req.headers.get("x-internal-key") ?? "", k)) throw new HttpError(403, "Interdit");
}

export async function event(bookingId: string, status: string | null, actor: string | null, note?: string) {
  await admin.from("booking_events").insert({ booking_id: bookingId, status, actor, note });
}
export async function audit(actor: string | null, action: string, ref?: string | null) {
  await admin.from("audit_log").insert({ actor_id: actor, action: action.slice(0, 500), ref: ref ?? null });
}
// Notification dans l'application (temps réel) ; l'envoi push s'ajoute quand Firebase est configuré.
// E-mail en plus, dans la langue de l'utilisateur et selon ses préférences, dès que l'envoi est configuré.
export async function notify(userId: string | null | undefined, body: string, bookingId?: string | null, kind = "info") {
  if (!userId) return;
  await admin.from("notifications").insert({ user_id: userId, body: body.slice(0, 400), booking_id: bookingId ?? null, kind });
  if (mailReady() && KIND_PREF[kind]) await emailUser(userId, kind, body).catch((e) => console.error("e-mail", e));
}
async function emailUser(userId: string, kind: string, body: string) {
  const { data: p } = await admin.from("profiles").select("first_name, lang, email_prefs, suspended").eq("id", userId).single();
  if (!p || p.suspended || (p.email_prefs ?? {})[KIND_PREF[kind]] === false) return;
  const { data: u } = await admin.auth.admin.getUserById(userId);
  const to = u?.user?.email;
  if (!to || to.endsWith("@invalid.sidebyside")) return;
  await sendMail(to, mailFor(kind, p.lang, body, p.first_name));
}
export async function notifyAdmins(body: string, bookingId?: string | null, kind = "admin") {
  const { data: acc } = await admin.from("admin_accounts").select("user_id").is("revoked_at", null);
  const ids = (acc ?? []).map((a: any) => a.user_id);
  const { data } = ids.length ? await admin.from("profiles").select("id").in("id", ids).eq("role", "admin").eq("suspended", false) : { data: [] as any[] };
  if (data?.length) await admin.from("notifications").insert(data.map((p) => ({ user_id: p.id, body: body.slice(0, 400), booking_id: bookingId ?? null, kind })));
}
// Limite de tentatives (atomique en base)
export async function rateLimit(userId: string, kind: string, max: number, minutes: number) {
  const { data, error } = await admin.rpc("rate_hit", { p_user: userId, p_kind: kind, p_max: max, p_minutes: minutes });
  if (error) throw error;
  if (!data) throw new HttpError(429, "Trop de tentatives. Réessayez plus tard.");
}

export const cents = (eur: number) => Math.round(Number(eur) * 100);
export const r2 = (n: number) => Math.round(n * 100) / 100;
// Statuts où le client a payé
export const PAID = ["confirmee", "controle", "verifie", "en_cours", "fin_declaree", "double_attente", "terminee", "versement", "cloturee", "a_verifier", "incident", "contestee"];
export const rand6 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
export async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
// Transition d'état atomique : ne réussit que si la réservation est encore dans l'état attendu
export async function transition(id: string, from: string[], patch: Record<string, unknown>) {
  const { data, error } = await admin.from("bookings").update(patch).eq("id", id).in("status", from).select();
  if (error) throw error;
  return data?.[0] ?? null;
}
