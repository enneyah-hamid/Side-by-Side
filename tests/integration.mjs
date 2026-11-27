// Tests d'intégration Side by Side — Supabase local (base, RLS, fonctions serveur) + serveur Stripe simulé.
// Aucune transaction réelle : Stripe est remplacé par stripe-mock, les webhooks sont signés localement.
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import crypto from "node:crypto";

const URL = process.env.SB_URL, ANON = process.env.SB_ANON, SERVICE = process.env.SB_SERVICE, IKEY = process.env.INTERNAL_KEY, WHSEC = process.env.STRIPE_WEBHOOK_SECRET;
const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stripe = new Stripe("sk_test_123");
const results = [];
let fails = 0;
function check(id, label, ok, detail = "") {
  results.push({ id, label, ok, detail });
  if (!ok) fails++;
  console.log(`${ok ? "✅" : "❌"} ${id} ${label}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = 3_600_000;

async function user(email, meta, extra = {}) {
  const { data, error } = await svc.auth.admin.createUser({ email, password: "Test-Passw0rd!", email_confirm: true, user_metadata: meta });
  if (error) throw error;
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  await c.auth.signInWithPassword({ email, password: "Test-Passw0rd!" });
  if (Object.keys(extra).length) await svc.from("profiles").update(extra).eq("id", data.user.id);
  return { id: data.user.id, c, email };
}
async function call(u, fn, body, headers = {}) {
  const { data: s } = await u.c.auth.getSession();
  const r = await fetch(`${URL}/functions/v1/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${s.session.access_token}`, ...headers }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (_) {}
  return { status: r.status, ...j };
}
async function internal(fn, body) {
  const r = await fetch(`${URL}/functions/v1/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${ANON}`, "x-internal-key": IKEY }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
async function webhook(evt) {
  const payload = JSON.stringify(evt);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  const r = await fetch(`${URL}/functions/v1/stripe-webhook`, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": header }, body: payload });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const piEvent = (id, pi, type = "payment_intent.succeeded") => ({ id, object: "event", type, data: { object: { object: "payment_intent", currency: "eur", ...pi } } });
const row = async (t, id) => (await svc.from(t).select("*").eq("id", id).single()).data;
const count = async (t, f) => { let q = svc.from(t).select("*", { count: "exact", head: true }); for (const [k, v] of Object.entries(f)) q = q.eq(k, v); return (await q).count; };
const at = (ms) => new Date(Date.now() + ms).toISOString();
// Jour J+n à 10 h UTC (11 h ou 12 h à Paris) : toujours dans les horaires de l'accompagnateur
const day = (n, h = 10) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
// Assurance RC validée (fixture de test) : obligatoire pour être réservable
const insure = (id, days = 400) => svc.from("companion_insurances").insert({ companion_id: id, insurer: "Assureur Test", policy_number: "RC-TEST-1", starts_on: at(-30 * 24 * H).slice(0, 10), ends_on: at(days * 24 * H).slice(0, 10), doc_path: `${id}/attestation.pdf`, covers_paid_activity: true, status: "validee" });
const uniquePi = async (id) => { const pi = `pi_test_${crypto.randomUUID().replace(/-/g, "")}`; await svc.from("bookings").update({ stripe_payment_intent_id: pi }).eq("id", id); return pi; };
// TOTP (RFC 6238) pour la double authentification de l'administrateur
function totp(secret) {
  const b32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = "";
  for (const ch of secret.replace(/=+$/, "")) bits += b32.indexOf(ch.toUpperCase()).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac("sha1", key).update(ctr).digest(), o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, "0");
}
// Espace de gestion : connexion par la fonction admin-auth (mot de passe puis code TOTP), comme le fait /gestion
let lastWin = 0;
async function code(secret) { let w = Math.floor(Date.now() / 30000); if (w <= lastWin) { await sleep((lastWin + 1) * 30000 - Date.now() + 300); w = Math.floor(Date.now() / 30000); } lastWin = w; return totp(secret); }
async function authFn(body, token) {
  const r = await fetch(`${URL}/functions/v1/admin-auth`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${token ?? ANON}`, "User-Agent": "integration-test" }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (_) {}
  return { status: r.status, ...j };
}
async function adminLogin(u, secret, factorId, password = "Test-Passw0rd!") {
  const l = await authFn({ action: "login", email: u.email, password });
  if (!l.session) return l;
  const v = await authFn({ action: "mfa_verify", access_token: l.session.access_token, refresh_token: l.session.refresh_token, code: await code(secret), factor_id: factorId ?? l.totp?.factor_id });
  if (v.session) await u.c.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return v;
}
async function stepup(u, secret) {
  const { data: s } = await u.c.auth.getSession();
  const v = await authFn({ action: "stepup", code: await code(secret), refresh_token: s.session.refresh_token }, s.session.access_token);
  if (v.session) await u.c.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return v;
}
async function confirmedBooking(client, comp, dayN, extra = {}) {
  const r = await call(client, "create-booking", { companion_id: comp.id, category: "shopping", starts_at: day(dayN), hours: 2, place: "Galeries Lafayette, Paris", language: "Français" });
  if (!r.booking) throw new Error("création : " + JSON.stringify(r));
  const b = r.booking;
  await call(comp, "booking-action", { booking_id: b.id, action: "accept" });
  await call(client, "booking-action", { booking_id: b.id, action: "sign" });
  const p = await call(client, "create-payment", { booking_id: b.id });
  if (p.status >= 400) throw new Error("paiement : " + JSON.stringify(p));
  await uniquePi(b.id);
  const cur = await row("bookings", b.id);
  await webhook(piEvent(`evt_${crypto.randomUUID()}`, { id: cur.stripe_payment_intent_id, amount: Math.round(Number(cur.amount_total) * 100), metadata: { booking_id: b.id, kind: "booking" } }));
  if (Object.keys(extra).length) await svc.from("bookings").update(extra).eq("id", b.id);
  return { ...(await row("bookings", b.id)), _pay: p };
}

(async () => {
  // ---------- Comptes ----------
  const base = { last_name: "Test", birth_date: "1990-05-05" };
  const client = await user("client@test.fr", { ...base, first_name: "Sophie", role: "client" }, { identity_verified: true });
  const client2 = await user("client2@test.fr", { ...base, first_name: "Léa", role: "client" }, { identity_verified: true });
  const intrus = await user("intrus@test.fr", { ...base, first_name: "Marc", role: "client" }, { identity_verified: true });
  const comp = await user("camille@test.fr", { ...base, first_name: "Camille", role: "companion", non_circumvention: true }, { identity_verified: true });
  const adm = await user("admin@test.fr", { ...base, first_name: "Hamid", role: "admin" });
  const fake = await user("faux-admin@test.fr", { ...base, first_name: "Pirate", role: "admin" });
  check("A01", "Inscription avec le rôle « admin » demandé → compte client", (await row("profiles", fake.id)).role === "client");
  await svc.from("profiles").update({ role: "admin" }).eq("id", adm.id);
  await svc.from("admin_accounts").insert({ user_id: adm.id, level: "super", must_change_password: false });   // dirigeant (super-administrateur)
  await svc.from("companions").update({ verified: true, video_interview_ok: true, categories: ["shopping"], hour_from: 0, hour_to: 24, stripe_account_id: "acct_test123", payouts_enabled: true }).eq("id", comp.id);
  await insure(comp.id);
  const minor = await svc.auth.admin.createUser({ email: "mineur@test.fr", password: "Test-Passw0rd!", email_confirm: true, user_metadata: { first_name: "Jeune", last_name: "T", birth_date: at(-16 * 365 * 24 * H).slice(0, 10), role: "client" } });
  check("A02", "Inscription d'une personne de moins de 18 ans refusée par la base", !!minor.error);

  // ---------- Réservation ----------
  const B = (body, u = client) => call(u, "create-booking", { companion_id: comp.id, category: "shopping", hours: 2, place: "Musée d'Orsay, Paris", ...body });
  let r = await B({ starts_at: at(3 * H) });
  check("R01", "Réservation à moins de 24 h refusée", r.status === 400, r.error);
  r = await B({ starts_at: day(2), annex: -50 });
  check("R02", "Frais annexes négatifs refusés", r.status === 400, r.error);
  r = await B({ starts_at: day(2), hours: 1.5 });
  check("R03", "Durée non entière refusée", r.status === 400, r.error);
  r = await call(comp, "create-booking", { companion_id: comp.id, category: "shopping", hours: 2, place: "Paris centre", starts_at: day(15) });
  check("R04", "Un accompagnateur ne peut pas se réserver lui-même", r.status >= 400, r.error);
  const unverified = await user("nonverifie@test.fr", { ...base, first_name: "Paul", role: "client" });
  r = await B({ starts_at: day(16) }, unverified);
  check("R05", "Réservation sans identité vérifiée refusée", r.status === 403, r.error);
  const slot = day(3);
  const par = await Promise.all(Array.from({ length: 10 }, () => B({ starts_at: slot }, client2)));
  check("R06", "10 demandes simultanées du même créneau → 1 seule acceptée", par.filter((x) => x.booking).length === 1, `${par.filter((x) => x.booking).length} acceptée(s), ${par.filter((x) => x.status === 409).length} refus « créneau déjà réservé »`);
  r = await B({ starts_at: new Date(Date.parse(slot) + H).toISOString() });
  check("R07", "Demande qui chevauche un créneau pris refusée", r.status === 409, r.error);
  r = await B({ starts_at: day(4), annex: 30 });
  const b1 = r.booking;
  check("R08", "Réservation valide créée, prix calculé par le serveur", !!b1 && Number(b1.amount_total) > Number(b1.amount_service), b1 ? `total ${b1.amount_total} €` : JSON.stringify(r));

  // ---------- Acceptation ----------
  r = await call(intrus, "booking-action", { booking_id: b1.id, action: "accept" });
  check("S01", "Une personne étrangère à la réservation ne peut pas l'accepter", r.status === 404);
  r = await call(client, "booking-action", { booking_id: b1.id, action: "accept" });
  check("S02", "Le client ne peut pas accepter sa propre demande", r.status === 409);
  const acc = await Promise.all([1, 2, 3].map(() => call(comp, "booking-action", { booking_id: b1.id, action: "accept" })));
  check("S03", "Acceptation envoyée 3 fois en même temps → traitée une fois", acc.filter((x) => x.ok).length === 1 && (await count("booking_events", { booking_id: b1.id, status: "acceptee" })) === 1);
  r = await call(client, "create-payment", { booking_id: b1.id });
  check("S04", "Paiement refusé avant signature de la fiche de mission", r.status === 409, r.error);
  await call(client, "booking-action", { booking_id: b1.id, action: "sign" });

  // ---------- Paiement ----------
  const pays = await Promise.all(Array.from({ length: 5 }, () => call(client, "create-payment", { booking_id: b1.id })));
  const b1p = await row("bookings", b1.id);
  check("P01", "5 demandes de paiement simultanées → un seul paiement Stripe créé", pays.filter((x) => x.client_secret).length >= 1 && pays.filter((x) => x.status === 409 || x.client_secret).length === 5 && !!b1p.stripe_payment_intent_id,
    `${pays.filter((x) => x.client_secret).length} réponse(s) avec paiement, ${pays.filter((x) => x.status === 409).length} « paiement déjà en cours »`);
  r = await call(intrus, "create-payment", { booking_id: b1.id });
  check("P02", "Payer la réservation d'un autre est impossible", r.status === 404);
  b1p.stripe_payment_intent_id = await uniquePi(b1.id);
  const amount = Math.round(Number(b1p.amount_total) * 100);
  r = await webhook(piEvent("evt_bad_sig", { id: b1p.stripe_payment_intent_id, amount, metadata: { booking_id: b1.id } })).then(() => fetch(`${URL}/functions/v1/stripe-webhook`, { method: "POST", headers: { "stripe-signature": "t=1,v1=faux" }, body: "{}" }));
  check("W01", "Webhook avec fausse signature rejeté", r.status === 400);
  const evt = piEvent("evt_dup_1", { id: b1p.stripe_payment_intent_id, amount, metadata: { booking_id: b1.id, kind: "booking" } });
  const ws = await Promise.all(Array.from({ length: 6 }, () => webhook(evt)));
  const b1c = await row("bookings", b1.id);
  check("W02", "Même confirmation de paiement reçue 6 fois → une seule confirmation", b1c.status === "confirmee" && (await count("ledger", { booking_id: b1.id, kind: "Encaissement" })) === 1 && (await count("booking_events", { booking_id: b1.id, status: "confirmee" })) === 1,
    `statuts HTTP ${[...new Set(ws.map((x) => x.status))].join(",")}, encaissements : ${await count("ledger", { booking_id: b1.id, kind: "Encaissement" })}`);
  check("W03", "Aucun remboursement automatique déclenché par les doublons", (await count("ledger", { booking_id: b1.id, kind: "Remboursement automatique" })) === 0);
  check("W04", "Code de rencontre et code de détresse créés au paiement", (await count("booking_secrets", { booking_id: b1.id })) === 1);
  await webhook(piEvent("evt_second_pi", { id: "pi_second_payment", amount, metadata: { booking_id: b1.id, kind: "booking" } }));
  check("W05", "Second paiement pour la même réservation → remboursé automatiquement", (await count("ledger", { booking_id: b1.id, kind: "Remboursement automatique" })) === 1);
  const sec = await svc.from("booking_secrets").select("*").eq("booking_id", b1.id).single();
  const { data: leak, error: leakErr } = await client.c.from("booking_secrets").select("*");
  check("W06", "Le code de rencontre n'est pas lisible directement dans la base par un membre", !!leakErr || !leak?.length);

  // Montant falsifié
  const r9 = await B({ starts_at: day(5) });
  await call(comp, "booking-action", { booking_id: r9.booking.id, action: "accept" });
  await call(client, "booking-action", { booking_id: r9.booking.id, action: "sign" });
  await call(client, "create-payment", { booking_id: r9.booking.id });
  await uniquePi(r9.booking.id);
  const b9 = await row("bookings", r9.booking.id);
  await webhook(piEvent("evt_low_amount", { id: b9.stripe_payment_intent_id, amount: 100, metadata: { booking_id: b9.id, kind: "booking" } }));
  check("W07", "Paiement d'un montant inférieur → réservation non confirmée, paiement remboursé", (await row("bookings", b9.id)).status === "acceptee" && (await count("ledger", { booking_id: b9.id, kind: "Remboursement automatique" })) === 1);

  // ---------- Carte cadeau ----------
  await svc.from("gift_cards").insert({ code: "CADEAU30", amount: 30, balance: 30 });
  const g1 = await B({ starts_at: day(6) }), g2 = await B({ starts_at: day(7) });
  for (const g of [g1, g2]) { await call(comp, "booking-action", { booking_id: g.booking.id, action: "accept" }); await call(client, "booking-action", { booking_id: g.booking.id, action: "sign" }); }
  await Promise.all([call(client, "create-payment", { booking_id: g1.booking.id, gift_code: "cadeau30" }), call(client, "create-payment", { booking_id: g2.booking.id, gift_code: "CADEAU30" })]);
  const holds = (await svc.from("gift_holds").select("amount").eq("code", "CADEAU30")).data;
  const card = (await svc.from("gift_cards").select("balance, owner_id").eq("code", "CADEAU30").single()).data;
  check("G01", "Carte de 30 € utilisée simultanément sur 2 réservations → 30 € au total", holds.reduce((a, x) => a + Number(x.amount), 0) === 30 && Number(card.balance) === 0, `réservé : ${holds.map((x) => x.amount).join(" + ")} €, solde ${card.balance} €`);
  check("G02", "Carte rattachée au premier compte qui l'utilise", card.owner_id === client.id);
  await svc.from("gift_cards").insert({ code: "AUTRE20", amount: 20, balance: 20, owner_id: client.id });
  const g3 = await B({ starts_at: day(8) }, client2);
  await call(comp, "booking-action", { booking_id: g3.booking.id, action: "accept" }); await call(client2, "booking-action", { booking_id: g3.booking.id, action: "sign" });
  r = await call(client2, "create-payment", { booking_id: g3.booking.id, gift_code: "AUTRE20" });
  check("G03", "Carte appartenant à quelqu'un d'autre refusée", r.status === 400, r.error);
  const brute = []; for (let i = 0; i < 12; i++) brute.push(await call(client2, "create-payment", { booking_id: g3.booking.id, gift_code: `FAUX${i}` }));
  check("G04", "Essais de codes cadeaux limités (10 par heure)", brute.some((x) => x.status === 429), `${brute.filter((x) => x.status === 429).length} essai(s) bloqué(s)`);
  const holder = (await svc.from("gift_holds").select("booking_id, amount").eq("code", "CADEAU30").eq("status", "held").single()).data;
  r = await call(client, "refund-booking", { booking_id: holder.booking_id });
  const after = (await svc.from("gift_cards").select("balance").eq("code", "CADEAU30").single()).data;
  check("G05", "Annulation avant paiement → solde de la carte rendu", r.ok && Number(after.balance) === Number(holder.amount), `solde ${after.balance} € (réservé ${holder.amount} €)`);
  r = await call(client, "refund-booking", { booking_id: holder.booking_id });
  const after2 = (await svc.from("gift_cards").select("balance").eq("code", "CADEAU30").single()).data;
  check("G06", "Seconde annulation : la carte n'est pas créditée deux fois", r.status === 409 && Number(after2.balance) === Number(holder.amount));

  // ---------- Remboursement ----------
  const rf = await Promise.all(Array.from({ length: 5 }, () => call(client, "refund-booking", { booking_id: b1.id })));
  check("F01", "Annulation envoyée 5 fois en même temps → un seul remboursement", rf.filter((x) => x.ok).length === 1 && (await count("ledger", { booking_id: b1.id, kind: "Remboursement" })) === 1, `remboursé : ${rf.find((x) => x.ok)?.refund} € (${rf.find((x) => x.ok)?.pct} %)`);

  // ---------- Déroulement de mission ----------
  const m = await confirmedBooking(client, comp, 9);
  await svc.from("bookings").update({ starts_at: at(30 * 60_000) }).eq("id", m.id);
  r = await call(client, "mission-action", { booking_id: m.id, action: "get_code" });
  const code = r.code, distress = r.distress;
  check("M01", "Le client obtient son code de rencontre et son code de détresse", /^\d{6}$/.test(code ?? "") && /^\d{6}$/.test(distress ?? "") && code !== distress);
  r = await call(comp, "mission-action", { booking_id: m.id, action: "get_code" });
  check("M02", "L'accompagnateur ne peut pas lire le code du client", r.status === 409);
  const pres = await Promise.all([call(client, "mission-action", { booking_id: m.id, action: "presence" }), call(comp, "mission-action", { booking_id: m.id, action: "presence" })]);
  check("M03", "Confirmation de présence 1 h avant (les deux)", pres.every((x) => x.ok) && (await row("bookings", m.id)).status === "controle");
  r = await call(client, "mission-action", { booking_id: m.id, action: "verify_code", code });
  check("M04", "Le code est saisi par l'accompagnateur, pas par le client", r.status === 403);
  r = await call(comp, "mission-action", { booking_id: m.id, action: "verify_code", code: "000000" });
  check("M05", "Code faux refusé avec essais restants", r.status === 400 && /4 essai/.test(r.error), r.error);
  const vv = await Promise.all([1, 2, 3].map(() => call(comp, "mission-action", { booking_id: m.id, action: "verify_code", code })));
  check("M06", "Code juste envoyé 3 fois en même temps → utilisé une seule fois", vv.filter((x) => x.ok).length === 1 && (await row("bookings", m.id)).status === "verifie");
  r = await call(comp, "mission-action", { booking_id: m.id, action: "start" });
  check("M07", "Début validé par un seul → mission pas encore commencée", r.ok && r.started === false && (await row("bookings", m.id)).status === "verifie");
  r = await call(client, "mission-action", { booking_id: m.id, action: "start" });
  check("M08", "Début validé par les deux → mission en cours", r.started === true && (await row("bookings", m.id)).status === "en_cours");
  r = await call(client, "mission-action", { booking_id: m.id, action: "end" });
  check("M09", "Fin déclarée par le client seul → double validation en attente, aucun versement", r.finished === false && (await row("bookings", m.id)).status === "double_attente" && (await count("ledger", { booking_id: m.id, kind: "Versement" })) === 0);
  r = await call(client, "mission-action", { booking_id: m.id, action: "end" });
  check("M10", "Le client ne peut pas confirmer deux fois", r.status === 409);
  r = await call(comp, "mission-action", { booking_id: m.id, action: "end" });
  const mEnd = await row("bookings", m.id);
  check("M11", "Fin confirmée par les deux → terminée et versement effectué", r.finished === true && mEnd.status === "cloturee" && !!mEnd.stripe_transfer_id, `statut ${mEnd.status}${mEnd.payout_error ? ` · ${mEnd.payout_error}` : ""}`);
  const rp = await Promise.all(Array.from({ length: 5 }, () => internal("release-payout", { booking_id: m.id })));
  check("V01", "Versement relancé 5 fois en même temps → un seul virement", (await count("ledger", { booking_id: m.id, kind: "Versement" })) === 1, `réponses : ${rp.map((x) => x.already ? "déjà fait" : x.ok ? "ok" : x.reason).join(", ")}`);
  r = await call(client, "release-payout", { booking_id: m.id });
  check("V02", "Un client ne peut pas déclencher un versement", r.status === 403);
  r = await fetch(`${URL}/functions/v1/release-payout`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${ANON}`, "x-internal-key": "mauvaise-cle-mauvaise-cle-123" }, body: JSON.stringify({ booking_id: m.id }) });
  check("V03", "Versement avec une mauvaise clé interne refusé", r.status === 403);

  // Code de détresse
  const d = await confirmedBooking(client, comp, 10);
  await svc.from("bookings").update({ starts_at: at(20 * 60_000) }).eq("id", d.id);
  const dc = await call(client, "mission-action", { booking_id: d.id, action: "get_code" });
  const notifBefore = await count("notifications", { user_id: comp.id });
  r = await call(comp, "mission-action", { booking_id: d.id, action: "verify_code", code: dc.distress });
  const alerts = (await svc.from("safety_alerts").select("*").eq("booking_id", d.id)).data;
  const admNotif = (await svc.from("notifications").select("*").eq("user_id", adm.id).eq("kind", "sos").eq("booking_id", d.id)).data;
  check("D01", "Code de détresse : la rencontre paraît normale", r.ok && (await row("bookings", d.id)).status === "verifie");
  check("D02", "Code de détresse : alerte silencieuse enregistrée et administrateur prévenu", alerts.length === 1 && admNotif.length === 1, alerts[0]?.kind);
  check("D03", "Code de détresse : l'accompagnateur ne reçoit aucune alerte visible", (await count("notifications", { user_id: comp.id })) === notifBefore);
  await svc.from("bookings").update({ status: "cloturee" }).eq("id", d.id);   // libère le créneau pour le test suivant
  // Blocage après 5 essais
  const k = await confirmedBooking(client, comp, 11);
  await svc.from("bookings").update({ starts_at: at(20 * 60_000) }).eq("id", k.id);
  const tries = []; for (let i = 0; i < 6; i++) tries.push(await call(comp, "mission-action", { booking_id: k.id, action: "verify_code", code: "111111" }));
  const kc = await call(client, "mission-action", { booking_id: k.id, action: "get_code" });
  r = await call(comp, "mission-action", { booking_id: k.id, action: "verify_code", code: kc.code ?? "123456" });
  check("D04", "Code bloqué après 5 essais faux, même le bon code est ensuite refusé", tries[4].status === 423 && r.status >= 400);
  // SOS et interruption
  r = await call(client, "sos", { booking_id: k.id, kind: "sos", latitude: 48.8566, longitude: 2.3522 });
  check("O01", "SOS enregistré, administrateur prévenu, numéro d'urgence renvoyé", r.ok && r.emergency_number === "112" && (await count("notifications", { user_id: adm.id, kind: "sos", booking_id: k.id })) >= 1);
  r = await call(intrus, "sos", { booking_id: k.id });
  check("O02", "SOS sur la réservation d'un autre refusé", r.status === 404);
  r = await call(comp, "mission-action", { booking_id: k.id, action: "interrupt" });
  check("O03", "Interruption de mission pour sécurité → statut incident, dossier ouvert, versement gelé", r.ok && (await row("bookings", k.id)).status === "incident" && (await count("disputes", { booking_id: k.id })) === 1);

  // Fin non confirmée → « À vérifier » par le planificateur
  const nv = await confirmedBooking(client, comp, 12);
  await svc.from("bookings").update({ status: "en_cours", starts_at: at(-6 * H), end_client: at(-3 * H) }).eq("id", nv.id);
  const sw = await internal("sweeper", {});
  check("T01", "Fin confirmée par une seule partie depuis plus de 2 h → « À vérifier » + dossier", (await row("bookings", nv.id)).status === "a_verifier" && (await count("disputes", { booking_id: nv.id })) === 1, JSON.stringify(sw));
  const ex = await B({ starts_at: day(13) });
  await svc.from("bookings").update({ starts_at: at(5 * H) }).eq("id", ex.booking.id);
  await internal("sweeper", {});
  check("T02", "Demande sans réponse à moins de 12 h → expirée, créneau libéré", (await row("bookings", ex.booking.id)).status === "expiree");
  r = await internal("sweeper", {}).then(() => fetch(`${URL}/functions/v1/sweeper`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${ANON}` }, body: "{}" }));
  check("T03", "Planificateur inaccessible sans clé interne", r.status === 403);

  // ---------- Administration ----------
  r = await call(adm, "admin-action", { action: "overview" });
  check("K01", "Administrateur SANS double authentification refusé", r.status === 403, r.error);
  r = await call(client, "admin-action", { action: "overview" });
  check("K02", "Client refusé dans l'espace administrateur", r.status === 403);
  const { data: enr, error: enrErr } = await adm.c.auth.mfa.enroll({ factorType: "totp", friendlyName: "test" });
  if (enrErr) console.log("MFA enroll", enrErr.message);
  const ADM_SECRET = enr.totp.secret;
  const { data: ch } = await adm.c.auth.mfa.challenge({ factorId: enr.id });
  await adm.c.auth.mfa.verify({ factorId: enr.id, challengeId: ch.id, code: await code(ADM_SECRET) });
  r = await call(adm, "admin-action", { action: "overview" });
  check("K10", "TOTP validé hors espace de gestion (appel direct au service d'authentification) → refusé : aucune session de gestion", r.status === 401, r.error);
  const lg = await adminLogin(adm, ADM_SECRET);
  // Appel administrateur : nouvelle saisie du code si l'opération est sensible (428), reconnexion si la session a expiré (401)
  var callA = async (fn, body) => { let x = await call(adm, fn, body); if (x.status === 428) { await stepup(adm, ADM_SECRET); x = await call(adm, fn, body); } else if (x.status === 401) { await adminLogin(adm, ADM_SECRET); x = await call(adm, fn, body); } return x; };
  r = await call(adm, "admin-action", { action: "overview" });
  check("K03", "Administrateur connecté par l'espace de gestion (mot de passe + TOTP) accepté", !!lg.session && r.status === 200, lg.error ?? `${r.review?.length ?? 0} dossier(s) à vérifier`);
  await unverified.c.storage.from("documents").upload(`${unverified.id}/piece.jpg`, new Blob([new Uint8Array([255, 216, 255, 224])], { type: "image/jpeg" }));
  const { error: idErr } = await unverified.c.from("identity_checks").insert({ user_id: unverified.id, doc_path: `${unverified.id}/piece.jpg` });
  const ov = await call(adm, "admin-action", { action: "overview" });
  const chk = ov.identity?.find((x) => x.user_id === unverified.id);
  check("K04", "Pièce d'identité déposée → visible par l'admin avec lien temporaire", !idErr && !!chk?.doc_url, idErr?.message);
  r = await call(adm, "admin-action", { action: "identity_review", check_id: chk?.id, approve: true });
  check("K05", "Validation de l'identité par l'admin → le membre peut réserver", r.ok && (await row("profiles", unverified.id)).identity_verified === true);
  const disp = (await svc.from("disputes").select("id").eq("booking_id", nv.id).single()).data;
  await stepup(adm, ADM_SECRET);
  r = await call(adm, "admin-action", { action: "dispute_decide", dispute_id: disp.id, decision: "payout", note: "Prestation confirmée par les messages" });
  check("K06", "Litige tranché « versement » → versement exécuté une fois", r.ok && (await count("ledger", { booking_id: nv.id, kind: "Versement" })) === 1);
  r = await call(adm, "admin-action", { action: "dispute_decide", dispute_id: disp.id, decision: "payout", note: "Second clic" });
  check("K07", "Même litige tranché deux fois → refusé", r.status === 409);
  await stepup(adm, ADM_SECRET);
  r = await call(adm, "admin-action", { action: "suspend", user_id: intrus.id, suspended: true, reason: "Harcèlement signalé" });
  const rs = await call(intrus, "create-booking", { companion_id: comp.id, category: "shopping", hours: 2, place: "Paris centre", starts_at: day(14) });
  check("K08", "Compte suspendu par l'admin → plus aucune action possible", r.ok && rs.status === 403);
  check("K09", "Chaque action admin est journalisée", (await count("audit_log", { actor_id: adm.id })) >= 4);

  // ---------- Espace de gestion sécurisé (mission 3) ----------
  {
  r = await authFn({ action: "login", email: adm.email, password: "mauvais-mot-de-passe" });
  check("M01", "Mauvais mot de passe → refus générique", r.status === 401 && r.error === "Identifiants incorrects.");
  r = await authFn({ action: "login", email: client.email, password: "Test-Passw0rd!" });
  check("M02", "Compte client (bon mot de passe) refusé avec le même message, sans révéler l'existence du compte", r.status === 401 && r.error === "Identifiants incorrects." && !r.session);
  const adm2 = await user("moderation@test.fr", { ...base, first_name: "Modo", role: "client" });
  await svc.from("profiles").update({ role: "admin" }).eq("id", adm2.id);
  await svc.from("admin_accounts").insert({ user_id: adm2.id, level: "admin", must_change_password: false, created_by: adm.id });
  const { data: enr2 } = await adm2.c.auth.mfa.enroll({ factorType: "totp", friendlyName: "modo" });
  const SEC2 = enr2.totp.secret;
  for (let i = 0; i < 5; i++) r = await authFn({ action: "login", email: adm2.email, password: "faux-" + i });
  const locked = await authFn({ action: "login", email: adm2.email, password: "Test-Passw0rd!" });
  const lockAlert = await count("notifications", { user_id: adm.id, kind: "securite" });
  check("M03", "5 échecs → accès bloqué 15 min, même avec le bon mot de passe ; dirigeant alerté", r.status === 401 && locked.status === 423 && lockAlert >= 1, locked.error);
  check("M04", "Blocage et échecs inscrits dans le journal des connexions", (await count("admin_auth_events", { email: adm2.email, event: "locked" })) === 1 && (await count("admin_auth_events", { email: adm2.email, event: "login_fail" })) >= 5);
  r = await callA("admin-action", { action: "admin_unlock", email: adm2.email });
  const lg2 = await adminLogin(adm2, SEC2, enr2.id);
  check("M05", "Déblocage par le dirigeant puis connexion avec activation du TOTP", r.ok && !!lg2.session, lg2.error);
  r = await call(adm2, "admin-action", { action: "settings_update", settings: { cancel_mid_pct: 55 } });
  const r2b = await call(adm2, "admin-action", { action: "admin_create", email: "x@test.fr", first_name: "X", last_name: "Y" });
  check("M06", "Administrateur simple : paramètres et gestion des administrateurs refusés (dirigeant uniquement)", r.status === 403 && r2b.status === 403);
  r = await call(adm2, "admin-action", { action: "suspend", user_id: adm.id, suspended: true, reason: "Tentative" });
  check("M07", "Le compte du dirigeant ne peut pas être suspendu", r.status === 403);
  await sleep(125_000);   // délai de « nouvelle authentification » raccourci à 120 s dans les tests (5 min en production)
  r = await call(adm2, "admin-action", { action: "suspend", user_id: intrus.id, suspended: false, reason: "Contestation acceptée" });
  const su = await stepup(adm2, SEC2);
  const r3 = await call(adm2, "admin-action", { action: "suspend", user_id: intrus.id, suspended: false, reason: "Contestation acceptée" });
  check("M08", "Opération sensible : nouveau code TOTP exigé, puis acceptée (réactivation d'un compte)", r.status === 428 && !!su.session && r3.ok && (await row("profiles", intrus.id)).suspended === false, r.error);
  const { data: s2 } = await adm2.c.auth.getSession();
  const sid2 = JSON.parse(Buffer.from(s2.session.access_token.split(".")[1], "base64url").toString()).session_id;
  await svc.from("admin_sessions").update({ last_seen_at: new Date(Date.now() - 16 * 60_000).toISOString() }).eq("session_id", sid2);
  r = await call(adm2, "admin-action", { action: "ping" });
  const ended = (await svc.from("admin_sessions").select("end_reason").eq("session_id", sid2).single()).data;
  check("M09", "15 minutes d'inactivité → session fermée côté serveur et journalisée", r.status === 401 && ended?.end_reason === "inactivite" && (await count("admin_auth_events", { user_id: adm2.id, event: "timeout" })) >= 1, r.error);
  const { data: rest1 } = await client.c.from("admin_auth_events").select("*");
  const { data: rest2 } = await client.c.from("admin_accounts").select("*");
  const { error: rest3 } = await client.c.rpc("adm_counts");
  const { error: rest4 } = await client.c.rpc("adm_users", { p_role: "", p_q: "", p_status: "", p_limit: 50, p_offset: 0 });
  r = await call(client, "admin-action", { action: "users" });
  const r4 = await call(comp, "admin-action", { action: "finance" });
  check("M10", "Client et accompagnateur : aucune donnée d'administration, même en appelant directement les API", (rest1 ?? []).length === 0 && (rest2 ?? []).length === 0 && !!rest3 && !!rest4 && r.status === 403 && r4.status === 403);
  const { error: imm } = await svc.from("audit_log").delete().gte("id", 0);
  check("M11", "Journal inviolable : suppression refusée même avec la clé serveur", !!imm);
  // Assistance intégrée
  const { data: tk, error: tkErr } = await client.c.rpc("support_open", { p_category: "paiement", p_subject: "Remboursement", p_body: "Je n'ai pas reçu mon remboursement de la réservation.", p_booking_ref: null });
  r = await callA("admin-action", { action: "support_list" });
  const seen = (r.tickets ?? []).find((t) => t.id === tk?.id);
  await callA("admin-action", { action: "support_reply", ticket_id: tk?.id, body: "Nous avons relancé le remboursement : il arrive sous 5 jours." });
  const { data: msgs } = await client.c.from("support_messages").select("from_staff, body").eq("ticket_id", tk?.id);
  const tkNotif = await count("notifications", { user_id: client.id, kind: "assistance" });
  check("M12", "Assistance : demande du client visible par l'équipe, réponse reçue dans l'application", !tkErr && !!seen && (msgs ?? []).some((m) => m.from_staff) && tkNotif >= 1 && (await row("support_tickets", tk.id)).status === "repondue", tkErr?.message);
  const { data: other } = await comp.c.from("support_tickets").select("id").eq("id", tk?.id);
  check("M13", "Assistance : un autre membre ne voit pas la demande", (other ?? []).length === 0);
  // Données réelles
  r = await callA("admin-action", { action: "dashboard", days: 365 });
  const fin = r.finance ?? {};
  check("M14", "Tableau de bord : compteurs et finances calculés sur les données réelles", r.counts?.clients >= 2 && r.counts?.accompagnateurs >= 1 && Number(fin.encaisse) > 0 && Array.isArray(fin.par_mois), JSON.stringify(r.counts));
  const ledgerSum = ((await svc.from("ledger").select("amount, kind")).data ?? []).filter((l) => l.kind.startsWith("Encaissement")).reduce((a, l) => a + Number(l.amount), 0);
  r = await callA("admin-action", { action: "finance" });
  check("M15", "Montant encaissé identique au grand livre ; commissions = 20 % des prestations terminées", Math.abs(Number(r.finance?.encaisse) - ledgerSum) < 0.01
    && Math.abs(Number(r.finance?.commissions) - Number(r.finance?.volume_prestations) * Number(r.rules?.companion_fee_pct) / 100) < 0.05, `${r.finance?.encaisse} / ${ledgerSum}`);
  r = await callA("admin-action", { action: "users", q: "client@test" });
  const ud = await callA("admin-action", { action: "user_detail", user_id: client.id });
  check("M16", "Recherche d'un membre et fiche complète (e-mail, réservations, assistance)", r.users?.[0]?.email === "client@test.fr" && ud.profile?.email === "client@test.fr" && (ud.bookings ?? []).length > 0 && (ud.tickets ?? []).length >= 1);
  r = await callA("admin-action", { action: "bookings" });
  const bd = await callA("admin-action", { action: "booking_detail", booking_id: r.bookings?.[0]?.id });
  const tx = await callA("admin-action", { action: "transactions" });
  check("M17", "Réservations, détail (sans code de rencontre ni identifiant de paiement) et transactions", r.total > 0 && !!bd.booking && !("meeting_code_hash" in bd.booking) && !("stripe_payment_intent_id" in bd.booking) && tx.total > 0);
  // Photos : vérification humaine
  await comp.c.storage.from("photos").upload(`${comp.id}/avatar-test.jpg`, new Blob([new Uint8Array([255, 216, 255, 224])], { type: "image/jpeg" }));
  await comp.c.from("profiles").update({ avatar_path: `${comp.id}/avatar-test.jpg` }).eq("id", comp.id);
  r = await callA("admin-action", { action: "photos" });
  const ph = (r.photos ?? []).find((x) => x.storage_path === `${comp.id}/avatar-test.jpg`);
  const pr = await callA("admin-action", { action: "photo_review", photo_id: ph?.id, approve: true });
  const { data: dir } = await client.c.rpc("companions_directory");
  check("M18", "Nouvelle photo d'accompagnateur : vérifiée par l'équipe puis visible des clients", !!ph?.url && pr.ok && (dir ?? []).some((c) => c.id === comp.id && c.photo_path === `${comp.id}/avatar-test.jpg`));
  // Paramètres, annonces, administrateurs (dirigeant)
  r = await callA("admin-action", { action: "settings_update", settings: { cancel_mid_pct: 55 } });
  const bad = await callA("admin-action", { action: "settings_update", settings: { client_fee_pct: 99 } });
  await callA("admin-action", { action: "settings_update", settings: { cancel_mid_pct: 50 } });
  const sLog = (await svc.from("audit_log").select("action, details").eq("ref", "settings").order("id", { ascending: false }).limit(2)).data ?? [];
  check("M19", "Paramètres : modification journalisée (avant/après), valeurs hors limites refusées", r.ok && bad.status === 400 && sLog.length === 2 && !!sLog[1].details?.before, bad.error);
  r = await callA("admin-action", { action: "announce", audience: "client", body: "Nouveauté : l'assistance est disponible dans l'application." });
  check("M20", "Annonce aux clients : notifications créées et historique", r.ok && r.recipients >= 2 && (await count("notifications", { user_id: client.id, kind: "annonce" })) === 1);
  r = await callA("admin-action", { action: "admin_create", email: "nouvel.admin@test.fr", first_name: "Nadia", last_name: "Admin" });
  const tmp = r.temporary_password;
  const nu = { email: "nouvel.admin@test.fr", c: (await import("@supabase/supabase-js")).createClient(URL, ANON, { auth: { persistSession: false } }) };
  const l3 = await authFn({ action: "login", email: nu.email, password: tmp });
  await nu.c.auth.setSession(l3.session ?? { access_token: "", refresh_token: "" });
  const { data: enr3 } = await nu.c.auth.mfa.enroll({ factorType: "totp", friendlyName: "n" });
  const v3 = await authFn({ action: "mfa_verify", access_token: l3.session?.access_token, refresh_token: l3.session?.refresh_token, code: await code(enr3.totp.secret), factor_id: enr3.id });
  await nu.c.auth.setSession(v3.session);
  const blocked = await call(nu, "admin-action", { action: "dashboard" });
  const weak = await authFn({ action: "change_password", password: "court" }, v3.session?.access_token);
  const strong = await authFn({ action: "change_password", password: "Vrai-Mot-De-Passe-2026!#" }, v3.session?.access_token);
  const afterPw = await call(nu, "admin-action", { action: "dashboard" });
  check("M21", "Nouvel administrateur : mot de passe provisoire à changer (fort obligatoire) avant tout accès", !!tmp && blocked.status === 403 && weak.status === 400 && strong.ok && afterPw.status === 200, `${blocked.error} / ${weak.error}`);
  const auditTxt = JSON.stringify((await svc.from("audit_log").select("action").order("id", { ascending: false }).limit(30)).data);
  const evTxt = JSON.stringify((await svc.from("admin_auth_events").select("*")).data);
  check("M22", "Aucun mot de passe (provisoire ou saisi) dans les journaux", !auditTxt.includes(tmp) && !evTxt.includes(tmp) && !evTxt.includes("Vrai-Mot-De-Passe") && !evTxt.includes("faux-"));
  r = await callA("admin-action", { action: "admin_revoke", user_id: adm2.id });
  const gone = await adminLogin(adm2, SEC2, enr2.id);
  check("M23", "Accès administrateur retiré : connexion à l'espace de gestion impossible", r.ok && !gone.session && (await row("profiles", adm2.id)).role === "client");
  const out = await authFn({ action: "logout" }, v3.session?.access_token);
  r = await call(nu, "admin-action", { action: "ping" });
  check("M24", "Déconnexion : session fermée, l'API refuse ensuite l'accès", out.ok && r.status === 401);
  }


  // ---------- Audit fonctionnel (agenda, vérifications, parrainage, messagerie, justificatifs, historique) ----------
  const c3 = await user("client3@test.fr", { ...base, first_name: "Inès", role: "client" }, { identity_verified: true });
  const c4 = await user("client4@test.fr", { ...base, first_name: "Nora", role: "client" }, { identity_verified: true });
  await svc.from("companions").update({ travel_buffer_min: 60 }).eq("id", comp.id);
  const t0 = Date.parse(day(20));
  const a1 = await B({ starts_at: new Date(t0).toISOString() }, c3);
  r = await B({ starts_at: new Date(t0 + 2.5 * H).toISOString() }, c4);
  check("H01", "Délai de déplacement de 60 min : demande 30 min après la fin d'une mission refusée", !!a1.booking && r.status === 409, r.error);
  r = await B({ starts_at: new Date(t0 + 3 * H).toISOString() }, c4);
  check("H02", "Demande après le délai de déplacement acceptée", !!r.booking, r.error);
  await svc.from("companions").update({ travel_buffer_min: 0 }).eq("id", comp.id);
  const vac = [22, 23, 24].map((n) => ({ companion_id: comp.id, day: day(n).slice(0, 10) }));
  const { error: vErr } = await comp.c.from("companion_blocked_days").insert(vac);
  r = await B({ starts_at: day(23) }, c3);
  check("H03", "Période de vacances bloquée sur plusieurs jours → réservation refusée", !vErr && r.status === 400, vErr?.message ?? r.error);
  const { error: vErr2 } = await client.c.from("companion_blocked_days").insert({ companion_id: comp.id, day: day(30).slice(0, 10) });
  check("H04", "Un client ne peut pas bloquer l'agenda d'un accompagnateur", !!vErr2);
  const hold = await B({ starts_at: day(25) }, c3);
  await call(comp, "booking-action", { booking_id: hold.booking.id, action: "accept" });
  await svc.from("bookings").update({ mission_signed_companion: at(-25 * H) }).eq("id", hold.booking.id);
  await internal("sweeper", {});
  check("H05", "Acceptée mais non payée depuis plus de 24 h → expirée, créneau libéré", (await row("bookings", hold.booking.id)).status === "expiree");
  r = await B({ starts_at: day(25) }, c4);
  check("H06", "Le créneau libéré peut de nouveau être réservé", !!r.booking, r.error);
  // Vérifications obligatoires de l'accompagnateur
  const comp2 = await user("hugo@test.fr", { ...base, first_name: "Hugo", role: "companion", non_circumvention: true });
  await svc.from("companions").update({ verified: true, video_interview_ok: true, categories: ["shopping"], hour_from: 0, hour_to: 24 }).eq("id", comp2.id);
  await insure(comp2.id);
  const q2 = await call(c4, "create-booking", { companion_id: comp2.id, category: "shopping", starts_at: day(26), hours: 2, place: "Paris centre" });
  r = await call(comp2, "booking-action", { booking_id: q2.booking?.id, action: "accept" });
  check("H07", "Accompagnateur sans identité vérifiée : acceptation d'une mission payée refusée", r.status === 403, r.error);
  await svc.from("profiles").update({ identity_verified: true }).eq("id", comp2.id);
  r = await call(comp2, "booking-action", { booking_id: q2.booking?.id, action: "accept" });
  check("H08", "Accompagnateur sans compte de versement Stripe : acceptation refusée", r.status === 403, r.error);
  // Données sensibles du proche effacées à la clôture
  const pr = await call(c3, "create-booking", { companion_id: comp.id, category: "shopping", starts_at: day(27), hours: 2, place: "Paris centre", beneficiary: { name: "Mamie Jeanne", relation: "Grand-parent", phone: "0612345678", needs: ["mobilite"], info: "Diabétique, marche lentement", consent: true } });
  await call(c3, "refund-booking", { booking_id: pr.booking.id });
  const prb = await row("bookings", pr.booking.id);
  check("H09", "Téléphone et informations de santé du proche effacés après la clôture", prb.beneficiary_phone === null && prb.beneficiary_info === null && prb.beneficiary_needs.length === 0 && prb.beneficiary_name === "Mamie Jeanne");
  // Parrainage
  const refCode = (await row("profiles", c3.id)).referral_code;
  const filleul = await user("filleul@test.fr", { ...base, first_name: "Tom", role: "client", referral_code: refCode.toLowerCase() }, { identity_verified: true });
  check("H10", "Code de parrainage saisi à l'inscription → filleul rattaché", (await count("referrals", { sponsor_id: c3.id, referee_id: filleul.id })) === 1);
  const { error: refErr } = await filleul.c.from("referrals").insert({ sponsor_id: filleul.id, referee_id: filleul.id });
  check("H11", "Auto-parrainage ou parrainage fabriqué impossible", !!refErr);
  const fb = await B({ starts_at: day(28) }, filleul);
  check("H12", "Aucune récompense tant que le filleul n'a pas réalisé de mission", (await count("gift_cards", { owner_id: c3.id, is_referral_credit: true })) === 0);
  await svc.from("bookings").update({ status: "terminee" }).eq("id", fb.booking.id);
  await svc.from("bookings").update({ status: "cloturee" }).eq("id", fb.booking.id);
  check("H13", "Première mission clôturée du filleul → crédit de parrainage pour le parrain", (await count("gift_cards", { owner_id: c3.id, is_referral_credit: true })) === 1);
  // Messagerie
  const n0 = await count("notifications", { user_id: comp.id, kind: "message" });
  const { error: mErr } = await client.c.from("messages").insert({ booking_id: m.id, sender_id: client.id, body: "Merci ! Mon numéro : 06 12 34 56 78" });
  const lastMsg = (await svc.from("messages").select("body").eq("booking_id", m.id).order("id", { ascending: false }).limit(1).single()).data;
  check("H14", "Message : coordonnées masquées par le serveur", !mErr && /\[masqué\]/.test(lastMsg.body) && !/06 12/.test(lastMsg.body), lastMsg.body);
  check("H15", "Message : notification du destinataire", (await count("notifications", { user_id: comp.id, kind: "message" })) === n0 + 1);
  const { error: lErr, data: lData } = await intrus.c.from("messages").select("id").eq("booking_id", m.id);
  check("H16", "Conversation inaccessible à une personne étrangère", (lData ?? []).length === 0);
  const ap = `${client.id}/piece-jointe-${Date.now()}.jpg`;
  await client.c.storage.from("documents").upload(ap, new Blob([new Uint8Array([255, 216, 255, 224, 1, 2])], { type: "image/jpeg" }));
  await client.c.from("messages").insert({ booking_id: m.id, sender_id: client.id, body: "Photo du lieu", attachment_path: ap });
  const dl1 = await comp.c.storage.from("documents").download(ap), dl2 = await client2.c.storage.from("documents").download(ap);
  check("H17", "Pièce jointe lisible par l'autre partie, illisible par un tiers", !dl1.error && !!dl2.error, dl1.error?.message);
  // Versement effectué, justificatifs, historique
  const mine = (await comp.c.rpc("my_bookings")).data ?? [];
  const mb = mine.find((x) => x.booking.id === m.id)?.booking, other2 = mine.find((x) => x.booking.status === "confirmee")?.booking;
  check("H18", "« Versement effectué » seulement après confirmation du virement Stripe", mb?.payout_done === true && (!other2 || other2.payout_done === false));
  const inv = (await svc.from("invoices").select("number, kind, total").eq("booking_id", m.id)).data;
  check("H19", "Justificatifs générés : facture client et relevé accompagnateur", inv.some((x) => x.kind === "client") && inv.some((x) => x.kind === "companion"), inv.map((x) => x.number).join(", "));
  const { data: myInv } = await comp.c.from("invoices").select("number");
  check("H20", "Chacun ne voit que ses propres justificatifs", (myInv ?? []).every((x) => x.number.startsWith("FA-")));
  const ev = (await client.c.from("booking_events").select("status, created_at").eq("booking_id", m.id).order("id")).data;
  const chrono = ev.every((e, i) => i === 0 || Date.parse(e.created_at) >= Date.parse(ev[i - 1].created_at));
  const seq = ev.map((e) => e.status).filter(Boolean);
  check("H21", "Historique consultable, chronologique et complet", chrono && ["en_attente", "acceptee", "paiement_confirme", "confirmee", "verifie", "en_cours", "double_attente", "terminee", "cloturee"].every((s) => seq.includes(s)), seq.join(" → "));
  // Dossier administratif
  const { error: aErr } = await comp.c.from("companions").update({ legal_status: "micro", tax_id: "12345678900011" }).eq("id", comp.id);
  check("H22", "Dossier administratif transmis → « en cours de vérification »", !aErr && (await row("companions", comp.id)).admin_status === "en_cours", aErr?.message);
  await adminLogin(adm, ADM_SECRET);
  r = await call(adm, "admin-action", { action: "admin_review", companion_id: comp.id, approve: true });
  check("H23", "Dossier administratif validé par l'admin", r.ok && (await row("companions", comp.id)).admin_status === "valide");
  // Suppression de compte avec abonnement Privilège
  const priv = await user("privilege@test.fr", { ...base, first_name: "Paul", role: "client" }, { privilege_since: new Date().toISOString() });
  r = await call(priv, "account", { action: "delete", confirm: "SUPPRIMER" });
  check("H24", "Suppression de compte : abonnement Privilège résilié", r.ok && (await row("profiles", priv.id)).privilege_since === null);


  // ---------- Fiscalité DAC7 ----------
  await adminLogin(adm, ADM_SECRET);
  const Y = new Date().getFullYear(), TX = (body, u = adm) => u === adm ? callA("tax-admin", { year: Y, ...body }) : call(u, "tax-admin", { year: Y, ...body });
  r = await TX({ action: "overview" }, client);
  check("X01", "Espace fiscal DAC7 interdit à un client", r.status === 403);
  r = await TX({ action: "overview" });
  check("X02", "Tableau de bord DAC7 : accompagnateurs concernés et montants", r.status === 200 && r.concerned >= 1 && r.total_consideration > 0 && r.companions_total >= r.concerned, `${r.concerned}/${r.companions_total} accompagnateur(s), contrepartie ${r.total_consideration} €, commissions ${r.total_fees} €`);
  check("X03", "Informations manquantes détectées (SIREN de Zyntell, lieu de naissance…)", r.blocking > 0 && r.issues.some((i) => i.field === "SIREN"), `${r.blocking} point(s) bloquant(s)`);
  r = await TX({ action: "generate" });
  check("X04", "Déclaration refusée tant que des informations obligatoires manquent", r.status === 409, r.error);
  const { error: fErr } = await comp.c.from("companions").update({ nif: "1234567890123", birth_city: "Rouen", birth_country: "FR", tax_country: "FR", postal_address: "8 rue de Bretagne, 75003 Paris" }).eq("id", comp.id);
  check("X05", "L'accompagnateur complète lui-même ses informations fiscales", !fErr, fErr?.message);
  await svc.from("settings").update({ operator_siren: "123456789" }).eq("id", 1);
  r = await TX({ action: "verify" });
  check("X06", "Vérification des informations : plus aucun point bloquant", r.issues && !r.issues.some((i) => i.blocking), JSON.stringify(r.issues?.filter((i) => i.blocking)));
  r = await TX({ action: "generate" });
  const xml1 = r.xml ?? "";
  check("X07", "Déclaration XML générée (format DPI-DAC7 DGFiP)", r.status === 200 && xml1.includes(`<dpi:MessageRefId>OP_${Y}_123456789_`) && xml1.includes("<dpi:MessageTypeIndic>DPI401</dpi:MessageTypeIndic>") && xml1.includes("<dpi:PersonalServices>") && xml1.includes("<dpi:TaxesQ1") && xml1.includes(`<dpi:ReportingPeriod>${Y}-12-31</dpi:ReportingPeriod>`), r.error ?? `${xml1.length} caractères`);
  check("X08", "Montants en euros entiers, contrepartie nette après commission", !/<dpi:(ConsQ|FeesQ)\d currCode="EUR">\d+\.\d/.test(xml1) && /<dpi:TIN issuedBy="FR">1234567890123<\/dpi:TIN>/.test(xml1));
  await import("node:fs").then((fs) => { fs.writeFileSync("dac7-exemple-dgfip.xml", xml1); fs.writeFileSync("dac7-exemple-ocde.xml", xml1.replace(/TaxesQ/g, "TaxQ")); });
  const d1 = r.declaration;
  r = await TX({ action: "certificates", publish: true });
  check("X09", "Attestations refusées avant la validation de la déclaration", r.status === 409, r.error);
  r = await TX({ action: "validate", id: d1.id });
  check("X10", "Validation de la déclaration par l'administrateur", r.ok && !!r.portal);
  r = await TX({ action: "generate" });
  check("X11", "Seconde déclaration initiale pour la même année refusée (pas de doublon)", r.status === 409, r.error);
  r = await TX({ action: "download", id: d1.id });
  check("X12", "Téléchargement du XML archivé, intégrité vérifiée et journalisée", r.xml === xml1 && (await count("audit_log", { actor_id: adm.id })) > 0);
  r = await TX({ action: "certificates", publish: true });
  const { data: myCert } = await comp.c.from("tax_certificates").select("year, data, published_at");
  const { data: otherCert } = await client.c.from("tax_certificates").select("id");
  check("X13", "Attestations générées et envoyées : l'accompagnateur voit la sienne, personne d'autre", r.ok && (myCert ?? []).length === 1 && (otherCert ?? []).length === 0 && (await count("notifications", { user_id: comp.id, kind: "fiscal" })) >= 1, `${r.created} attestation(s)`);
  r = await TX({ action: "certificates", publish: true });
  check("X14", "Renvoi des attestations : aucun doublon", r.ok && r.created === 0);
  r = await TX({ action: "receipt", id: d1.id, receipt_ref: "AR-2027-000123" });
  check("X15", "Accusé de réception enregistré", r.ok && (await row("tax_declarations", d1.id)).status === "transmise");
  const { error: delErr } = await svc.from("tax_declarations").delete().eq("id", d1.id);
  check("X16", "Déclaration transmise impossible à supprimer (conservation légale)", !!delErr);
  r = await TX({ action: "generate", correction: true });
  check("X17", "Correction sans changement refusée", r.status === 409, r.error);
  await comp.c.from("companions").update({ nif: "2876543210987" }).eq("id", comp.id);
  r = await TX({ action: "generate", correction: true });
  const x2 = r.xml ?? "";
  check("X18", "Déclaration corrective : DPI402, OECD2 et référence à l'enregistrement d'origine", x2.includes("DPI402") && x2.includes("<stf:DocTypeIndic>OECD2</stf:DocTypeIndic>") && x2.includes("<stf:CorrDocRefId>") && x2.includes("2876543210987"), r.error);
  r = await TX({ action: "export" });
  check("X19", "Récapitulatif tableur (compatible Excel)", r.csv?.startsWith("﻿Année;Nom;Prénom") && r.csv.split("\r\n").length >= 2);
  const { data: mt } = await comp.c.rpc("my_tax_year", { p_year: Y });
  const { data: mtOther } = await client.c.rpc("my_tax_year", { p_year: Y });
  check("X20", "Mes documents fiscaux : revenus mensuels de l'accompagnateur, rien pour un client", (mt ?? []).length >= 1 && (mt ?? []).every((x) => x.missions > 0) && (mtOther ?? []).length === 0);
  const { data: leakDecl } = await comp.c.from("tax_declarations").select("id");
  check("X21", "Déclarations invisibles pour les accompagnateurs", (leakDecl ?? []).length === 0);

  // ---------- Fiscalité : compléments (ventilation, statuts, documents officiels, ZIP) ----------
  await adminLogin(adm, ADM_SECRET);
  r = await TX({ action: "overview" });
  const bd = (r.breakdown ?? []).find((x) => x.companion_id === comp.id) ?? {};
  check("X22", "Ventilation : payé client, frais client, commission, net, remboursements, taxes", Number(bd.client_paid) > Number(bd.gross) && Number(bd.client_fees) > 0 && Number(bd.commission) > 0 && Math.abs(Number(bd.declarable) - (Number(bd.gross) - Number(bd.commission) + Number(bd.tips))) < 0.01 && Number(bd.taxes) === 0 && !!r.stage,
    `payé ${bd.client_paid} €, frais client ${bd.client_fees} €, commission ${bd.commission} €, net ${bd.net_paid} €, déclarable ${bd.declarable} €, remboursements ${bd.refunds} €, étape « ${r.stage} »`);
  r = await TX({ action: "receipt", id: d1.id, receipt_ref: "AR-1", status: "acceptee" });
  check("X23", "« Acceptée » refusé sans document officiel importé", r.status === 409, r.error);
  const rec1 = (await svc.from("tax_seller_records").select("doc_ref_id").eq("declaration_id", d1.id).eq("companion_id", comp.id).single()).data;
  const sm = (orig, status, err = "") => btoa(unescape(encodeURIComponent(`<?xml version="1.0" encoding="UTF-8"?><dpism:DPI_StatusMessage xmlns:dpism="urn:oecd:ties:dpism:v1"><dpism:MessageSpec><dpism:MessageRefId>FR_SM_1</dpism:MessageRefId></dpism:MessageSpec><dpism:DPIStatusMessage><dpism:OriginalMessage><dpism:OriginalMessageRefID>${orig}</dpism:OriginalMessageRefID></dpism:OriginalMessage><dpism:ValidationErrors>${err}</dpism:ValidationErrors><dpism:ValidationResult><dpism:Status>${status}</dpism:Status></dpism:ValidationResult></dpism:DPIStatusMessage></dpism:DPI_StatusMessage>`)));
  r = await TX({ action: "import_receipt", id: d1.id, file_name: "cr.xml", content_b64: sm("OP_AUTRE_123", "Accepted") });
  check("X24", "Compte rendu d'une autre déclaration refusé", r.status === 409, r.error);
  r = await TX({ action: "import_receipt", id: d1.id, file_name: "cr.xml", content_b64: sm(d1.message_ref_id, "Accepted", `<dpism:RecordError><dpism:Code>80010</dpism:Code><dpism:Details>TIN invalide</dpism:Details><dpism:DocRefIDInError>${rec1?.doc_ref_id}</dpism:DocRefIDInError></dpism:RecordError>`) });
  const d1b = await row("tax_declarations", d1.id);
  check("X25", "Compte rendu importé : erreur signalée → déclaration « à corriger »", r.ok && d1b.status === "a_corriger" && d1b.errors?.[0]?.doc_ref_id === rec1?.doc_ref_id && (await TX({ action: "overview" })).stage === "a_corriger", `${r.official}, ${r.errors?.length} erreur(s)`);
  r = await TX({ action: "generate", correction: true });
  const x3 = r.xml ?? "", d3 = r.declaration;
  check("X26", "Correction de l'erreur signalée : enregistrement renvoyé (OECD2) avec la référence d'origine", x3.includes("<stf:DocTypeIndic>OECD2</stf:DocTypeIndic>") && x3.includes(`<stf:CorrDocRefId>${rec1?.doc_ref_id}</stf:CorrDocRefId>`), r.error);
  await TX({ action: "validate", id: d3?.id });
  const pdf = btoa("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
  r = await TX({ action: "import_receipt", id: d3?.id, file_name: "accuse.pdf", content_b64: pdf });
  check("X27", "Accusé PDF : statut officiel obligatoire", r.status === 400, r.error);
  r = await TX({ action: "import_receipt", id: d3?.id, file_name: "accuse.pdf", content_b64: pdf, official_status: "accepte", reference: "CR-DGFIP-2027-42" });
  check("X28", "Corrective acceptée sur document officiel : erreurs de la déclaration d'origine soldées", r.ok && (await row("tax_declarations", d3?.id)).status === "acceptee" && (await row("tax_declarations", d1.id)).status === "acceptee", r.error);
  r = await TX({ action: "overview" });
  const { data: rcpLeak } = await comp.c.from("tax_receipts").select("id");
  check("X29", "Historique des accusés conservé, invisible pour les accompagnateurs", (r.receipts ?? []).length === 2 && (rcpLeak ?? []).length === 0 && !!(await svc.from("tax_receipts").delete().eq("declaration_id", d1.id)).error);
  r = await TX({ action: "certificates_bundle" });
  check("X30", "Téléchargement groupé des attestations (données pour le ZIP)", (r.certificates ?? []).length >= 1 && r.certificates.every((c) => c.data && c.year === Y) && r.certificates.some((c) => c.nif === "2876543210987"));
  const { data: iss } = await comp.c.rpc("tax_profile_issues", { p_companion: comp.id });
  const { data: issOther } = await client.c.rpc("tax_profile_issues", { p_companion: comp.id });
  check("X31", "Informations manquantes ou incorrectes : visibles par l'accompagnateur seul", Array.isArray(iss) && !iss.some((x) => x.blocking) && (issOther ?? []).length === 0, JSON.stringify(iss));
  const { data: myb } = await comp.c.rpc("my_tax_breakdown", { p_year: Y });
  check("X32", "Ma ventilation fiscale (accompagnateur)", (myb ?? []).length === 1 && Number(myb[0].declarable) > 0 && myb[0].client_fees === undefined);

  // ---------- Assurance responsabilité civile ----------
  await adminLogin(adm, ADM_SECRET);
  const comp3 = await user("ines@test.fr", { ...base, first_name: "Inès", role: "companion", non_circumvention: true }, { identity_verified: true });
  await svc.from("companions").update({ verified: true, video_interview_ok: true, categories: ["shopping"], hour_from: 0, hour_to: 24, stripe_account_id: "acct_test_ines", payouts_enabled: true }).eq("id", comp3.id);
  const cY = await user("client-assurance@test.fr", { ...base, first_name: "Nora", role: "client" }, { identity_verified: true });
  const IB = (n) => call(cY, "create-booking", { companion_id: comp3.id, category: "shopping", starts_at: day(n), hours: 2, place: "Jardin du Luxembourg, Paris" });
  r = await IB(5);
  check("Y01", "Accompagnateur sans assurance : nouvelle réservation refusée", r.status === 409 && /assurance/i.test(r.error ?? ""), r.error);
  const pdfBytes = new Blob([new TextEncoder().encode("%PDF-1.4 attestation test")], { type: "application/pdf" });
  const up1 = await comp3.c.storage.from("insurance").upload(`${comp3.id}/rc-1.pdf`, pdfBytes);
  const upX = await comp3.c.storage.from("insurance").upload(`${comp.id}/pirate.pdf`, pdfBytes);
  const upExe = await comp3.c.storage.from("insurance").upload(`${comp3.id}/x.exe`, new Blob(["MZ"], { type: "application/x-msdownload" }));
  check("Y02", "Attestation déposée dans l'espace privé ; dossier d'un autre et format interdit refusés", !up1.error && !!upX.error && !!upExe.error, up1.error?.message);
  const insRow = (path, extra = {}) => ({ companion_id: comp3.id, insurer: "MAIF", policy_number: "RC-778899", starts_on: at(-10 * 24 * H).slice(0, 10), ends_on: at(200 * 24 * H).slice(0, 10), doc_path: path, covers_paid_activity: true, ...extra });
  const { data: i1, error: iErr } = await comp3.c.from("companion_insurances").insert(insRow(`${comp3.id}/rc-1.pdf`)).select().single();
  check("Y03", "Informations du contrat enregistrées : « en attente de validation »", !iErr && i1?.status === "en_attente", iErr?.message);
  const { error: selfVal } = await comp3.c.from("companion_insurances").update({ status: "validee" }).eq("id", i1?.id);
  const dlOther = await comp.c.storage.from("insurance").download(`${comp3.id}/rc-1.pdf`), dlClient = await client.c.storage.from("insurance").download(`${comp3.id}/rc-1.pdf`);
  check("Y04", "Auto-validation impossible ; justificatif illisible par un autre membre", !!selfVal && !!dlOther.error && !!dlClient.error);
  r = await call(comp3, "insurance", { action: "list" });
  check("Y05", "Gestion des assurances interdite hors administrateurs", r.status === 403);
  r = await callA("insurance", { action: "list", filter: "attente", q: "inès" });
  check("Y06", "Liste « en attente », recherche et compteurs", (r.rows ?? []).length === 1 && r.rows[0].state === "en_attente" && r.counts?.attente >= 1 && r.uninsured?.some((u) => u.companion_id === comp3.id), JSON.stringify(r.counts));
  r = await callA("insurance", { action: "doc", id: i1?.id });
  check("Y07", "Consultation du justificatif (lien temporaire) journalisée", !!r.url && (await count("insurance_reviews", { insurance_id: i1?.id, decision: "consultation" })) === 1);
  r = await callA("insurance", { action: "review", id: i1?.id, approve: false });
  const r2 = await callA("insurance", { action: "review", id: i1?.id, approve: false, reason: "Activité rémunérée non mentionnée" });
  check("Y08", "Refus : motif obligatoire, accompagnateur informé du motif", r.status === 400 && r2.ok && (await row("companion_insurances", i1?.id)).status === "refusee" && (await svc.from("notifications").select("body").eq("user_id", comp3.id).eq("kind", "assurance")).data?.some((n) => n.body.includes("non mentionnée")));
  r = await IB(5);
  check("Y09", "Attestation refusée : réservations toujours bloquées", r.status === 409);
  await comp3.c.storage.from("insurance").upload(`${comp3.id}/rc-2.pdf`, pdfBytes);
  const { data: i2 } = await comp3.c.from("companion_insurances").insert(insRow(`${comp3.id}/rc-2.pdf`, { ends_on: at(60 * 24 * H).slice(0, 10) })).select().single();
  r = await callA("insurance", { action: "review", id: i2?.id, approve: true });
  const again = await callA("insurance", { action: "review", id: i2?.id, approve: true });
  const ok3 = await IB(5);
  check("Y10", "Nouvelle attestation validée : réservations réactivées", r.ok && again.status === 409 && !!ok3.booking, ok3.error);
  r = await IB(70);
  check("Y11", "Prestation après la date d'expiration du contrat : refusée", r.status === 409, r.error);
  await svc.from("companion_insurances").update({ ends_on: at(30 * 24 * H).slice(0, 10) }).eq("id", i2?.id);
  await internal("sweeper", {}); await internal("sweeper", {});
  const rem = (await svc.from("notifications").select("body").eq("user_id", comp3.id).eq("kind", "assurance")).data?.filter((n) => n.body.includes("expire")) ?? [];
  check("Y12", "Rappel avant expiration envoyé une seule fois", rem.length === 1 && (await count("insurance_reminders", { insurance_id: i2?.id })) === 1, rem[0]?.body);
  await svc.from("companion_insurances").update({ ends_on: at(-1 * 24 * H).slice(0, 10) }).eq("id", i2?.id);
  await internal("sweeper", {});
  const exp = await row("companion_insurances", i2?.id);
  const adminMsg = (await svc.from("notifications").select("body").eq("user_id", adm.id).eq("kind", "assurance")).data ?? [];
  check("Y13", "Expiration : statut « expirée », accompagnateur prévenu, équipe informée des réservations affectées", exp.status === "expiree" && adminMsg.some((n) => n.body.includes(ok3.booking?.ref)), adminMsg.map((n) => n.body).join(" | "));
  r = await IB(8);
  const aff = await callA("insurance", { action: "list", filter: "expirees" });
  check("Y14", "Assurance expirée : nouvelle réservation refusée, réservation existante signalée", r.status === 409 && /assurance/i.test(r.error ?? "") && (aff.affected ?? []).some((b) => b.booking_id === ok3.booking?.id) && aff.rows.every((x) => x.state === "expiree"), `${r.status} ${r.error}`);
  r = await call(comp3, "account", { action: "export" });
  check("Y15", "Export RGPD : contrats d'assurance inclus", (r.insurances ?? []).length === 2);

  // ---------- International : profil Google / Apple, demandes de sortie, fuseaux horaires ----------
  const og = await svc.auth.admin.createUser({ email: "jean.google@test.fr", password: "Test-Passw0rd!", email_confirm: true, user_metadata: { full_name: "Jean Dupont", iss: "https://accounts.google.com" } });
  const gU = { id: og.data.user.id, c: createClient(URL, ANON, { auth: { persistSession: false } }) };
  await gU.c.auth.signInWithPassword({ email: "jean.google@test.fr", password: "Test-Passw0rd!" });
  const gp = await row("profiles", gU.id);
  check("W01", "Compte Google / Apple : profil créé (prénom, nom) sans date de naissance", gp.first_name === "Jean" && gp.last_name === "Dupont" && gp.birth_date === null, JSON.stringify({ f: gp.first_name, l: gp.last_name }));
  await svc.from("profiles").update({ identity_verified: true }).eq("id", gU.id);
  r = await call(gU, "create-booking", { companion_id: comp.id, category: "shopping", starts_at: day(9), hours: 2, place: "Paris centre" });
  check("W02", "Profil incomplet : réservation refusée", r.status === 403 && /Complétez/.test(r.error ?? ""), r.error);
  const cpBody = { role: "companion", first_name: "Jean", last_name: "Dupont", country: "JP", city: "Tokyo", phone: "+81312345678", lang: "en", time_zone: "Asia/Tokyo", terms: true, privacy: true, charter: true, adult: true, non_circumvention: true };
  r = await call(gU, "complete-profile", { ...cpBody, birth_date: at(-15 * 365 * 24 * H).slice(0, 10) });
  check("W03", "Fin d'inscription : mineur refusé", r.status === 403, r.error);
  r = await call(gU, "complete-profile", { ...cpBody, birth_date: "1990-05-05" });
  const gp2 = await row("profiles", gU.id), gc = await row("companions", gU.id);
  check("W04", "Fin d'inscription : rôle, pays, ville, langue, fuseau et consentements enregistrés", r.ok && gp2.role === "companion" && gp2.country === "JP" && gp2.city === "Tokyo" && gp2.lang === "en" && !!gp2.terms_accepted_at && gc?.time_zone === "Asia/Tokyo");
  r = await call(gU, "complete-profile", { ...cpBody, birth_date: "1990-05-05", role: "client" });
  check("W05", "Fin d'inscription impossible deux fois (pas de changement de rôle)", r.status === 409);
  // Disponibilités à l'heure locale de l'accompagnateur (Tokyo, 9 h – 12 h)
  await svc.from("companions").update({ verified: true, video_interview_ok: true, categories: ["musees"], hour_from: 9, hour_to: 12, work_days: [0, 1, 2, 3, 4, 5, 6] }).eq("id", gU.id);
  await insure(gU.id);
  const cW = await user("client-monde@test.fr", { ...base, first_name: "Emma", role: "client", country: "GB", lang: "en" }, { identity_verified: true });
  const tokyo = (n, hUtc) => day(n, hUtc);
  r = await call(cW, "create-booking", { companion_id: gU.id, category: "musees", starts_at: tokyo(12, 1), hours: 2, place: "Ueno, Tokyo" });
  const r2b = await call(cW, "create-booking", { companion_id: gU.id, category: "musees", starts_at: tokyo(13, 10), hours: 2, place: "Ueno, Tokyo" });
  check("W06", "Fuseaux horaires : 10 h à Tokyo acceptée, 19 h à Tokyo refusée", !!r.booking && r2b.status === 400, `${r.error ?? "acceptée"} / ${r2b.error}`);
  const { data: dirW } = await cW.c.rpc("companions_directory");
  check("W07", "Annuaire : pays, ville normalisée et fuseau", (dirW ?? []).some((x) => x.id === gU.id && x.country === "JP" && x.city_key === "tokyo" && x.time_zone === "Asia/Tokyo"));
  // Demandes de sortie : la cliente publie à Paris, l'accompagnatrice (Paris) cherche, propose ; réservation depuis la proposition
  await svc.from("profiles").update({ city: "Paris" }).eq("id", comp.id);
  const { data: oq, error: oqErr } = await cW.c.from("open_requests").insert({ client_id: cW.id, city: "  paris ", country: "FR", starts_at: day(33), hours: 2, category: "shopping", note: "Grands magasins" }).select().single();
  check("W08", "Demande de sortie publiée (ville normalisée)", !oqErr && oq?.city_key === "paris", oqErr?.message);
  const { data: seen } = await comp.c.rpc("search_open_requests", {});
  const { data: seenTokyo } = await gU.c.rpc("search_open_requests", { p_city: "PARIS", p_country: "fr" });
  const { data: notSeen } = await gU.c.rpc("search_open_requests", {});
  check("W09", "Accompagnateur : sa ville par défaut ; recherche dans une autre ville", (seen ?? []).some((x) => x.id === oq?.id && x.client_first_name === "Emma") && (seenTokyo ?? []).some((x) => x.id === oq?.id) && !(notSeen ?? []).some((x) => x.id === oq?.id));
  const { data: leakReq } = await comp.c.from("open_requests").select("id");
  check("W10", "Détail des demandes (client) non lisible par les accompagnateurs", (leakReq ?? []).length === 0);
  const { error: ofErr } = await comp.c.from("request_offers").insert({ request_id: oq?.id, companion_id: comp.id, message: "Avec plaisir" });
  const { error: ofDup } = await comp.c.from("request_offers").insert({ request_id: oq?.id, companion_id: comp.id });
  check("W11", "Proposition envoyée une seule fois, cliente prévenue", !ofErr && !!ofDup && (await count("notifications", { user_id: cW.id, kind: "reservation" })) >= 1, ofErr?.message);
  const { data: myOff } = await cW.c.rpc("my_request_offers");
  check("W12", "La cliente voit la proposition (prénom, tarif)", (myOff ?? []).some((x) => x.companion_id === comp.id && x.first_name === "Camille"));
  r = await call(cW, "create-booking", { companion_id: comp.id, category: "shopping", starts_at: day(33), hours: 2, place: "Galeries Lafayette, Paris", request_id: oq?.id });
  const oq2 = await row("open_requests", oq?.id);
  check("W13", "Réservation depuis la proposition : demande pourvue", !!r.booking && oq2.status === "pourvue", r.error);
  const { error: ofLate } = await gU.c.from("request_offers").insert({ request_id: oq?.id, companion_id: gU.id });
  check("W14", "Demande pourvue : plus de proposition possible", !!ofLate);
  const { error: badLang } = await cW.c.from("profiles").update({ lang: "jp" }).eq("id", cW.id);
  const { error: okPrefs } = await cW.c.from("profiles").update({ lang: "en", email_prefs: { resa: true, msg: false, rappel: true, news: false }, interests: ["Art"] }).eq("id", cW.id);
  check("W15", "Préférences : langue, e-mails, centres d'intérêt (langue inconnue refusée)", !!badLang && !okPrefs, okPrefs?.message);

  // ---------- Base de données (accès direct par l'API) ----------
  const { data: other } = await client2.c.from("bookings").select("id").eq("client_id", client.id);
  check("B01", "Un membre ne voit pas les réservations des autres", (other ?? []).length === 0);
  const { error: e1 } = await client.c.from("profiles").update({ identity_verified: true, role: "admin" }).eq("id", client.id);
  check("B02", "Un membre ne peut pas se donner le rôle admin ni s'auto-vérifier", !!e1);
  const { error: e2 } = await client.c.from("disputes").insert({ booking_id: b1.id, opened_by: client.id, reason: "Test", description: "Test test", status: "decide", decision: "remboursé" });
  check("B03", "Un membre ne peut pas créer un litige déjà « tranché »", !!e2);
  const { error: e3 } = await client.c.from("notifications").insert({ user_id: comp.id, body: "Faux message de la plateforme" });
  check("B04", "Un membre ne peut pas fabriquer une notification", !!e3);
  const { error: e4 } = await client.c.from("gift_cards").update({ balance: 999 }).eq("code", "CADEAU30");
  const card2 = (await svc.from("gift_cards").select("balance").eq("code", "CADEAU30").single()).data;
  check("B05", "Un membre ne peut pas modifier le solde d'une carte cadeau", Number(card2.balance) <= 30);
  const { error: e5 } = await client.c.rpc("hold_gift", { p_booking: b1.id, p_code: "CADEAU30", p_user: client.id, p_max: 30 });
  check("B06", "Les fonctions internes de carte cadeau ne sont pas appelables par un membre", !!e5);
  const { data: rows } = await client.c.rpc("my_bookings");
  check("B07", "Le client ne voit pas la commission ni le net de l'accompagnateur", (rows ?? []).every((x) => x.booking.amount_commission === undefined && x.booking.amount_payout === undefined));

  // ---------- RGPD ----------
  r = await call(client, "account", { action: "export" });
  check("G10", "Export RGPD de mes données", r.status === 200 && !!r.profile && Array.isArray(r.bookings), `${r.bookings?.length ?? 0} réservation(s)`);
  r = await call(client, "account", { action: "delete", confirm: "SUPPRIMER" });
  check("G11", "Suppression refusée tant qu'une réservation est en cours", r.status === 409);
  const solo = await user("solo@test.fr", { ...base, first_name: "Solo", role: "client" });
  r = await call(solo, "account", { action: "delete", confirm: "SUPPRIMER" });
  const relog = await createClient(URL, ANON, { auth: { persistSession: false } }).auth.signInWithPassword({ email: "solo@test.fr", password: "Test-Passw0rd!" });
  check("G12", "Suppression de compte : données anonymisées, connexion impossible", r.ok && (await row("profiles", solo.id)).first_name === "Compte supprimé" && !!relog.error);

  console.log(`\n${results.length - fails}/${results.length} tests réussis`);
  await import("node:fs").then((fs) => fs.writeFileSync("resultats-tests.json", JSON.stringify(results, null, 2)));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERREUR", e); process.exit(2); });
