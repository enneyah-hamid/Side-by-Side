/* =====================================================================
   V3.0 — Application mobile : assistance intégrée, accès administrateur retiré,
   photos des accompagnateurs vérifiées avant publication
   ===================================================================== */
var ADMIN_TABS = ['dashboard'];
var ADMIN_VIEWS = { dashboard: () => '' };
var ADMIN_WEB = !!(window.SBS_ADMIN_WEB);

/* ---------- Comptes de l'équipe : refusés dans l'application mobile ---------- */
function adminRefusedPage() {
  if (LIVE && !S._admOut) { S._admOut = true; setTimeout(async () => { try { await SB.auth.signOut(); } catch (e) {} ME = null; S.role = null; S.adminOk = false; S._admOut = false; toast('Les comptes de l\'équipe Side by Side se connectent uniquement à l\'espace de gestion, sur ordinateur.', true); render(); }, 0); }
  return `<section class="section"><div class="card stack"><h2>Espace réservé à l'équipe</h2><p class="muted">Les comptes de l'équipe Side by Side se connectent uniquement à l'espace de gestion sécurisé, sur ordinateur.</p></div></section>`;
}

/* ---------- Assistance : mes demandes ---------- */
const SUP_CAT = [['reservation', 'Une réservation'], ['paiement', 'Paiement ou remboursement'], ['compte', 'Mon compte'], ['securite', 'Sécurité'], ['accompagnateur', 'Mon activité d\'accompagnateur'], ['technique', 'Problème technique'], ['suppression', 'Suppression de compte'], ['autre', 'Autre question']];
const SUP_ST = { ouverte: ['Envoyée', 'info'], en_cours: ['En cours de traitement', 'warn'], repondue: ['Réponse reçue', 'ok'], resolue: ['Résolue', 'muted'], fermee: ['Fermée', 'muted'] };
function supState() { if (!S.sup) S.sup = { list: [], loaded: false, msgs: {}, busy: false }; return S.sup; }
function supDemoSeed() {
  const Q = supState(); if (Q.loaded) return; Q.loaded = true;
  const t0 = now() - 2 * DAY;
  Q.list = [{ id: 'sd1', ref: 'AS-1001', category: 'paiement', subject: 'Question sur ma facture', status: 'repondue', created_at: new Date(t0).toISOString(), last_message_at: new Date(t0 + 3 * 3600e3).toISOString() }];
  Q.msgs.sd1 = [{ from_staff: false, body: 'Bonjour, je ne trouve pas la facture de ma dernière sortie.', created_at: new Date(t0).toISOString() },
                { from_staff: true, body: 'Bonjour, vos factures se trouvent dans Réservations, puis Détails de la réservation, rubrique Facture. Bonne journée !', created_at: new Date(t0 + 3 * 3600e3).toISOString() }];
}
async function supLoad() {
  const Q = supState(); if (!LIVE) { supDemoSeed(); render(); return; }
  if (Q.busy) return; Q.busy = true;
  const { data, error } = await SB.from('support_tickets').select('id, ref, category, subject, status, created_at, last_message_at, booking_id').order('last_message_at', { ascending: false }).limit(30);
  Q.busy = false; Q.loaded = true; if (!error) Q.list = data || []; render();
}
async function supLoadMsgs(id) {
  const Q = supState(); if (!LIVE) return;
  const { data } = await SB.from('support_messages').select('from_staff, body, created_at').eq('ticket_id', id).order('created_at');
  Q.msgs[id] = data || []; render();
}
function supCard() {
  const Q = supState(); if (!Q.loaded) setTimeout(supLoad, 0);
  const rows = Q.list.map(t => { const st = SUP_ST[t.status] || [t.status, 'muted'];
    return `<button class="accrow" data-a="sup-open" data-id="${esc(t.id)}"><span class="grow"><b>${esc(t.subject)}</b><small>${esc(t.ref)} · ${fdt(Date.parse(t.last_message_at || t.created_at))}</small></span><span class="pill t-${st[1]}">${esc(st[0])}</span></button>`; }).join('');
  return `<section class="section"><div class="card stack"><div class="row"><h3 class="grow">Mes demandes d'assistance</h3><button class="btn pri" data-a="sup-new">Nouvelle demande</button></div>
  ${Q.loaded ? (rows || '<p class="sm muted">Aucune demande pour le moment.</p>') : '<p class="sm muted">Chargement…</p>'}
  <p class="xs muted">Réponse sous 24 h ouvrées, ici et dans vos notifications. Vous pouvez aussi écrire à contact@zyntell.fr. En cas de danger, appelez le 112.</p></div></section>`;
}
EXTRA_SHEETS.supnew = (s, h) => {
  const refs = (S.bookings || []).slice().sort((a, b) => b.start - a.start).slice(0, 15).map(b => b.ref).filter(Boolean);
  return h('Nouvelle demande d\'assistance', 'L\'équipe Side by Side vous répond sous 24 h ouvrées') + `<form class="stack" data-form="sup-new">
  <div class="field"><label for="sup-cat">Sujet</label><select id="sup-cat" name="category">${SUP_CAT.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
  <div class="field"><label for="sup-ref">Réservation concernée (facultatif)</label><select id="sup-ref" name="ref"><option value="">Aucune</option>${refs.map(r => `<option>${esc(r)}</option>`).join('')}</select></div>
  <div class="field"><label for="sup-sub">Titre</label><input id="sup-sub" name="subject" maxlength="120" placeholder="Ex. : Remboursement non reçu"></div>
  <div class="field"><label for="sup-body">Votre message</label><textarea id="sup-body" name="body" rows="5" maxlength="3000" placeholder="Décrivez votre demande. N'indiquez jamais de mot de passe ni de numéro de carte."></textarea></div>
  <p class="note t-bad sm" id="sup-err" hidden></p><button class="btn pri full">Envoyer ma demande</button></form>`;
};
EXTRA_SHEETS.supthread = (s, h) => {
  const Q = supState(), t = Q.list.find(x => x.id === s.id); if (!t) return h('Demande', '') + '<p class="muted">Demande introuvable.</p>';
  const m = Q.msgs[t.id], st = SUP_ST[t.status] || [t.status, 'muted'];
  if (!m && LIVE) setTimeout(() => supLoadMsgs(t.id), 0);
  return h(esc(t.subject), `${esc(t.ref)} · ${esc((SUP_CAT.find(c => c[0] === t.category) || [0, ''])[1])}`) + `<div class="row"><span class="pill t-${st[1]}">${esc(st[0])}</span></div>
  <div class="stack">${(m || []).map(x => `<div class="card sm ${x.from_staff ? '' : 'mine'}"><b>${x.from_staff ? 'Assistance Side by Side' : 'Vous'}</b> <span class="xs muted">${fdt(Date.parse(x.created_at))}</span><p class="ugc" style="margin:.3em 0 0;white-space:pre-wrap">${esc(x.body)}</p></div>`).join('') || '<p class="muted sm">Chargement…</p>'}</div>
  ${t.status === 'fermee' ? '<p class="xs muted">Cette demande est fermée. Ouvrez une nouvelle demande si besoin.</p>' : `<form class="stack" data-form="sup-reply" data-id="${esc(t.id)}"><div class="field"><label for="sup-rep">Répondre</label><textarea id="sup-rep" name="body" rows="3" maxlength="3000"></textarea></div><p class="note t-bad sm" id="sup-err" hidden></p><div class="pbar"><button class="btn pri">Envoyer</button>${t.status !== 'resolue' ? `<button class="btn ghost" type="button" data-a="sup-resolve" data-id="${esc(t.id)}">Ma demande est résolue</button>` : ''}</div></form>`}`;
};
function supErr(m) { const p = document.getElementById('sup-err'); if (p) { p.textContent = tr(m); p.hidden = false; } else toast(m, true); }

function v30Click(a, el, id, v, b) {
  switch (a) {
    case 'role': if (v === 'admin') return true; return false;   // plus aucun accès administrateur dans l'application
    case 'sup-new': open('supnew'); return true;
    case 'sup-open': open('supthread', { id }); return true;
    case 'sup-resolve': {
      const Q = supState();
      if (!LIVE) { const t = Q.list.find(x => x.id === id); if (t) t.status = 'resolue'; toast('Demande marquée comme résolue.'); render(); return true; }
      SB.rpc('support_resolve', { p_ticket: id }).then(({ error }) => { if (error) return toast(error.message, true); toast('Demande marquée comme résolue.'); supLoad(); });
      return true;
    }
    default: return false;
  }
}
function v30Submit(k, f, d) {
  if (k === 'sup-new') {
    const subject = (d.subject || '').trim(), body = (d.body || '').trim();
    if (subject.length < 3) return (supErr('Indiquez un titre (3 caractères minimum).'), 'stop');
    if (body.length < 10) return (supErr('Décrivez votre demande (10 caractères minimum).'), 'stop');
    const Q = supState();
    if (!LIVE) { const id = 'sd' + (Q.list.length + 2), ref = 'AS-' + (1001 + Q.list.length);
      Q.list.unshift({ id, ref, category: d.category, subject, status: 'ouverte', created_at: new Date().toISOString(), last_message_at: new Date().toISOString() });
      Q.msgs[id] = [{ from_staff: false, body, created_at: new Date().toISOString() }];
      S.sheet = null; toast(`Demande ${ref} envoyée. L'équipe vous répondra ici.`); render(); return true; }
    SB.rpc('support_open', { p_category: d.category, p_subject: subject, p_body: body, p_booking_ref: d.ref || null }).then(({ data, error }) => {
      if (error) return supErr(error.message);
      S.sheet = null; toast(`Demande ${data && data.ref || ''} envoyée. L'équipe vous répondra ici.`); supLoad(); });
    return true;
  }
  if (k === 'sup-reply') {
    const body = (d.body || '').trim(), id = f.dataset.id; if (body.length < 2) return (supErr('Message vide.'), 'stop');
    const Q = supState();
    if (!LIVE) { (Q.msgs[id] = Q.msgs[id] || []).push({ from_staff: false, body, created_at: new Date().toISOString() }); const t = Q.list.find(x => x.id === id); if (t) t.status = 'ouverte'; render(); return true; }
    SB.rpc('support_reply', { p_ticket: id, p_body: body }).then(({ error }) => { if (error) return supErr(error.message); toast('Message envoyé.'); supLoadMsgs(id); supLoad(); });
    return true;
  }
  return false;
}

/* ---------- Photos validées des accompagnateurs (liens temporaires) ---------- */
async function livePhotos() {
  if (!LIVE || !SB) return;
  const list = (S.companions || []).filter(c => c._photo && !PHOTOS[c.id]);
  if (!list.length) return;
  const { data } = await SB.storage.from('photos').createSignedUrls(list.map(c => c._photo), 3600);
  (data || []).forEach((x, i) => { if (x && x.signedUrl) PHOTOS[list[i].id] = x.signedUrl; });
  render();
}

function v30Init() {
  if (window.__v30) return; window.__v30 = 1;
  const add = { fr: ['Mes demandes d\'assistance', 'Nouvelle demande', 'Nouvelle demande d\'assistance', 'Envoyer ma demande', 'Ma demande est résolue', 'Réponse reçue', 'Résolue', 'Fermée', 'Envoyée', 'En cours de traitement'] };
  void add;
  // L'écran « Aide et assistance » affiche les demandes de l'utilisateur
  const _as = accScreen; accScreen = (k, role, sec) => { const h = _as(k, role, sec); return k === 'aide' ? supCard() + h : h; };
  // Mobile : un compte administrateur n'ouvre jamais l'administration
  if (!ADMIN_WEB) { mfa = () => adminRefusedPage(); if (typeof liveMfaHtml === 'function') liveMfaHtml = () => adminRefusedPage(); if (typeof liveMfaInit === 'function') liveMfaInit = () => {}; }
  // Photos validées dans l'annuaire (mode connecté)
  if (LIVE && typeof adaptCompanion === 'function') {
    const _ac = adaptCompanion; adaptCompanion = r => { const c = _ac(r); if (r && r.photo_path) c._photo = r.photo_path; return c; };
    const _ll = liveLoad; liveLoad = async (...x) => { const r = await _ll(...x); livePhotos(); return r; };
  }
}
