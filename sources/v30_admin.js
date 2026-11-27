/* =====================================================================
   V3.0 — ESPACE DE GESTION (sidebyside.zyntell.fr/gestion)
   Construit à partir de l'administration existante (même design, mêmes composants),
   branché sur les données réelles de Supabase. Aucune donnée fictive.
   Sécurité : mot de passe + TOTP via la fonction admin-auth, déconnexion après 15 min
   d'inactivité, nouvelle saisie du code avant les opérations sensibles (réponse 428).
   ===================================================================== */
const G = { step: 'login', err: '', busy: false, info: '' };      // état de connexion
const AD = {};                                                     // données chargées par écran
const IDLE_MS = 15 * 60_000, WARN_MS = 14 * 60_000, PING_MS = 60_000;
let admLastAct = Date.now(), admLastPing = 0, admWarned = false, admStepWait = null;
ADMIN_TABS = ['dashboard', 'users', 'verif', 'bookings', 'finances', 'disputes', 'support', 'audit', 'settings'];

const ADM_FN = fn => SBS_CONFIG.url.replace(/\/$/, '') + '/functions/v1/' + fn;
async function admToken() { const { data } = await SB.auth.getSession(); return data && data.session; }
async function admAuth(body, token) {
  const r = await fetch(ADM_FN('admin-auth'), { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SBS_CONFIG.key, Authorization: 'Bearer ' + (token || SBS_CONFIG.key) }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...j };
}
// Appel d'une fonction serveur avec la session de gestion : 428 = nouvelle saisie du code, 401 = session terminée
async function admCall(fn, body, retried) {
  const s = await admToken(); if (!s) { admExpired('Session expirée : reconnectez-vous.'); throw new Error('Session expirée'); }
  let r; try { r = await fetch(ADM_FN(fn), { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SBS_CONFIG.key, Authorization: 'Bearer ' + s.access_token }, body: JSON.stringify(body || {}) }); }
  catch (e) { throw new Error('Le serveur ne répond pas. Réessayez.'); }
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (r.status === 428 && !retried) { await admStepUp(); return admCall(fn, body, true); }
  if (r.status === 401) { admExpired(j.error || 'Session expirée : reconnectez-vous.'); throw new Error(j.error || 'Session expirée'); }
  if (!r.ok || j.error) throw new Error(j.error || 'Opération impossible pour le moment.');
  admLastPing = Date.now();
  return j;
}
const admApi = (action, body) => admCall('admin-action', { action, ...(body || {}) });

/* ---------- Nouvelle authentification (opérations sensibles) ---------- */
function admStepUp() {
  return new Promise((ok, ko) => { admStepWait = { ok, ko }; open('stepup'); render(); setTimeout(() => { const i = document.getElementById('su-code'); i && i.focus(); }, 50); });
}
EXTRA_SHEETS.stepup = (s, h) => h('Confirmation de sécurité', 'Opération sensible : saisissez un nouveau code') + `<form class="stack" data-form="adm-stepup">
  <p class="sm muted">Ouvrez votre application d'authentification (Google Authenticator…) et saisissez le code à 6 chiffres affiché pour « Side by Side ».</p>
  <div class="field"><label for="su-code">Code à 6 chiffres</label><input id="su-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••"></div>
  <p class="note t-bad sm" id="su-err" hidden></p><button class="btn pri full">Confirmer</button></form>`;

/* ---------- Déconnexion : volontaire, inactivité, session expirée ---------- */
async function admLogout(reason, msg) {
  const s = await admToken().catch(() => null);
  if (s) await admAuth({ action: 'logout', reason }, s.access_token).catch(() => {});
  try { await SB.auth.signOut({ scope: 'local' }); } catch (e) {}
  for (const k in AD) delete AD[k];
  ME = null; S.role = null; S.adminOk = false; S.sheet = null; G.step = 'login'; G.err = ''; G.info = msg || '';
  if (admStepWait) { admStepWait.ko(new Error('annulé')); admStepWait = null; }
  render();
}
function admExpired(msg) { if (S.role === 'admin') admLogout('expiree', msg); }
function admActivity() {
  admLastAct = Date.now(); admWarned = false;
  if (S.role === 'admin' && S.adminOk && Date.now() - admLastPing > PING_MS) { admLastPing = Date.now(); admApi('ping').catch(() => {}); }
}
function admIdleWatch() {
  if (S.role !== 'admin' || !S.adminOk) return;
  const idle = Date.now() - admLastAct;
  if (idle > IDLE_MS) { admLogout('inactivite', 'Vous avez été déconnecté après 15 minutes d\'inactivité.'); return; }
  if (idle > WARN_MS && !admWarned) { admWarned = true; toast('Sans activité, vous serez déconnecté dans 1 minute.', true); render(); }
}

/* ---------- Écrans de connexion ---------- */
function admLoginPage() {
  const head = `<div class="login-logo">${typeof loginLogo === 'function' ? loginLogo() : ''}</div><h2 style="text-align:center;margin:.2em 0">Espace de gestion</h2><p class="xs muted" style="text-align:center">Accès réservé à l'équipe Side by Side · connexion chiffrée et journalisée</p>`;
  const err = G.err ? `<p class="note t-bad sm" role="alert">${esc(G.err)}</p>` : '', info = G.info ? `<p class="note t-warn sm">${esc(G.info)}</p>` : '';
  let body = '';
  if (G.step === 'login') body = `<form class="card stack" data-form="adm-login" autocomplete="on">${info}<div class="field"><label for="al-mail">Adresse e-mail professionnelle</label><input id="al-mail" name="email" type="email" autocomplete="username" required></div>
    <div class="field"><label for="al-pw">Mot de passe</label><input id="al-pw" name="password" type="password" autocomplete="current-password" required></div>${err}
    <button class="btn pri full" ${G.busy ? 'disabled' : ''}>${G.busy ? 'Vérification…' : 'Continuer'}</button>
    <p class="xs muted">Après 5 échecs, l'accès est bloqué 15 minutes et l'équipe est alertée. Mot de passe ou téléphone perdu : contactez le dirigeant.</p></form>`;
  else if (G.step === 'enroll') body = `<form class="card stack" data-form="adm-mfa"><h3>Activer la double authentification</h3><p class="sm muted">Première connexion : scannez ce QR code avec Google Authenticator (ou Microsoft Authenticator), puis saisissez le code affiché.</p>
    <div style="text-align:center"><img src="${G.qr}" alt="QR code de double authentification" style="width:200px;height:200px;background:#fff;padding:8px;border-radius:12px;display:inline-block"></div>
    <p class="xs muted">Ou saisissez la clé : <b class="sel num">${esc(G.secret || '')}</b></p>
    <div class="field"><label for="am-code">Code à 6 chiffres</label><input id="am-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••"></div>${err}
    <button class="btn pri full" ${G.busy ? 'disabled' : ''}>Valider</button><button class="btn ghost full" type="button" data-a="adm-cancel">Annuler</button></form>`;
  else if (G.step === 'verify') body = `<form class="card stack" data-form="adm-mfa"><h3>Double authentification</h3><p class="sm muted">Saisissez le code à 6 chiffres de votre application d'authentification.</p>
    <div class="field"><label for="am-code">Code</label><input id="am-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" autofocus></div>${err}
    <button class="btn pri full" ${G.busy ? 'disabled' : ''}>Valider</button><button class="btn ghost full" type="button" data-a="adm-cancel">Annuler</button></form>`;
  else if (G.step === 'pw') body = `<form class="card stack" data-form="adm-pw"><h3>Choisissez votre mot de passe</h3><p class="sm muted">Votre mot de passe provisoire doit être remplacé avant d'accéder à l'espace de gestion.</p>
    <div class="field"><label for="ap-1">Nouveau mot de passe</label><input id="ap-1" name="pw" type="password" autocomplete="new-password"></div>
    <div class="field"><label for="ap-2">Confirmation</label><input id="ap-2" name="pw2" type="password" autocomplete="new-password"></div>
    <p class="xs muted">14 caractères minimum, avec minuscules, majuscules, chiffres et symboles. Les mots de passe ayant fuité sur Internet sont refusés.</p>${err}
    <button class="btn pri full" ${G.busy ? 'disabled' : ''}>Enregistrer</button></form>`;
  else body = `<div class="card"><p class="muted">Chargement…</p></div>`;
  return `<main class="login"><div class="wrap login-in" style="max-width:460px">${head}${body}</div></main>`;
}
async function admStartMfa() {
  const { data: f } = await SB.auth.mfa.listFactors();
  const ok = (f && f.totp || []).find(x => x.status === 'verified');
  if (ok) { G.step = 'verify'; G.factorId = ok.id; return; }
  for (const x of (f && f.all || []).filter(x => x.status !== 'verified')) await SB.auth.mfa.unenroll({ factorId: x.id }).catch(() => {});
  const { data: e, error } = await SB.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Side by Side Gestion ' + new Date().toISOString().slice(0, 10) });
  if (error) throw error;
  G.step = 'enroll'; G.factorId = e.id; G.qr = e.totp.qr_code; G.secret = e.totp.secret;
}
async function admEnter() {
  const me = await admApi('me');
  AD.me = me;
  const { data: p } = await SB.from('profiles').select('*').eq('id', me.id).single();
  ME = p || { id: me.id, first_name: me.first_name, role: 'admin' };
  S.users = { u1: { id: 'u1', name: ME.first_name || '', city: '', verified: 'ok', notif: [] } }; S.companions = []; S.bookings = []; S.msgs = {};
  ['notifs', 'flags', 'logs', 'disputes', 'reviews', 'ledger', 'support'].forEach(k => { if (Array.isArray(S[k])) S[k] = []; });   // aucune donnée de démonstration
  S.lang = 'fr';
  S.role = 'admin'; S.adminOk = true; S.tab = ADMIN_TABS.includes(S.tab) ? S.tab : 'dashboard'; G.step = 'ok'; G.err = ''; G.info = '';
  admLastAct = Date.now(); admLastPing = Date.now(); render();
}
// Reprise d'une session ouverte dans cet onglet (rechargement de la page)
async function admLoad() {
  const s = await admToken();
  if (!s) { S.role = null; G.step = G.step === 'ok' ? 'login' : G.step; render(); return; }
  try { await admEnter(); } catch (e) { try { await SB.auth.signOut({ scope: 'local' }); } catch (x) {} S.role = null; G.step = 'login'; render(); }
}

/* ---------- Petits composants ---------- */
const kpi = (l, v, cls = '') => `<div class="card kpi ${cls}"><span class="lbl">${l}</span><span class="num">${v}</span></div>`;
const loading = () => `<section class="section"><p class="muted">Chargement…</p></section>`;
const dts = s => s ? fdt(Date.parse(s)) : '—';
const dday = s => s ? fshort(Date.parse(s)) : '—';
const roleLbl = r => ({ client: 'Client', business: 'Entreprise', companion: 'Accompagnateur', admin: 'Équipe' }[r] || r);
const pillS = s => (typeof ST !== 'undefined' && ST[s]) ? pill(s) : `<span class="pill t-muted">${esc(s)}</span>`;
const pager = (key, res) => { if (!res || res.total <= res.size) return ''; const p = res.page, last = Math.ceil(res.total / res.size) - 1;
  return `<div class="row" style="justify-content:flex-end;gap:8px"><span class="xs muted">${p * res.size + 1}–${Math.min(res.total, (p + 1) * res.size)} sur ${res.total}</span><button class="btn ghost" data-a="adm-page" data-v="${key}|${p - 1}" ${p <= 0 ? 'disabled' : ''}>Précédent</button><button class="btn ghost" data-a="adm-page" data-v="${key}|${p + 1}" ${p >= last ? 'disabled' : ''}>Suivant</button></div>`; };
function need(key, loader) { if (AD[key] === undefined) { AD[key] = null; loader().then(v => { AD[key] = v; render(); }).catch(e => { AD[key] = { _err: e.message }; render(); }); } return AD[key]; }
const errBox = d => d && d._err ? `<section class="section"><div class="note t-bad">${esc(d._err)}</div><button class="btn" data-a="adm-refresh">Réessayer</button></section>` : '';
function refreshAll(keys) { (keys || Object.keys(AD)).forEach(k => { if (k !== 'me') delete AD[k]; }); render(); }
const admDl = (name, text, type = 'text/csv') => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); };
const csvLine = arr => arr.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(';');

/* ---------- 1. Tableau de bord ---------- */
function vDash() {
  const days = AD.days ?? 30;
  const d = need('dash', () => admApi('dashboard', { days })), ov = need('ov', () => admApi('overview'));
  if (!d) return loading(); if (d._err) return errBox(d);
  const c = d.counts || {}, f = d.finance || {};
  const todo = [['identites_a_verifier', 'pièce(s) d\'identité à vérifier', 'verif'], ['profils_a_valider', 'profil(s) d\'accompagnateur à valider', 'verif'], ['dossiers_a_verifier', 'dossier(s) administratif(s) à vérifier', 'verif'],
    ['photos_a_verifier', 'photo(s) à vérifier', 'verif'], ['avis_a_moderer', 'avis à modérer', 'verif'], ['litiges_ouverts', 'litige(s) ouvert(s)', 'disputes'], ['missions_a_verifier', 'mission(s) à vérifier', 'bookings'], ['assistance_ouverte', 'demande(s) d\'assistance à traiter', 'support']]
    .filter(([k]) => Number(c[k]) > 0).map(([k, l, t]) => `<div class="card row"><div class="grow"><b>${c[k]} ${l}</b></div><button class="btn" data-a="tab" data-v="${t}">Traiter</button></div>`).join('');
  const notes = (d.notifications || []), unread = notes.filter(n => !n.read_at).length;
  const alerts = ov && !ov._err ? ov.alerts || [] : [];
  return `<section class="section"><div class="row"><h2 class="grow">Tableau de bord</h2><div class="field" style="width:auto"><label for="adm-days" class="sr">Période</label><select id="adm-days" data-adm-days>${[[0, 'Depuis le début'], [7, '7 derniers jours'], [30, '30 derniers jours'], [90, '90 derniers jours'], [365, '12 derniers mois']].map(([v, l]) => `<option value="${v}" ${days === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><button class="btn ghost" data-a="adm-refresh">Actualiser</button></div>
  ${alerts.length ? alerts.slice(0, 3).map(x => `<div class="note t-bad row" role="alert"><div class="grow"><b>${esc(x.kind)}</b> · ${x.bookings ? esc(x.bookings.ref) : 'Hors réservation'} · ${dts(x.created_at)}</div>${x.latitude != null ? `<a class="btn ghost" href="https://www.openstreetmap.org/?mlat=${+x.latitude}&mlon=${+x.longitude}#map=17/${+x.latitude}/${+x.longitude}" target="_blank" rel="noopener">Carte</a>` : ''}<button class="btn" data-a="adm-user" data-id="${esc(x.user_id)}">Voir le membre</button></div>`).join('') : ''}
  <div class="kpis">${kpi('Clients', c.clients ?? 0)}${kpi('Accompagnateurs', c.accompagnateurs ?? 0)}${kpi('Identités vérifiées', c.verifies ?? 0)}${kpi('Réservations', f.reservations ?? 0)}${kpi('Litiges ouverts', c.litiges_ouverts ?? 0)}${kpi('Alertes (7 j)', c.alertes_7j ?? 0)}</div>
  <div class="card stack"><span class="lbl">Finances (données réelles)</span><div class="tbl" style="border:0"><table class="t" style="min-width:0"><tr><th>Indicateur</th><th>Nature</th><th style="text-align:right">Montant</th></tr>
  <tr><td>Montants encaissés</td><td><span class="pill t-ok">Réel</span></td><td class="num" style="text-align:right">${eur(+f.encaisse)}</td></tr>
  <tr><td>Chiffre d'affaires ZYNTELL HT (frais de service + commissions)</td><td><span class="pill t-ok">Acquis</span></td><td class="num" style="text-align:right">${eur(+f.chiffre_affaires_ht)}</td></tr>
  <tr><td>dont commissions ZYNTELL sur les prestations terminées</td><td><span class="pill t-ok">Acquis</span></td><td class="num" style="text-align:right">${eur(+f.commissions)}</td></tr>
  <tr><td>Versements aux accompagnateurs</td><td><span class="pill t-ok">Réel</span></td><td class="num" style="text-align:right">${eur(+f.verse)}</td></tr>
  <tr><td>Remboursements</td><td><span class="pill t-bad">Remboursé</span></td><td class="num" style="text-align:right">${eur(+f.rembourse)}</td></tr>
  <tr><td>Fonds détenus (prestations payées non terminées)</td><td><span class="pill t-warn">En attente</span></td><td class="num" style="text-align:right">${eur(+f.fonds_detenus)}</td></tr></table></div></div>
  ${barChart((f.par_mois || []).slice(-6).map(m => ({ label: new Intl.DateTimeFormat(LOC(), { month: 'short' }).format(new Date(m.mois + '-01T12:00:00')), v: +m.ca_ht })), 'Chiffre d\'affaires ZYNTELL HT par mois')}
  <div class="stack">${todo || '<div class="empty">Rien à traiter pour le moment.</div>'}</div></section>
  <section class="section"><div class="row"><h3 class="grow">Notifications de l'équipe${unread ? ` <span class="pill t-warn">${unread} non lue(s)</span>` : ''}</h3>${unread ? '<button class="btn ghost" data-a="adm-notif-read">Tout marquer comme lu</button>' : ''}</div>
  ${notes.length ? notes.map(n => `<div class="card row ${n.read_at ? '' : 'unread'}"><span class="xs muted">${dts(n.created_at)}</span><span class="grow sm">${esc(n.body)}</span></div>`).join('') : '<div class="empty">Aucune notification.</div>'}</section>
  <section class="section"><h3>Répartition géographique</h3>${(f.par_ville || []).length ? `<div class="tbl"><table class="t"><tr><th>Ville</th><th>Pays</th><th>Réservations</th><th>Volume</th></tr>${f.par_ville.map(v => `<tr><td>${esc(v.ville)}</td><td>${esc(v.pays)}</td><td class="num">${v.reservations}</td><td class="num">${eur(+v.volume)}</td></tr>`).join('')}</table></div>` : '<div class="empty">Aucune réservation sur la période.</div>'}
  <div class="acts"><button class="btn" data-a="dac7">Fiscalité et déclarations DAC7</button><button class="btn" data-a="ins-admin">Gestion des assurances</button></div></section>`;
}

/* ---------- 2. Membres ---------- */
function vUsers() {
  const F = AD.uf || (AD.uf = { q: '', role: '', status: '', page: 0 });
  const d = need('users', () => admApi('users', F));
  return `<section class="section"><h2>Comptes</h2><form class="row" data-form="adm-users" style="flex-wrap:wrap;gap:8px"><input name="q" value="${esc(F.q)}" placeholder="Nom, e-mail, téléphone, ville" aria-label="Rechercher un membre" style="flex:1;min-width:200px">
  <select name="role" aria-label="Type de compte"><option value="">Tous</option><option value="client" ${F.role === 'client' ? 'selected' : ''}>Clients</option><option value="companion" ${F.role === 'companion' ? 'selected' : ''}>Accompagnateurs</option></select>
  <select name="status" aria-label="Statut"><option value="">Tous les statuts</option><option value="non_verifie" ${F.status === 'non_verifie' ? 'selected' : ''}>Identité non vérifiée</option><option value="a_valider" ${F.status === 'a_valider' ? 'selected' : ''}>Profil à valider</option><option value="suspendu" ${F.status === 'suspendu' ? 'selected' : ''}>Suspendus</option></select>
  <button class="btn pri">Rechercher</button></form>
  ${!d ? '<p class="muted">Chargement…</p>' : d._err ? errBox(d) : d.users.length ? `<div class="tbl"><table class="t"><tr><th>Nom</th><th>E-mail</th><th>Type</th><th>Ville</th><th>Vérification</th><th>Réservations</th><th></th></tr>
  ${d.users.map(u => `<tr><td><b>${esc((u.first_name || '') + ' ' + (u.last_name || ''))}</b></td><td class="xs">${esc(u.email || '')}</td><td>${roleLbl(u.role)}${u.tier === 'Prestige' ? ' <span class="chip gold">Prestige</span>' : ''}</td><td>${esc(u.city || '')}</td>
  <td>${u.identity_verified ? '<span class="pill t-ok">Identité vérifiée</span>' : '<span class="pill t-warn">Identité à vérifier</span>'}${u.role === 'companion' ? (u.verified ? ' <span class="pill t-ok">Profil validé</span>' : ' <span class="pill t-warn">Profil à valider</span>') : ''}${u.suspended ? ' <span class="pill t-bad">Suspendu</span>' : ''}</td>
  <td class="num">${u.bookings}</td><td><button class="btn" data-a="adm-user" data-id="${esc(u.id)}">Fiche</button></td></tr>`).join('')}</table></div>${pager('users', d)}` : '<div class="empty">Aucun compte ne correspond.</div>'}
  <p class="xs muted">Les documents d'identité ne sont jamais affichés publiquement ; chaque consultation de fiche est journalisée.</p></section>`;
}
EXTRA_SHEETS.admuser = (s, h) => {
  const d = AD['user:' + s.id];
  if (d === undefined) { AD['user:' + s.id] = null; admApi('user_detail', { user_id: s.id }).then(v => { AD['user:' + s.id] = v; render(); }).catch(e => { AD['user:' + s.id] = { _err: e.message }; render(); }); }
  if (!d) return h('Fiche membre', '') + '<p class="muted">Chargement…</p>';
  if (d._err) return h('Fiche membre', '') + `<p class="note t-bad">${esc(d._err)}</p>`;
  const p = d.profile, c = d.companion;
  return h(esc(`${p.first_name || ''} ${p.last_name || ''}`), `${roleLbl(p.role)} · inscrit le ${dday(p.created_at)}`) + `<div class="stack">
  <div class="card stack sm"><div><b>E-mail</b> : ${esc(p.email || '')}</div><div><b>Téléphone</b> : ${esc(p.phone || '—')}</div><div><b>Ville</b> : ${esc([p.city, p.country].filter(Boolean).join(', ') || '—')}</div><div><b>Date de naissance</b> : ${esc(p.birth_date || '—')}</div>
  <div>${p.identity_verified ? '<span class="pill t-ok">Identité vérifiée</span>' : '<span class="pill t-warn">Identité non vérifiée</span>'} ${p.suspended ? '<span class="pill t-bad">Compte suspendu</span>' : '<span class="pill t-ok">Compte actif</span>'} ${p.privilege_since ? '<span class="pill t-gold">Privilège</span>' : ''}</div></div>
  ${c ? `<div class="card stack sm"><b>Accompagnateur</b><div>${c.verified ? '<span class="pill t-ok">Profil validé</span>' : '<span class="pill t-warn">Profil à valider</span>'} <span class="chip ${c.tier === 'Prestige' ? 'gold' : ''}">${esc(c.tier || 'Standard')}</span> · ${eur(+c.hourly_rate)}/h</div>
    <div>Dossier administratif : <b>${esc({ en_cours: 'à vérifier', valide: 'validé', refuse: 'refusé' }[c.admin_status] || 'non transmis')}</b>${c.legal_status ? ` · statut ${esc(c.legal_status)}` : ''}${c.admin_doc_url ? ` · <a href="${esc(c.admin_doc_url)}" target="_blank" rel="noopener">voir le justificatif (10 min)</a>` : ''}</div>
    <div>Assurance RC : ${(d.insurance || []).length ? d.insurance.map(i => `${esc(i.insurer)} n° ${esc(i.policy_number)} · ${esc(i.status)} · jusqu'au ${dday(i.ends_on)}`).join('<br>') : '<span class="pill t-bad">aucune attestation</span>'}</div>
    ${c.bio ? `<p class="ugc">${esc(c.bio)}</p>` : ''}
    <div class="pbar">${!c.verified ? `<button class="btn pri" data-a="adm-comp" data-id="${esc(p.id)}" data-v="Standard" ${p.identity_verified ? '' : 'disabled'}>Valider (Standard)</button><button class="btn" data-a="adm-comp" data-id="${esc(p.id)}" data-v="Prestige" ${p.identity_verified ? '' : 'disabled'}>Valider (Prestige)</button>` : ''}
    ${c.admin_status === 'en_cours' ? `<button class="btn pri" data-a="adm-dossier" data-id="${esc(p.id)}" data-v="1">Valider le dossier administratif</button>` : ''}</div></div>` : ''}
  ${(d.photos || []).length ? `<div class="card stack sm"><b>Photos</b><div class="row" style="flex-wrap:wrap;gap:8px">${d.photos.map(x => `<figure style="margin:0;width:96px"><img src="${esc(x.url || '')}" alt="" style="width:96px;height:96px;object-fit:cover;border-radius:10px"><figcaption class="xs muted">${esc({ pending: 'à vérifier', ok: 'validée', refused: 'refusée', draft: 'brouillon' }[x.status] || x.status)}</figcaption></figure>`).join('')}</div></div>` : ''}
  <div class="card stack sm"><b>Dernières réservations</b>${(d.bookings || []).length ? `<div class="tbl"><table class="t"><tr><th>Réf.</th><th>Date</th><th>Statut</th><th>Total</th></tr>${d.bookings.map(b => `<tr><td><button class="linkbtn" data-a="adm-resa" data-id="${esc(b.id)}">${esc(b.ref)}</button></td><td>${dts(b.starts_at)}</td><td>${pillS(b.status)}</td><td class="num">${eur(+b.amount_total)}</td></tr>`).join('')}</table></div>` : '<p class="muted">Aucune.</p>'}</div>
  <div class="card stack sm"><b>Demandes d'assistance</b>${(d.tickets || []).length ? d.tickets.map(t => `<button class="accrow" data-a="adm-ticket" data-id="${esc(t.id)}"><span class="grow">${esc(t.ref)} · ${esc(t.subject)}</span><span class="xs muted">${esc(t.status)}</span></button>`).join('') : '<p class="muted">Aucune.</p>'}</div>
  <div class="card stack sm"><b>Historique des décisions</b>${(d.logs || []).length ? d.logs.map(l => `<div class="xs"><span class="muted">${dts(l.created_at)}</span> · ${esc(l.actor)} · ${esc(l.action)}</div>`).join('') : '<p class="muted">Aucune décision.</p>'}</div>
  <form class="card stack" data-form="adm-suspend" data-id="${esc(p.id)}" data-v="${p.suspended ? '0' : '1'}"><b>${p.suspended ? 'Réactiver le compte' : 'Suspendre le compte'}</b><div class="field"><label for="su-r">Motif (obligatoire, communiqué dans le journal)</label><input id="su-r" name="reason" maxlength="300"></div>
  <p class="xs muted">Opération sensible : un nouveau code de double authentification sera demandé.</p><button class="btn ${p.suspended ? 'pri' : 'bad'}">${p.suspended ? 'Réactiver' : 'Suspendre'}</button></form></div>`;
};

/* ---------- 3. Vérifications (identités, profils, dossiers, photos, avis) ---------- */
function vVerif() {
  const ov = need('ov', () => admApi('overview')), ph = need('photos', () => admApi('photos')), rv = need('reviews', () => admApi('reviews', { status: 'moderation' }));
  if (!ov) return loading(); if (ov._err) return errBox(ov);
  const dossiers = (ov.companions || []).filter(c => c.admin_status === 'en_cours'), toValidate = (ov.companions || []).filter(c => !c.verified);
  return `<section class="section"><div class="row"><h2 class="grow">Vérifications</h2><button class="btn ghost" data-a="adm-refresh">Actualiser</button></div>
  <h3>Pièces d'identité à vérifier</h3>${ov.identity.length ? ov.identity.map(x => `<form class="card stack" data-form="adm-id" data-id="${esc(x.id)}"><div class="row"><b class="grow">${esc((x.profiles?.first_name || '') + ' ' + (x.profiles?.last_name || ''))}</b><span class="pill t-warn">${roleLbl(x.profiles?.role)}</span></div>
    <span class="xs muted">Né(e) le ${esc(x.profiles?.birth_date || '—')} · déposé le ${dts(x.created_at)}</span>
    <div class="row">${x.doc_url ? `<a class="btn ghost" href="${esc(x.doc_url)}" target="_blank" rel="noopener">Voir la pièce</a>` : ''}${x.selfie_url ? `<a class="btn ghost" href="${esc(x.selfie_url)}" target="_blank" rel="noopener">Voir le selfie</a>` : ''}</div>
    <p class="xs muted">Liens valables 10 minutes. Vérifiez la majorité, la correspondance du visage et la validité du document.</p>
    <div class="field"><label>Motif en cas de refus</label><input name="reason" maxlength="300" placeholder="Ex. : document expiré, photo illisible"></div>
    <div class="pbar"><button class="btn pri" name="ok" value="1">Valider l'identité</button><button class="btn bad" name="ok" value="0">Refuser</button></div></form>`).join('') : '<div class="empty">Aucune pièce en attente.</div>'}
  <h3>Accompagnateurs à valider</h3>${toValidate.length ? toValidate.map(c => `<div class="card stack"><div class="row"><b class="grow">${esc((c.profiles?.first_name || '') + ' ' + (c.profiles?.last_name || ''))}</b>${c.profiles?.identity_verified ? '<span class="pill t-ok">Identité vérifiée</span>' : '<span class="pill t-warn">Identité non vérifiée</span>'}</div>
    <span class="xs muted">${esc(c.profiles?.city || '')} · ${eur(+c.hourly_rate)}/h · ${esc((c.categories || []).join(', ') || 'aucune activité')}</span>${c.bio ? `<p class="sm ugc">${esc(c.bio)}</p>` : ''}
    <div class="pbar"><button class="btn pri" data-a="adm-comp" data-id="${esc(c.id)}" data-v="Standard" ${c.profiles?.identity_verified ? '' : 'disabled'}>Valider (Standard)</button><button class="btn" data-a="adm-comp" data-id="${esc(c.id)}" data-v="Prestige" ${c.profiles?.identity_verified ? '' : 'disabled'}>Valider (Prestige)</button><button class="btn ghost" data-a="adm-user" data-id="${esc(c.id)}">Fiche</button></div></div>`).join('') : '<div class="empty">Aucun profil en attente.</div>'}
  <h3>Dossiers administratifs (statut, SIRET, justificatif)</h3>${dossiers.length ? dossiers.map(c => `<form class="card stack" data-form="adm-dossier" data-id="${esc(c.id)}"><div class="row"><b class="grow">${esc((c.profiles?.first_name || '') + ' ' + (c.profiles?.last_name || ''))}</b><span class="pill t-warn">À vérifier</span></div>
    <span class="xs muted">Statut : ${esc(c.legal_status || '—')}${c.tax_id ? ` · n° ${esc(c.tax_id)}` : ''}</span>${c.admin_doc_url ? `<a class="btn ghost" href="${esc(c.admin_doc_url)}" target="_blank" rel="noopener">Voir le justificatif (10 min)</a>` : '<span class="xs muted">Aucun justificatif joint.</span>'}
    <div class="field"><label>Motif en cas de refus</label><input name="reason" maxlength="300"></div><div class="pbar"><button class="btn pri" name="ok" value="1">Valider le dossier</button><button class="btn bad" name="ok" value="0">Refuser</button></div></form>`).join('') : '<div class="empty">Aucun dossier en attente.</div>'}
  <h3>Photos à vérifier</h3>${!ph ? '<p class="muted">Chargement…</p>' : ph._err ? errBox(ph) : ph.photos.length ? ph.photos.map(x => `<form class="card stack" data-form="adm-photo" data-id="${esc(x.id)}"><div class="row"><b class="grow">${esc((x.companions?.profiles?.first_name || '') + ' ' + (x.companions?.profiles?.last_name || ''))}</b><span class="pill t-warn">${x.is_reference ? 'Photo de référence' : 'Nouvelle photo'}</span>${x.ai_suspect ? '<span class="pill t-bad">Image IA suspectée</span>' : ''}</div>
    <div class="ivcmp"><div class="gtile">${x.current_url ? `<img src="${esc(x.current_url)}" alt="Photo actuelle" style="width:100%;aspect-ratio:1;object-fit:cover">` : '<span class="muted sm">Aucune photo validée</span>'}<i>Photo actuelle</i></div><div class="gtile"><img src="${esc(x.url || '')}" alt="Nouvelle photo" style="width:100%;aspect-ratio:1;object-fit:cover"><i>Nouvelle photo</i></div></div>
    <div class="field"><label>Motif en cas de refus</label><input name="reason" maxlength="200" placeholder="Ex. : photo retouchée, visage non visible"></div>
    <div class="pbar"><button class="btn pri" name="ok" value="1">Photo authentique, valider</button><button class="btn bad" name="ok" value="0">Refuser</button></div></form>`).join('') : '<div class="empty">Aucune photo en attente.</div>'}
  <p class="xs muted">Chaque photo est vérifiée par une personne de l'équipe avant d'être visible ; une décision peut être contestée.</p>
  <h3>Avis à modérer</h3>${!rv ? '<p class="muted">Chargement…</p>' : rv._err ? errBox(rv) : rv.reviews.length ? rv.reviews.map(r => `<div class="card row"><div class="grow"><span class="stars">${'★'.repeat(r.stars)}</span> <span class="sm ugc">${esc(r.body || '')}</span><div class="xs muted">${esc(r.author)} → ${esc(r.target)} · ${esc(r.bookings?.ref || '')}</div></div><button class="btn pri" data-a="adm-rev" data-id="${esc(r.id)}" data-v="1">Publier</button><button class="btn" data-a="adm-rev" data-id="${esc(r.id)}" data-v="0">Masquer</button></div>`).join('') : '<div class="empty">Aucun avis en attente.</div>'}</section>`;
}

/* ---------- 4. Réservations ---------- */
const BST = ['en_attente', 'acceptee', 'confirmee', 'controle', 'verifie', 'en_cours', 'fin_declaree', 'double_attente', 'terminee', 'versement', 'cloturee', 'annulee', 'refusee', 'expiree', 'absence', 'contestee', 'a_verifier', 'incident'];
function vBookings() {
  const F = AD.bf || (AD.bf = { status: '', q: '', from: '', to: '', page: 0 });
  const d = need('bookings', () => admApi('bookings', F));
  return `<section class="section"><h2>Réservations</h2><form class="row" data-form="adm-bookings" style="flex-wrap:wrap;gap:8px"><input name="q" value="${esc(F.q)}" placeholder="Référence (CMP-…)" aria-label="Référence" style="width:160px">
  <select name="status" aria-label="Statut"><option value="">Tous les statuts</option>${BST.map(s => `<option value="${s}" ${F.status === s ? 'selected' : ''}>${esc((ST[s] || [s])[0])}</option>`).join('')}</select>
  <label class="xs">Du <input type="date" name="from" value="${esc(F.from)}"></label><label class="xs">au <input type="date" name="to" value="${esc(F.to)}"></label><button class="btn pri">Filtrer</button></form>
  ${!d ? '<p class="muted">Chargement…</p>' : d._err ? errBox(d) : d.bookings.length ? `<div class="tbl"><table class="t"><tr><th>Réf.</th><th>Date</th><th>Client</th><th>Accompagnateur</th><th>Statut</th><th>Total</th><th>Commission</th><th></th></tr>
  ${d.bookings.map(b => `<tr><td class="num">${esc(b.ref)}</td><td>${dts(b.starts_at)} · ${b.hours} h</td><td>${esc(b.client)}</td><td>${esc(b.companion)}</td><td>${pillS(b.status)}</td><td class="num">${eur(+b.amount_total)}</td><td class="num">${eur(+b.amount_commission)}</td><td><button class="btn" data-a="adm-resa" data-id="${esc(b.id)}">Détails</button></td></tr>`).join('')}</table></div>${pager('bookings', d)}` : '<div class="empty">Aucune réservation.</div>'}
  <div class="acts"><button class="btn" data-a="adm-csv-b">Export des réservations affichées (CSV)</button></div></section>`;
}
EXTRA_SHEETS.admresa = (s, h) => {
  const k = 'resa:' + s.id, d = AD[k];
  if (d === undefined) { AD[k] = null; admApi('booking_detail', { booking_id: s.id }).then(v => { AD[k] = v; render(); }).catch(e => { AD[k] = { _err: e.message }; render(); }); }
  if (!d) return h('Réservation', '') + '<p class="muted">Chargement…</p>';
  if (d._err) return h('Réservation', '') + `<p class="note t-bad">${esc(d._err)}</p>`;
  const b = d.booking, canCancel = ['en_attente', 'acceptee', 'confirmee', 'controle'].includes(b.status);
  const row = (l, v, cls = '') => `<tr><td>${l}</td><td class="num ${cls}" style="text-align:right">${v}</td></tr>`;
  return h(esc(b.ref), `${esc(b.client || '')} avec ${esc(b.companion || '')} · ${dts(b.starts_at)} · ${b.hours} h`) + `<div class="stack">
  <div class="row">${pillS(b.status)}<span class="xs muted">${esc(b.category)} · ${esc(b.place)}${b.language ? ' · ' + esc(b.language) : ''}</span></div>
  <div class="card"><div class="tbl" style="border:0"><table class="t" style="min-width:0">${row('Prestation', eur(+b.amount_service))}${row('Frais de service client HT', eur(+b.amount_client_fee))}${row('TVA sur les frais', eur(+b.amount_vat))}${+b.amount_annex ? row('Frais annexes', eur(+b.amount_annex)) : ''}${+b.gift_used ? row('Carte cadeau utilisée', '−' + eur(+b.gift_used)) : ''}
  ${row('<b>Total payé par le client</b>', '<b>' + eur(+b.amount_total) + '</b>')}${row('Commission ZYNTELL', eur(+b.amount_commission))}${row('Versement à l\'accompagnateur', eur(+b.amount_payout))}${+b.tip ? row('Pourboire', eur(+b.tip)) : ''}</table></div><p class="xs muted">${b.has_payment ? 'Paiement Stripe enregistré.' : 'Aucun paiement enregistré.'}</p></div>
  <div class="card stack sm"><b>Mouvements financiers</b>${d.ledger.length ? d.ledger.map(l => `<div class="row"><span class="grow">${esc(l.kind)}</span><span class="xs muted">${dts(l.created_at)}</span><span class="num">${eur(+l.amount)}</span></div>`).join('') : '<p class="muted">Aucun.</p>'}</div>
  ${d.disputes.length ? `<div class="card stack sm"><b>Litiges</b>${d.disputes.map(x => `<div>${esc(x.reason)} · ${esc(x.status)}${x.decision ? ' · ' + esc(x.decision) : ''}</div>`).join('')}</div>` : ''}
  ${d.invoices.length ? `<div class="card stack sm"><b>Factures</b>${d.invoices.map(x => `<div>${esc(x.number)} · ${esc(x.kind)} · ${eur(+x.total)}</div>`).join('')}</div>` : ''}
  <div class="card stack sm"><b>Historique</b>${d.events.map(e => `<div class="xs"><span class="muted">${dts(e.created_at)}</span> · ${esc(e.actor_name)} · ${esc(e.status ? (ST[e.status] || [e.status])[0] : '')}${e.note ? ' · ' + esc(e.note) : ''}</div>`).join('') || '<p class="muted">Aucun événement.</p>'}</div>
  <div class="pbar">${canCancel ? `<button class="btn bad" data-a="adm-cancel-resa" data-id="${esc(b.id)}">Annuler et rembourser le client</button>` : ''}${b.status === 'versement' ? `<button class="btn pri" data-a="adm-payout" data-id="${esc(b.id)}">Exécuter le versement</button>` : ''}<button class="btn ghost" data-a="adm-user" data-id="${esc(b.client_id)}">Fiche du client</button><button class="btn ghost" data-a="adm-user" data-id="${esc(b.companion_id)}">Fiche de l'accompagnateur</button></div>
  ${canCancel ? '<p class="xs muted">Une annulation par l\'équipe rembourse le client à 100 % et prévient les deux parties. Un nouveau code de double authentification est demandé.</p>' : ''}</div>`;
};

/* ---------- 5. Finances (chiffre d'affaires, commissions, remboursements, transactions) ---------- */
function vFinances() {
  const y = new Date().getFullYear(), F = AD.ff || (AD.ff = { from: `${y}-01-01`, to: new Date(Date.now() + 86400e3).toISOString().slice(0, 10) });
  const d = need('fin', () => admApi('finance', F)), TF = AD.tf || (AD.tf = { kind: '', page: 0 }), tx = need('tx', () => admApi('transactions', TF));
  const f = d && !d._err ? d.finance : null, R = d && !d._err ? d.rules : null;
  const line = (l, v, n, cls = 't-ok') => `<tr><td>${l}</td><td><span class="pill ${cls}">${n}</span></td><td class="num" style="text-align:right">${eur(+v)}</td></tr>`;
  return `<section class="section"><h2>Finances</h2><form class="row" data-form="adm-fin" style="flex-wrap:wrap;gap:8px"><label class="xs">Du <input type="date" name="from" value="${esc(F.from)}"></label><label class="xs">au <input type="date" name="to" value="${esc(F.to)}"></label><button class="btn pri">Calculer</button></form>
  ${!d ? '<p class="muted">Chargement…</p>' : d._err ? errBox(d) : `<div class="kpis">${kpi('Encaissé', eur(+f.encaisse))}${kpi('Chiffre d\'affaires HT', eur(+f.chiffre_affaires_ht))}${kpi('Commissions ZYNTELL', eur(+f.commissions))}${kpi('Remboursements', eur(+f.rembourse))}</div>
  <div class="card stack"><span class="lbl">Détail de la période</span><div class="tbl" style="border:0"><table class="t" style="min-width:0"><tr><th>Indicateur</th><th>Nature</th><th style="text-align:right">Montant</th></tr>
  ${line('Montants encaissés (paiements clients)', f.encaisse, 'Réel')}${line('Remboursements aux clients', f.rembourse, 'Remboursé', 't-bad')}${line('Versements aux accompagnateurs', f.verse, 'Réel')}${line('Pourboires (reversés en totalité)', f.pourboires, 'Réel')}
  ${line(`Volume des prestations terminées (${f.prestations_terminees})`, f.volume_prestations, 'Acquis')}${line('Frais de service clients HT', f.frais_service_ht, 'Acquis')}${line('Commissions ZYNTELL', f.commissions, 'Acquis')}${line('<b>Chiffre d\'affaires ZYNTELL HT</b>', f.chiffre_affaires_ht, 'Acquis')}${line('TVA collectée sur les frais de service', f.tva_collectee, 'À reverser', 't-warn')}
  ${line('Fonds détenus (prestations payées non terminées)', f.fonds_detenus, 'En attente', 't-warn')}</table></div>
  <p class="xs muted">Règles appliquées à chaque réservation : frais de service client ${R ? R.client_fee_pct : 15} % (+ TVA ${R ? R.vat_pct : 20} %), ${R ? R.privilege_fee_pct : 10} % pour les membres Privilège ; commission accompagnateur ${R ? R.companion_fee_pct : 20} %. Les montants sont ceux enregistrés lors de chaque réservation et dans le grand livre Stripe.</p></div>
  ${barChart((f.par_mois || []).map(m => ({ label: new Intl.DateTimeFormat(LOC(), { month: 'short' }).format(new Date(m.mois + '-01T12:00:00')), v: +m.ca_ht })), 'Chiffre d\'affaires ZYNTELL HT — 12 mois')}
  ${barChart((f.par_mois || []).map(m => ({ label: new Intl.DateTimeFormat(LOC(), { month: 'short' }).format(new Date(m.mois + '-01T12:00:00')), v: +m.rembourse })), 'Remboursements — 12 mois')}`}
  </section><section class="section"><div class="row"><h3 class="grow">Transactions</h3><select data-adm-txkind aria-label="Type de mouvement"><option value="">Tous les mouvements</option>${['Encaissement', 'Remboursement', 'Versement', 'Pourboire'].map(k => `<option ${TF.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select><button class="btn" data-a="adm-csv-tx">Export CSV</button></div>
  ${!tx ? '<p class="muted">Chargement…</p>' : tx._err ? errBox(tx) : tx.transactions.length ? `<div class="tbl"><table class="t"><tr><th>Date</th><th>Mouvement</th><th>Réservation</th><th>Référence Stripe</th><th style="text-align:right">Montant</th></tr>${tx.transactions.map(t => `<tr><td>${dts(t.created_at)}</td><td>${esc(t.kind)}</td><td class="num">${esc(t.bookings?.ref || '—')}</td><td class="xs num">${esc(t.stripe_object_id || '—')}</td><td class="num" style="text-align:right">${eur(+t.amount)}</td></tr>`).join('')}</table></div>${pager('tx', tx)}` : '<div class="empty">Aucun mouvement.</div>'}</section>`;
}

/* ---------- 6. Litiges ---------- */
function vDisputes() {
  const d = need('disp', () => admApi('disputes')), h = need('disph', () => admApi('disputes', { status: 'decide' }));
  if (!d) return loading(); if (d._err) return errBox(d);
  return `<section class="section"><h2>Centre de résolution</h2><p class="muted sm">Chaque décision est motivée, notifiée aux deux parties et journalisée. Un nouveau code de double authentification est demandé.</p>
  ${d.disputes.length ? d.disputes.map(x => `<form class="card stack" data-form="adm-decide" data-id="${esc(x.id)}"><div class="row"><b class="grow">${esc(x.bookings?.ref || '')} · ${esc(x.reason)}</b><span class="pill ${Date.parse(x.deadline) < Date.now() ? 't-bad' : 't-warn'}">Échéance ${dts(x.deadline)}</span></div><p class="sm ugc">${esc(x.description)}</p><span class="xs muted">Montant payé ${eur(+(x.bookings?.amount_total || 0))} · versement prévu ${eur(+(x.bookings?.amount_payout || 0))}</span>
    <div class="field"><label>Décision</label><select name="decision"><option value="payout">Prestation réalisée : verser l'accompagnateur</option><option value="refund">Rembourser le client</option></select></div><div class="field"><label>Remboursement du client (%)</label><input name="pct" type="number" min="0" max="100" value="100" inputmode="numeric"></div><div class="field"><label>Motif de la décision (obligatoire)</label><textarea name="note" rows="2"></textarea></div><button class="btn pri">Enregistrer la décision</button></form>`).join('') : '<div class="empty">Aucun litige ouvert.</div>'}</section>
  <section class="section"><h3>Historique des décisions</h3>${h && !h._err && h.disputes.length ? `<div class="tbl"><table class="t"><tr><th>Date</th><th>Réservation</th><th>Motif</th><th>Décision</th></tr>${h.disputes.map(x => `<tr><td>${dts(x.created_at)}</td><td class="num">${esc(x.bookings?.ref || '')}</td><td>${esc(x.reason)}</td><td>${esc(x.decision || '')}</td></tr>`).join('')}</table></div>` : '<div class="empty">Aucune décision pour le moment.</div>'}</section>`;
}

/* ---------- 7. Assistance ---------- */
const SUPS = { ouverte: ['Nouvelle', 'warn'], en_cours: ['En cours', 'info'], repondue: ['Répondue', 'ok'], resolue: ['Résolue', 'muted'], fermee: ['Fermée', 'muted'] };
const SUPC = { reservation: 'Réservation', paiement: 'Paiement', compte: 'Compte', securite: 'Sécurité', accompagnateur: 'Accompagnateur', technique: 'Technique', suppression: 'Suppression de compte', autre: 'Autre' };
function vSupport() {
  const F = AD.sf || (AD.sf = { status: '', q: '', page: 0 });
  const d = need('sup', () => admApi('support_list', F));
  return `<section class="section"><div class="row"><h2 class="grow">Assistance</h2><button class="btn ghost" data-a="adm-refresh">Actualiser</button></div>
  <div class="row" role="group" aria-label="Filtrer" style="flex-wrap:wrap;gap:6px">${[['', 'À traiter'], ['repondue', 'Répondues'], ['resolue', 'Résolues'], ['fermee', 'Fermées']].map(([v, l]) => `<button class="chip ${F.status === v ? 'on' : ''}" data-a="adm-supf" data-v="${v}" aria-pressed="${F.status === v}">${l}</button>`).join('')}</div>
  ${!d ? '<p class="muted">Chargement…</p>' : d._err ? errBox(d) : d.tickets.length ? `<div class="tbl"><table class="t"><tr><th>Réf.</th><th>Membre</th><th>Sujet</th><th>Catégorie</th><th>Dernier message</th><th>Statut</th><th></th></tr>${d.tickets.map(t => `<tr><td class="num">${esc(t.ref)}${t.priority === 'haute' ? ' <span class="pill t-bad">Prioritaire</span>' : ''}</td><td>${esc(t.user)}</td><td>${esc(t.subject)}</td><td>${esc(SUPC[t.category] || t.category)}</td><td>${dts(t.last_message_at)}</td><td><span class="pill t-${(SUPS[t.status] || ['', 'muted'])[1]}">${esc((SUPS[t.status] || [t.status])[0])}</span></td><td><button class="btn" data-a="adm-ticket" data-id="${esc(t.id)}">Ouvrir</button></td></tr>`).join('')}</table></div>${pager('sup', d)}` : '<div class="empty">Aucune demande.</div>'}
  <p class="xs muted">Les demandes arrivent depuis l'application (Compte → Aide et assistance). L'assistance par e-mail (contact@zyntell.fr) reste disponible.</p></section>`;
}
EXTRA_SHEETS.admticket = (s, h) => {
  const k = 'tk:' + s.id, d = AD[k];
  if (d === undefined) { AD[k] = null; admApi('support_detail', { ticket_id: s.id }).then(v => { AD[k] = v; render(); }).catch(e => { AD[k] = { _err: e.message }; render(); }); }
  if (!d) return h('Demande d\'assistance', '') + '<p class="muted">Chargement…</p>';
  if (d._err) return h('Demande d\'assistance', '') + `<p class="note t-bad">${esc(d._err)}</p>`;
  const t = d.ticket;
  return h(esc(t.subject), `${esc(t.ref)} · ${esc(SUPC[t.category] || t.category)} · ${esc(t.user || '')}`) + `<div class="stack">
  <div class="card sm stack"><div><b>Membre</b> : ${esc(t.user || '')} (${roleLbl(t.role)}) · ${esc(t.email || '')}${t.phone ? ' · ' + esc(t.phone) : ''}</div>${t.bookings?.ref ? `<div><b>Réservation</b> : ${esc(t.bookings.ref)}${t.booking_id ? ` <button class="linkbtn" data-a="adm-resa" data-id="${esc(t.booking_id)}">voir</button>` : ''}</div>` : ''}<div><span class="pill t-${(SUPS[t.status] || ['', 'muted'])[1]}">${esc((SUPS[t.status] || [t.status])[0])}</span> <button class="linkbtn" data-a="adm-user" data-id="${esc(t.user_id)}">Fiche du membre</button></div></div>
  ${d.messages.map(m => `<div class="card sm" style="${m.from_staff ? 'border-color:var(--gold)' : ''}"><b>${esc(m.author)}</b> <span class="xs muted">${dts(m.created_at)}</span><p class="ugc" style="margin:.3em 0 0;white-space:pre-wrap">${esc(m.body)}</p></div>`).join('')}
  ${t.status === 'fermee' ? '<p class="muted sm">Demande fermée.</p>' : `<form class="card stack" data-form="adm-sup-reply" data-id="${esc(t.id)}"><div class="field"><label for="sr-b">Réponse au membre</label><textarea id="sr-b" name="body" rows="4" maxlength="3000"></textarea></div>
  <div class="field"><label for="sr-s">Statut après la réponse</label><select id="sr-s" name="status"><option value="repondue">Répondue</option><option value="en_cours">En cours (traitement à poursuivre)</option><option value="resolue">Résolue</option><option value="fermee">Fermée</option></select></div>
  <p class="xs muted">Le membre est prévenu dans l'application (et par e-mail si l'envoi est configuré).</p><button class="btn pri">Envoyer la réponse</button></form>
  <div class="pbar"><button class="btn ghost" data-a="adm-sup-st" data-id="${esc(t.id)}" data-v="en_cours">Prendre en charge</button><button class="btn ghost" data-a="adm-sup-st" data-id="${esc(t.id)}" data-v="resolue">Marquer résolue</button><button class="btn ghost" data-a="adm-sup-st" data-id="${esc(t.id)}" data-v="fermee">Fermer</button></div>`}</div>`;
};

/* ---------- 8. Journal (actions et connexions) ---------- */
const EVL = { login_ok: 'Mot de passe correct', login_fail: 'Échec de connexion', mfa_ok: 'Connexion réussie (TOTP)', mfa_fail: 'Code TOTP incorrect', locked: 'Accès bloqué 15 min', unlocked: 'Accès débloqué', logout: 'Déconnexion', timeout: 'Déconnexion après inactivité', stepup_ok: 'Confirmation de sécurité', stepup_fail: 'Confirmation refusée', refused: 'Tentative pendant un blocage', password_changed: 'Mot de passe modifié', totp_reset: 'Double authentification réinitialisée', new_device: 'Nouvel appareil' };
function vAudit() {
  const F = AD.af || (AD.af = { q: '', from: '', to: '', page: 0 }), E = AD.ef || (AD.ef = { page: 0 });
  const d = need('audit', () => admApi('audit', F)), ev = need('authev', () => admApi('auth_events', E));
  return `<section class="section"><h2>Journal d'audit</h2><p class="muted sm">Chaque décision et chaque consultation sensible est horodatée. Le journal ne peut être ni modifié ni supprimé.</p>
  <form class="row" data-form="adm-audit" style="flex-wrap:wrap;gap:8px"><input name="q" value="${esc(F.q)}" placeholder="Rechercher une action" style="flex:1;min-width:180px"><label class="xs">Du <input type="date" name="from" value="${esc(F.from)}"></label><label class="xs">au <input type="date" name="to" value="${esc(F.to)}"></label><button class="btn pri">Filtrer</button></form>
  ${!d ? '<p class="muted">Chargement…</p>' : d._err ? errBox(d) : d.logs.length ? `<div class="tbl"><table class="t"><tr><th>Horodatage</th><th>Acteur</th><th>Action</th><th>Réf.</th></tr>${d.logs.map(l => `<tr><td class="num">${fts(Date.parse(l.created_at))}</td><td>${esc(l.actor)}</td><td>${esc(l.action)}</td><td class="num xs">${esc(l.ref || '')}</td></tr>`).join('')}</table></div>${pager('audit', d)}` : '<div class="empty">Journal vide.</div>'}</section>
  <section class="section"><h3>Connexions à l'espace de gestion</h3>${!ev ? '<p class="muted">Chargement…</p>' : ev._err ? errBox(ev) : ev.events.length ? `<div class="tbl"><table class="t"><tr><th>Horodatage</th><th>Compte</th><th>Événement</th><th>Adresse IP</th><th>Navigateur</th></tr>${ev.events.map(e => `<tr><td class="num">${fts(Date.parse(e.created_at))}</td><td class="xs">${esc(e.email || '')}</td><td>${/fail|locked|refused|new_device/.test(e.event) ? `<span class="pill t-bad">${esc(EVL[e.event] || e.event)}</span>` : esc(EVL[e.event] || e.event)}</td><td class="num xs">${esc(e.ip || '')}</td><td class="xs muted">${esc((e.user_agent || '').slice(0, 60))}</td></tr>`).join('')}</table></div>${pager('authev', ev)}` : '<div class="empty">Aucune connexion enregistrée.</div>'}
  <p class="xs muted">Les mots de passe et codes ne sont jamais enregistrés.</p></section>`;
}

/* ---------- 9. Paramètres, équipe, annonces, sécurité ---------- */
const SET_FIELDS = [['client_fee_pct', 'Frais de service client (%)', 0, 30, .5], ['companion_fee_pct', 'Commission accompagnateur (%)', 0, 40, .5], ['privilege_fee_pct', 'Frais client Privilège (%)', 0, 30, .5], ['privilege_price_eur', 'Abonnement Privilège (€/mois)', 0, 100, .1], ['vat_pct', 'TVA sur les frais (%)', 0, 30, .1],
  ['referral_eur', 'Crédit de parrainage (€)', 0, 100, 1], ['min_hours', 'Durée minimale (h)', 1, 12, 1], ['max_hours', 'Durée maximale (h)', 1, 24, 1], ['dispute_days', 'Délai de traitement d\'un litige (j)', 1, 30, 1], ['noshow_pct', 'Indemnité d\'absence du client (%)', 0, 100, 1],
  ['cancel_early_pct', 'Annulation plus de 48 h avant (% remboursé)', 0, 100, 1], ['cancel_mid_pct', 'Annulation entre 24 et 48 h (% remboursé)', 0, 100, 1], ['cancel_late_pct', 'Annulation moins de 24 h (% remboursé)', 0, 100, 1]];
function vSettings() {
  const st = need('settings', () => admApi('settings_get')), ad = need('admins', () => admApi('admins')), an = need('ann', () => admApi('announcements'));
  const sup = AD.me && AD.me.level === 'super';
  const sv = st && !st._err ? st.settings : null;
  return `<section class="section"><h2>Paramètres</h2>
  ${!st ? '<p class="muted">Chargement…</p>' : st._err ? errBox(st) : `<form class="card stack" data-form="adm-settings"><h3>Paramètres financiers et règles</h3>${sup ? '' : '<p class="note t-warn sm">Lecture seule : seul le dirigeant (super-administrateur) peut modifier ces paramètres.</p>'}
  <div class="row" style="flex-wrap:wrap">${SET_FIELDS.map(([k, l, lo, hi, stp]) => `<div class="field grow" style="min-width:210px"><label for="st-${k}">${l}</label><input id="st-${k}" type="number" name="${k}" min="${lo}" max="${hi}" step="${stp}" value="${esc(sv[k] ?? '')}" ${sup ? '' : 'disabled'}></div>`).join('')}</div>
  ${'insurance_required' in sv ? `<label class="row sm"><input type="checkbox" name="insurance_required" ${sv.insurance_required ? 'checked' : ''} ${sup ? '' : 'disabled'}> Assurance responsabilité civile obligatoire pour recevoir des réservations</label>` : ''}
  <p class="xs muted">Les nouvelles règles s'appliquent aux nouvelles réservations ; elles sont affichées au client avant tout paiement. Modification journalisée (avant / après), nouveau code de double authentification demandé.</p>${sup ? '<button class="btn pri">Enregistrer</button>' : ''}</form>`}</section>
  <section class="section"><h3>Équipe d'administration</h3>${!ad ? '<p class="muted">Chargement…</p>' : ad._err ? errBox(ad) : `<div class="tbl"><table class="t"><tr><th>Membre</th><th>E-mail</th><th>Niveau</th><th>Double authentification</th><th>Dernière connexion</th><th>État</th>${sup ? '<th>Actions</th>' : ''}</tr>
  ${ad.admins.map(x => `<tr><td><b>${esc((x.first_name || '') + ' ' + (x.last_name || ''))}</b></td><td class="xs">${esc(x.email)}</td><td>${x.level === 'super' ? '<span class="chip gold">Dirigeant</span>' : 'Administrateur'}</td><td>${x.totp ? '<span class="pill t-ok">Active</span>' : '<span class="pill t-warn">À activer</span>'}</td><td>${x.last_login ? dts(x.last_login) : '—'}</td>
    <td>${x.revoked_at ? '<span class="pill t-muted">Accès retiré</span>' : x.locked_until && Date.parse(x.locked_until) > Date.now() ? '<span class="pill t-bad">Bloqué</span>' : '<span class="pill t-ok">Actif</span>'}</td>
    ${sup ? `<td class="acts">${x.level !== 'super' && !x.revoked_at ? `<button class="btn" data-a="adm-unlock" data-v="${esc(x.email)}">Débloquer</button><button class="btn" data-a="adm-totp-reset" data-id="${esc(x.user_id)}">Réinitialiser la double authentification</button><button class="btn bad" data-a="adm-revoke" data-id="${esc(x.user_id)}">Retirer l'accès</button>` : ''}</td>` : ''}</tr>`).join('')}</table></div>
  ${sup ? `<form class="card stack" data-form="adm-create"><h3>Ajouter un administrateur</h3><div class="row" style="flex-wrap:wrap"><div class="field grow"><label for="ac-f">Prénom</label><input id="ac-f" name="first_name"></div><div class="field grow"><label for="ac-l">Nom</label><input id="ac-l" name="last_name"></div><div class="field grow" style="min-width:240px"><label for="ac-e">E-mail professionnel dédié</label><input id="ac-e" name="email" type="email"></div></div>
  <p class="xs muted">Un mot de passe provisoire s'affiche une seule fois : transmettez-le de vive voix. À la première connexion, la personne choisit son mot de passe et active sa double authentification.</p><button class="btn pri">Créer l'accès</button></form>` : '<p class="xs muted">Seul le dirigeant peut ajouter ou retirer un administrateur.</p>'}`}</section>
  <section class="section"><h3>Annonces aux membres</h3><form class="card stack" data-form="adm-announce"><div class="field"><label for="an-a">Destinataires</label><select id="an-a" name="audience"><option value="all">Tous les membres</option><option value="client">Clients</option><option value="companion">Accompagnateurs</option></select></div>
  <div class="field"><label for="an-b">Message (notification dans l'application)</label><textarea id="an-b" name="body" rows="3" maxlength="400"></textarea></div><button class="btn pri">Envoyer l'annonce</button></form>
  ${an && !an._err && an.announcements.length ? `<div class="tbl"><table class="t"><tr><th>Date</th><th>Public</th><th>Message</th><th>Destinataires</th></tr>${an.announcements.map(x => `<tr><td>${dts(x.created_at)}</td><td>${esc({ all: 'Tous', client: 'Clients', companion: 'Accompagnateurs' }[x.audience])}</td><td class="ugc">${esc(x.body)}</td><td class="num">${x.recipients}</td></tr>`).join('')}</table></div>` : ''}</section>
  <section class="section"><h3>Sécurité de mon compte</h3><div class="card stack sm"><div class="row"><b class="grow">Double authentification</b><span class="pill t-ok">Active</span></div><div class="row"><b class="grow">Déconnexion automatique</b><span>après 15 minutes d'inactivité</span></div><div class="row"><b class="grow">Opérations sensibles</b><span>nouveau code demandé</span></div><div class="row"><b class="grow">Niveau</b><span>${sup ? 'Dirigeant (super-administrateur)' : 'Administrateur'}</span></div></div>
  <form class="card stack" data-form="adm-mypw"><b>Changer mon mot de passe</b><div class="field"><label for="mp-1">Nouveau mot de passe</label><input id="mp-1" name="pw" type="password" autocomplete="new-password"></div><div class="field"><label for="mp-2">Confirmation</label><input id="mp-2" name="pw2" type="password" autocomplete="new-password"></div><button class="btn">Enregistrer</button></form>
  <button class="btn bad full" data-a="adm-logout">Se déconnecter</button></section>`;
}

/* ---------- Interactions ---------- */
async function admRun(p, ok, keys) { try { const r = await p; if (ok) toast(ok); refreshAll(keys); return r; } catch (e) { if (e.message !== 'annulé') toast(e.message, true); render(); return null; } }
function v30AdminClick(a, el, id, v) {
  switch (a) {
    case 'tab': if (S.role === 'admin' && ADMIN_TABS.includes(v)) { S.tab = v; S.sheet = null; render(); window.scrollTo(0, 0); return true; } return false;
    case 'adm-refresh': refreshAll(); return true;
    case 'notifs': if (S.role === 'admin') { S.tab = 'dashboard'; S.sheet = null; render(); return true; } return false;
    case 'security': if (S.role === 'admin') { S.tab = 'settings'; S.sheet = null; render(); return true; } return false;
    case 'adm-cancel': admLogout('deconnexion'); return true;
    case 'adm-logout': admLogout('deconnexion', 'Vous êtes déconnecté.'); return true;
    case 'adm-page': { const [k, p] = v.split('|'), map = { users: 'uf', bookings: 'bf', tx: 'tf', sup: 'sf', audit: 'af', authev: 'ef' }; AD[map[k]].page = Math.max(0, +p); delete AD[k]; render(); return true; }
    case 'adm-user': delete AD['user:' + id]; open('admuser', { id }); render(); return true;
    case 'adm-resa': delete AD['resa:' + id]; open('admresa', { id }); render(); return true;
    case 'adm-ticket': delete AD['tk:' + id]; open('admticket', { id }); render(); return true;
    case 'adm-notif-read': admRun(admApi('notifications_read'), null, ['dash']); return true;
    case 'adm-comp': admRun(admApi('companion_review', { companion_id: id, approve: true, tier: v }), 'Profil validé.', ['ov', 'users', 'user:' + id]); return true;
    case 'adm-dossier': admRun(admApi('admin_review', { companion_id: id, approve: true }), 'Dossier administratif validé.', ['ov', 'user:' + id]); return true;
    case 'adm-rev': admRun(admApi('review_moderate', { review_id: id, publish: v === '1' }), v === '1' ? 'Avis publié.' : 'Avis masqué.', ['reviews']); return true;
    case 'adm-cancel-resa': if (S._admConfirm !== id) { S._admConfirm = id; toast('Touchez à nouveau pour confirmer l\'annulation et le remboursement.'); render(); return true; }
      S._admConfirm = null; admRun(admCall('refund-booking', { booking_id: id }), 'Réservation annulée : le client est remboursé.', ['bookings', 'resa:' + id, 'fin', 'tx', 'dash']); return true;
    case 'adm-payout': admRun(admCall('release-payout', { booking_id: id }), 'Versement exécuté.', ['bookings', 'resa:' + id, 'fin', 'tx']); return true;
    case 'adm-supf': AD.sf = { status: v, q: '', page: 0 }; delete AD.sup; render(); return true;
    case 'adm-sup-st': admRun(admApi('support_status', { ticket_id: id, status: v }), 'Statut mis à jour.', ['sup', 'tk:' + id, 'dash']); return true;
    case 'adm-unlock': admRun(admApi('admin_unlock', { email: v }), 'Accès débloqué.', ['admins']); return true;
    case 'adm-totp-reset': if (S._admConfirm !== id) { S._admConfirm = id; toast('Touchez à nouveau pour confirmer la réinitialisation.'); render(); return true; }
      S._admConfirm = null; admRun(admApi('admin_reset_totp', { user_id: id }), 'Double authentification réinitialisée : nouvelle association à la prochaine connexion.', ['admins']); return true;
    case 'adm-revoke': if (S._admConfirm !== id) { S._admConfirm = id; toast('Touchez à nouveau pour confirmer le retrait de l\'accès.'); render(); return true; }
      S._admConfirm = null; admRun(admApi('admin_revoke', { user_id: id }), 'Accès administrateur retiré.', ['admins']); return true;
    case 'adm-csv-b': { const d = AD.bookings; if (!d || !d.bookings) return true; admDl(`reservations-${new Date().toISOString().slice(0, 10)}.csv`, [csvLine(['Référence', 'Date', 'Client', 'Accompagnateur', 'Statut', 'Total', 'Commission', 'Frais client HT', 'Versement']), ...d.bookings.map(b => csvLine([b.ref, b.starts_at, b.client, b.companion, b.status, b.amount_total, b.amount_commission, b.amount_client_fee, b.amount_payout]))].join('\n')); return true; }
    case 'adm-csv-tx': { const d = AD.tx; if (!d || !d.transactions) return true; admDl(`transactions-${new Date().toISOString().slice(0, 10)}.csv`, [csvLine(['Date', 'Mouvement', 'Réservation', 'Référence Stripe', 'Montant']), ...d.transactions.map(t => csvLine([t.created_at, t.kind, t.bookings?.ref || '', t.stripe_object_id || '', t.amount]))].join('\n')); return true; }
    case 'close': if (S.sheet && S.sheet.type === 'stepup' && admStepWait) { admStepWait.ko(new Error('annulé')); admStepWait = null; } return false;
    default: return false;
  }
}
function v30AdminSubmit(k, f, d) {
  const btnOk = () => { const b = document.activeElement; return b && b.name === 'ok' ? b.value === '1' : (f._okv ?? true); };
  const err = (m) => { G.err = m; G.busy = false; render(); };
  switch (k) {
    case 'adm-login': {
      G.busy = true; G.err = ''; G.info = ''; render();
      admAuth({ action: 'login', email: d.email, password: d.password }).then(async r => {
        if (!r.session) return err(r.error || 'Connexion impossible.');
        const { error } = await SB.auth.setSession({ access_token: r.session.access_token, refresh_token: r.session.refresh_token });
        if (error) return err('Connexion impossible.');
        try { await admStartMfa(); } catch (e) { return err('Impossible de préparer la double authentification.'); }
        G.busy = false; render();
      }).catch(() => err('Le serveur ne répond pas. Réessayez.'));
      return true;
    }
    case 'adm-mfa': {
      const code = String(d.code || '').replace(/\D/g, ''); if (code.length !== 6) return err('Saisissez les 6 chiffres du code.'), true;
      G.busy = true; render();
      admToken().then(async s => {
        const r = await admAuth({ action: 'mfa_verify', access_token: s && s.access_token, refresh_token: s && s.refresh_token, code, factor_id: G.factorId });
        if (!r.session) return err(r.error || 'Code incorrect.');
        await SB.auth.setSession({ access_token: r.session.access_token, refresh_token: r.session.refresh_token });
        G.busy = false; G.qr = null; G.secret = null;
        if (r.must_change_password) { G.step = 'pw'; render(); return; }
        try { await admEnter(); } catch (e) { err(e.message); }
      }).catch(() => err('Le serveur ne répond pas. Réessayez.'));
      return true;
    }
    case 'adm-pw': case 'adm-mypw': {
      if ((d.pw || '') !== (d.pw2 || '')) { if (k === 'adm-pw') err('Les deux mots de passe ne correspondent pas.'); else toast('Les deux mots de passe ne correspondent pas.', true); return true; }
      admToken().then(async s => {
        const r = await admAuth({ action: 'change_password', password: d.pw }, s && s.access_token);
        if (!r.ok) { if (k === 'adm-pw') return err(r.error || 'Mot de passe refusé.'); return toast(r.error || 'Mot de passe refusé.', true); }
        // Le serveur ferme toutes les sessions du compte : reconnexion avec le nouveau mot de passe et le code TOTP
        await admLogout('mot_de_passe', 'Mot de passe enregistré. Reconnectez-vous avec votre nouveau mot de passe et votre code de double authentification.');
      });
      return true;
    }
    case 'adm-stepup': {
      const code = String(d.code || '').replace(/\D/g, ''), e = document.getElementById('su-err');
      if (code.length !== 6) { if (e) { e.textContent = 'Saisissez les 6 chiffres.'; e.hidden = false; } return 'stop'; }
      admToken().then(async s => {
        const r = await admAuth({ action: 'stepup', code, refresh_token: s && s.refresh_token }, s && s.access_token);
        if (!r.session) { if (r.status === 401 && /Session/.test(r.error || '')) return admExpired(r.error); if (e) { e.textContent = r.error || 'Code incorrect.'; e.hidden = false; } return; }
        await SB.auth.setSession({ access_token: r.session.access_token, refresh_token: r.session.refresh_token });
        S.sheet = null; render(); const w = admStepWait; admStepWait = null; w && w.ok();
      });
      return true;
    }
    case 'adm-users': AD.uf = { q: d.q || '', role: d.role || '', status: d.status || '', page: 0 }; delete AD.users; render(); return true;
    case 'adm-bookings': AD.bf = { q: d.q || '', status: d.status || '', from: d.from || '', to: d.to || '', page: 0 }; delete AD.bookings; render(); return true;
    case 'adm-fin': AD.ff = { from: d.from, to: d.to }; delete AD.fin; render(); return true;
    case 'adm-audit': AD.af = { q: d.q || '', from: d.from || '', to: d.to || '', page: 0 }; delete AD.audit; render(); return true;
    case 'adm-id': { const ok = btnOk(), reason = (d.reason || '').trim(); if (!ok && reason.length < 5) return toast('Indiquez le motif du refus (5 caractères minimum).', true), true;
      admRun(admApi('identity_review', { check_id: f.dataset.id, approve: ok, reason }), ok ? 'Identité validée.' : 'Pièce refusée : le membre est prévenu.', ['ov', 'dash']); return true; }
    case 'adm-dossier': { const ok = btnOk(), reason = (d.reason || '').trim(); if (!ok && reason.length < 5) return toast('Indiquez le motif du refus (5 caractères minimum).', true), true;
      admRun(admApi('admin_review', { companion_id: f.dataset.id, approve: ok, reason }), ok ? 'Dossier validé.' : 'Dossier refusé : l\'accompagnateur est prévenu.', ['ov']); return true; }
    case 'adm-photo': { const ok = btnOk(), reason = (d.reason || '').trim(); if (!ok && reason.length < 5) return toast('Indiquez le motif du refus (5 caractères minimum).', true), true;
      admRun(admApi('photo_review', { photo_id: f.dataset.id, approve: ok, reason }), ok ? 'Photo validée : elle est visible sur le profil.' : 'Photo refusée : l\'accompagnateur est prévenu.', ['photos', 'dash']); return true; }
    case 'adm-suspend': { const reason = (d.reason || '').trim(); if (reason.length < 5) return toast('Indiquez le motif (5 caractères minimum).', true), true;
      const susp = f.dataset.v === '1'; admRun(admApi('suspend', { user_id: f.dataset.id, suspended: susp, reason }), susp ? 'Compte suspendu.' : 'Compte réactivé.', ['users', 'user:' + f.dataset.id, 'dash']); return true; }
    case 'adm-decide': { const note = (d.note || '').trim(); if (note.length < 5) return toast('Motivez la décision (5 caractères minimum).', true), true;
      admRun(admApi('dispute_decide', { dispute_id: f.dataset.id, decision: d.decision, refund_pct: d.decision === 'refund' ? Math.max(0, Math.min(100, +d.pct || 0)) : null, note }), 'Décision enregistrée.', ['disp', 'disph', 'dash', 'fin', 'tx']); return true; }
    case 'adm-sup-reply': { const body = (d.body || '').trim(); if (body.length < 2) return toast('Rédigez la réponse.', true), true;
      admRun(admApi('support_reply', { ticket_id: f.dataset.id, body, status: d.status }), 'Réponse envoyée au membre.', ['sup', 'tk:' + f.dataset.id, 'dash']); return true; }
    case 'adm-settings': { const s = {}; SET_FIELDS.forEach(([kk]) => { if (d[kk] !== undefined && d[kk] !== '') s[kk] = +d[kk]; }); if (f.querySelector('[name=insurance_required]')) s.insurance_required = !!f.querySelector('[name=insurance_required]').checked;
      admRun(admApi('settings_update', { settings: s }), 'Paramètres enregistrés.', ['settings', 'fin']); return true; }
    case 'adm-announce': { const body = (d.body || '').trim(); if (body.length < 5) return toast('Rédigez le message (5 caractères minimum).', true), true;
      admRun(admApi('announce', { audience: d.audience, body }).then(r => { toast(`Annonce envoyée à ${r.recipients} membre(s).`); return r; }), null, ['ann']); return true; }
    case 'adm-create': admRun(admApi('admin_create', { email: d.email, first_name: d.first_name, last_name: d.last_name }).then(r => { open('admtemp', { pw: r.temporary_password, email: d.email }); return r; }), null, ['admins']); return true;
    default: return false;
  }
}
EXTRA_SHEETS.admtemp = (s, h) => h('Accès créé', esc(s.email)) + `<div class="stack"><p class="sm">Mot de passe provisoire, affiché <b>une seule fois</b> :</p><p class="card num sel" style="font-size:1.2em;word-break:break-all">${esc(s.pw)}</p>
  <p class="xs muted">Transmettez-le de vive voix ou en personne, jamais par e-mail ni par message. À la première connexion sur /gestion, la personne choisit son mot de passe puis active Google Authenticator.</p><button class="btn pri full" data-a="close">J'ai noté le mot de passe</button></div>`;

/* ---------- Démarrage de l'espace de gestion ---------- */
function v30AdminInit() {
  if (window.__v30a) return; window.__v30a = 1;
  document.title = 'Gestion — Side by Side';
  Object.assign(T.fr, { verif: 'Vérifications', finances: 'Finances', support: 'Assistance', audit: 'Journal', users: 'Comptes', bookings: 'Réservations', dashboard: 'Tableau', settings: 'Réglages', disputes: 'Litiges' });
  Object.assign(ICON, { verif: '<path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>', finances: '<path d="M17 6.5a6.5 6.5 0 1 0 0 11M4.5 10.5h9M4.5 13.5h9"/>', support: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>' });
  if (!ICON.bookings) ICON.bookings = '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>';
  ADMIN_VIEWS = { dashboard: vDash, users: vUsers, verif: vVerif, bookings: vBookings, finances: vFinances, disputes: vDisputes, support: vSupport, audit: vAudit, settings: vSettings };
  // Aucune inscription, aucun parcours client ou accompagnateur dans l'espace de gestion
  welcome = () => admLoginPage(); signupPage = () => admLoginPage(); mfa = () => admLoginPage(); liveMfaHtml = () => admLoginPage();
  if (typeof liveLogin === 'function') liveLogin = () => admLoginPage();
  liveLoad = admLoad; liveSubscribe = () => {}; liveCall = (fn, body) => admCall(fn, body);
  ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(ev => document.addEventListener(ev, admActivity, { passive: true }));
  setInterval(admIdleWatch, 15_000);
  document.addEventListener('change', e => {
    const t = e.target;
    if (t && t.matches && t.matches('[data-adm-days]')) { AD.days = +t.value; delete AD.dash; render(); }
    if (t && t.matches && t.matches('[data-adm-txkind]')) { AD.tf = { kind: t.value, page: 0 }; delete AD.tx; render(); }
  });
  // Bouton de validation / refus dans un formulaire : mémorise le bouton utilisé
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button[name=ok]'); if (b && b.form) b.form._okv = b.value === '1'; }, true);
}
