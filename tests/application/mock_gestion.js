// Faux serveur pour tester l'espace de gestion sans réseau (données de TEST, jamais réelles).
// Reproduit la logique de sécurité des fonctions admin-auth et admin-action : blocage après 5 échecs,
// code TOTP (123456 valide), session de gestion, inactivité de 15 min, nouvelle saisie du code (5 min).
(function () {
  const H = 3600e3, D = 24 * H, T0 = Date.now(), iso = t => new Date(t).toISOString();
  const db = window.__gdb = {
    clock: 0, calls: [],
    users: [
      { id: 'a1', email: 'admin@zyntell.fr', pw: 'Dirigeant-Test-2026!', totp: true, level: 'super', must: false, first_name: 'Hamid', last_name: 'E' },
      { id: 'a2', email: 'moderation@zyntell.fr', pw: 'Moderation-Test-2026!', totp: true, level: 'admin', must: false, first_name: 'Nadia', last_name: 'R' },
      { id: 'a3', email: 'nouveau@zyntell.fr', pw: 'Provisoire-123!', totp: false, level: 'admin', must: true, first_name: 'Karim', last_name: 'B' },
      { id: 'c1', email: 'sophie.martin@exemple.fr', pw: 'x', client: true }],
    lock: {}, sessions: {}, events: [], audit: [],
    settings: { id: 1, client_fee_pct: 15, companion_fee_pct: 20, privilege_fee_pct: 10, privilege_price_eur: 9.9, vat_pct: 20, referral_eur: 10, min_hours: 1, max_hours: 8, cancel_early_pct: 100, cancel_mid_pct: 50, cancel_late_pct: 0, noshow_pct: 50, dispute_days: 3, insurance_required: true },
    members: [
      { id: 'm1', email: 'sophie.martin@exemple.fr', role: 'client', first_name: 'Sophie', last_name: 'Martin', phone: '+33612345678', city: 'Paris', country: 'FR', identity_verified: true, suspended: false, created_at: iso(T0 - 40 * D), verified: null, tier: null, admin_status: null, bookings: 3 },
      { id: 'm2', email: 'paul.noel@exemple.fr', role: 'client', first_name: 'Paul', last_name: 'Noël', phone: '+33698765432', city: 'Lyon', country: 'FR', identity_verified: false, suspended: false, created_at: iso(T0 - 3 * D), verified: null, tier: null, admin_status: null, bookings: 0 },
      { id: 'm3', email: 'camille.durand@exemple.fr', role: 'companion', first_name: 'Camille', last_name: 'Durand', phone: '+33611223344', city: 'Paris', country: 'FR', identity_verified: true, suspended: false, created_at: iso(T0 - 60 * D), verified: true, tier: 'Prestige', admin_status: 'valide', bookings: 3 },
      { id: 'm4', email: 'julien.morel@exemple.fr', role: 'companion', first_name: 'Julien', last_name: 'Morel', phone: '+33655443322', city: 'Rouen', country: 'FR', identity_verified: true, suspended: false, created_at: iso(T0 - 5 * D), verified: false, tier: 'Standard', admin_status: 'en_cours', bookings: 0 },
      { id: 'm5', email: 'intrus@exemple.fr', role: 'client', first_name: 'Marc', last_name: 'Intrus', phone: '+33600000001', city: 'Paris', country: 'FR', identity_verified: true, suspended: true, created_at: iso(T0 - 20 * D), verified: null, tier: null, admin_status: null, bookings: 1 }],
    bookings: [
      { id: 'b1', ref: 'CMP-1101', status: 'cloturee', starts_at: iso(T0 - 12 * D), hours: 2, category: 'musees', place: 'Musée d\'Orsay', client_id: 'm1', companion_id: 'm3', amount_service: 80, amount_client_fee: 12, amount_vat: 2.4, amount_annex: 0, amount_total: 94.4, amount_commission: 16, amount_payout: 64, gift_used: 0, tip: 5, created_at: iso(T0 - 15 * D) },
      { id: 'b2', ref: 'CMP-1102', status: 'annulee', starts_at: iso(T0 - 4 * D), hours: 3, category: 'restaurants', place: 'Le Train Bleu', client_id: 'm1', companion_id: 'm3', amount_service: 120, amount_client_fee: 18, amount_vat: 3.6, amount_annex: 0, amount_total: 141.6, amount_commission: 24, amount_payout: 96, gift_used: 0, tip: 0, created_at: iso(T0 - 8 * D) },
      { id: 'b3', ref: 'CMP-1103', status: 'confirmee', starts_at: iso(T0 + 3 * D), hours: 2, category: 'shopping', place: 'Galeries Lafayette', client_id: 'm1', companion_id: 'm3', amount_service: 80, amount_client_fee: 12, amount_vat: 2.4, amount_annex: 0, amount_total: 94.4, amount_commission: 16, amount_payout: 64, gift_used: 0, tip: 0, created_at: iso(T0 - 1 * D) }],
    ledger: [],
    tickets: [{ id: 't1', ref: 'AS-1001', user_id: 'm1', category: 'paiement', subject: 'Remboursement non reçu', status: 'ouverte', priority: 'normale', created_at: iso(T0 - 2 * H), last_message_at: iso(T0 - 2 * H), booking_id: 'b2' },
              { id: 't2', ref: 'AS-1002', user_id: 'm3', category: 'securite', subject: 'Client insistant', status: 'en_cours', priority: 'haute', created_at: iso(T0 - 5 * H), last_message_at: iso(T0 - 4 * H), booking_id: null }],
    tmsgs: { t1: [{ id: 1, author_id: 'm1', from_staff: false, body: 'Bonjour, ma réservation CMP-1102 a été annulée mais je n\'ai pas été remboursée.', created_at: iso(T0 - 2 * H) }],
             t2: [{ id: 2, author_id: 'm3', from_staff: false, body: 'Un client me demande mon numéro personnel avec insistance.', created_at: iso(T0 - 5 * H) }] },
    identity: [{ id: 'i1', user_id: 'm2', doc_url: 'data:image/png;base64,iVBORw0KGgo=', selfie_url: 'data:image/png;base64,iVBORw0KGgo=', created_at: iso(T0 - 6 * H), profiles: { first_name: 'Paul', last_name: 'Noël', birth_date: '1985-01-01', role: 'client' } }],
    photos: [{ id: 'p1', companion_id: 'm4', storage_path: 'm4/avatar-1.jpg', is_reference: false, ai_suspect: false, created_at: iso(T0 - 3 * H), url: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 10 10%22%3E%3Crect width=%2210%22 height=%2210%22 fill=%22%23D4AF37%22/%3E%3C/svg%3E', current_url: null, companions: { profiles: { first_name: 'Julien', last_name: 'Morel' } } }],
    reviews: [{ id: 'r1', stars: 2, body: 'Retard de 20 minutes, sinon correct.', status: 'moderation', author: 'Sophie Martin', target: 'Camille Durand', bookings: { ref: 'CMP-1101' } }],
    disputes: [{ id: 'd1', booking_id: 'b2', reason: 'Absence', description: 'L\'accompagnatrice n\'est pas venue.', status: 'ouvert', deadline: iso(T0 + 2 * D), created_at: iso(T0 - D), bookings: { ref: 'CMP-1102', amount_total: 141.6, amount_payout: 96 } }],
    alerts: [{ id: 1, kind: 'code de détresse (client)', user_id: 'm1', latitude: 48.86, longitude: 2.33, created_at: iso(T0 - 30 * 60e3), bookings: { ref: 'CMP-1103' } }],
    notifications: [{ id: 1, body: 'Nouvelle demande d\'assistance AS-1001 : Remboursement non reçu', kind: 'assistance', created_at: iso(T0 - 2 * H), read_at: null }],
    announcements: [], factors: {},
  };
  db.ledger = [{ id: 1, kind: 'Encaissement', amount: 94.4, booking_id: 'b1', created_at: iso(T0 - 14 * D), stripe_object_id: 'pi_test_1', bookings: { ref: 'CMP-1101' } },
    { id: 2, kind: 'Versement', amount: 64, booking_id: 'b1', created_at: iso(T0 - 11 * D), stripe_object_id: 'tr_test_1', bookings: { ref: 'CMP-1101' } },
    { id: 3, kind: 'Pourboire', amount: 5, booking_id: 'b1', created_at: iso(T0 - 11 * D), stripe_object_id: 'pi_test_2', bookings: { ref: 'CMP-1101' } },
    { id: 4, kind: 'Encaissement', amount: 141.6, booking_id: 'b2', created_at: iso(T0 - 7 * D), stripe_object_id: 'pi_test_3', bookings: { ref: 'CMP-1102' } },
    { id: 5, kind: 'Remboursement', amount: -141.6, booking_id: 'b2', created_at: iso(T0 - 5 * D), stripe_object_id: 're_test_1', bookings: { ref: 'CMP-1102' } },
    { id: 6, kind: 'Encaissement', amount: 94.4, booking_id: 'b3', created_at: iso(T0 - D), stripe_object_id: 'pi_test_4', bookings: { ref: 'CMP-1103' } }];
  db.audit = [{ id: 1, created_at: iso(T0 - D), action: 'Identité validée', ref: 'm1', actor: 'Hamid E' }];
  const now = () => Date.now() + db.clock;
  const tok = (u, aal, sid, amr) => btoa(JSON.stringify({ alg: 'none' })) + '.' + btoa(JSON.stringify({ sub: u.id, aal, session_id: sid, amr: amr || [], email: u.email })).replace(/=+$/, '') + '.sig';
  const payload = t => { try { return JSON.parse(atob(t.split('.')[1])); } catch (e) { return {}; } };
  const ev = (event, u, email) => db.events.unshift({ id: db.events.length + 1, event, email: email || (u && u.email), user_id: u && u.id, ip: '203.0.113.7', user_agent: navigator.userAgent, created_at: iso(now()) });
  const fail = (email, u, e) => { ev(e, u, email); const L = db.lock[email] || (db.lock[email] = { fails: 0, until: 0 }); L.fails++; if (L.fails >= 5) { L.fails = 0; L.until = now() + 15 * 60e3; ev('locked', u, email); } };
  let session = null; const listeners = [];
  const setS = s => { session = s; try { sessionStorage.setItem('sbs-gestion-mock', JSON.stringify(s)); } catch (e) {} };
  try { session = JSON.parse(sessionStorage.getItem('sbs-gestion-mock') || 'null'); } catch (e) {}
  const J = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  function admCtx(auth) {
    const p = payload(auth.replace(/^Bearer /, '')), u = db.users.find(x => x.id === p.sub);
    if (!u || u.client) return { e: J(403, { error: 'Accès réservé à l\'équipe Side by Side' }) };
    if (p.aal !== 'aal2') return { e: J(403, { error: 'Double authentification requise' }) };
    const s = db.sessions[p.session_id];
    if (!s || s.ended) return { e: J(401, { error: 'Session expirée : reconnectez-vous.' }) };
    if (now() - s.last > 15 * 60e3) { s.ended = 'inactivite'; ev('timeout', u); return { e: J(401, { error: 'Session fermée après 15 minutes d\'inactivité : reconnectez-vous.' }) }; }
    s.last = now();
    const t = Math.max(0, ...(p.amr || []).filter(x => x.method === 'totp').map(x => x.timestamp));
    return { u, p, stepOk: now() / 1000 - t <= 300 };
  }
  const SENS = ['suspend', 'dispute_decide', 'announce', 'settings_update', 'admin_create', 'admin_revoke', 'admin_reset_totp', 'admin_unlock'];
  const SUPER = ['settings_update', 'admin_create', 'admin_revoke', 'admin_reset_totp', 'admin_unlock'];
  const nm = id => { const m = db.members.find(x => x.id === id); return m ? m.first_name + ' ' + m.last_name : ''; };
  const fin = () => { const done = db.bookings.filter(b => ['terminee', 'versement', 'cloturee'].includes(b.status)), s = (a, f) => a.reduce((x, y) => x + f(y), 0), L = db.ledger;
    return { encaisse: s(L.filter(l => l.kind.startsWith('Encaissement')), l => l.amount), rembourse: -s(L.filter(l => l.kind.startsWith('Remboursement')), l => l.amount), verse: s(L.filter(l => l.kind === 'Versement'), l => l.amount), pourboires: s(L.filter(l => l.kind === 'Pourboire'), l => l.amount),
      prestations_terminees: done.length, volume_prestations: s(done, b => b.amount_service), frais_service_ht: s(done, b => b.amount_client_fee), tva_collectee: s(done, b => b.amount_vat), commissions: s(done, b => b.amount_commission), chiffre_affaires_ht: s(done, b => b.amount_client_fee + b.amount_commission),
      fonds_detenus: s(db.bookings.filter(b => ['confirmee', 'controle', 'verifie', 'en_cours'].includes(b.status)), b => b.amount_total), reservations: db.bookings.length, reservations_annulees: db.bookings.filter(b => b.status === 'annulee').length,
      par_mois: Array.from({ length: 12 }, (_, i) => { const d = new Date(T0); d.setDate(1); d.setMonth(d.getMonth() - 11 + i); const m = d.toISOString().slice(0, 7); return { mois: m, ca_ht: i === 11 ? 28 : 0, commissions: i === 11 ? 16 : 0, encaisse: i === 11 ? 330.4 : 0, rembourse: i === 11 ? 141.6 : 0 }; }),
      par_ville: [{ ville: 'Paris', pays: 'FR', reservations: 3, volume: 330.4 }] }; };
  const counts = () => ({ clients: db.members.filter(m => m.role === 'client').length, accompagnateurs: db.members.filter(m => m.role === 'companion').length, verifies: db.members.filter(m => m.identity_verified).length, suspendus: db.members.filter(m => m.suspended).length,
    identites_a_verifier: db.identity.length, profils_a_valider: db.members.filter(m => m.role === 'companion' && !m.verified).length, dossiers_a_verifier: db.members.filter(m => m.admin_status === 'en_cours').length, photos_a_verifier: db.photos.length,
    litiges_ouverts: db.disputes.filter(d => d.status === 'ouvert').length, missions_a_verifier: 0, alertes_7j: db.alerts.length, assistance_ouverte: db.tickets.filter(t => ['ouverte', 'en_cours'].includes(t.status)).length, avis_a_moderer: db.reviews.filter(r => r.status === 'moderation').length });
  const page = (arr, b) => { const p = +(b.page || 0); return { rows: arr.slice(p * 50, p * 50 + 50), total: arr.length, page: p, size: 50 }; };
  function adminAction(b, c) {
    const a = b.action;
    if (c.u.must && !['me', 'ping'].includes(a)) return J(403, { error: 'Changez d\'abord votre mot de passe provisoire.' });
    if (SUPER.includes(a) && c.u.level !== 'super') return J(403, { error: 'Action réservée au super-administrateur (dirigeant)' });
    if (SENS.includes(a) && !c.stepOk) return J(428, { error: 'Confirmation requise : saisissez un nouveau code de double authentification.' });
    const audit = (action, ref) => db.audit.unshift({ id: db.audit.length + 1, created_at: iso(now()), action, ref: ref || null, actor: c.u.first_name + ' ' + c.u.last_name });
    switch (a) {
      case 'ping': return J(200, { ok: true });
      case 'me': return J(200, { id: c.u.id, email: c.u.email, first_name: c.u.first_name, level: c.u.level, must_change_password: c.u.must });
      case 'overview': return J(200, { identity: db.identity, companions: db.members.filter(m => m.role === 'companion' && (!m.verified || m.admin_status === 'en_cours')).map(m => ({ id: m.id, verified: m.verified, admin_status: m.admin_status, legal_status: 'micro', tax_id: '12345678900011', hourly_rate: 30, categories: ['musees'], bio: 'Passionné d\'histoire.', admin_doc_url: 'data:application/pdf;base64,JVBERi0=', profiles: { first_name: m.first_name, last_name: m.last_name, city: m.city, identity_verified: m.identity_verified } })), disputes: db.disputes.filter(d => d.status === 'ouvert'), alerts: db.alerts, review: [], logs: db.audit, counts: counts() });
      case 'dashboard': return J(200, { counts: counts(), finance: fin(), notifications: db.notifications });
      case 'notifications_read': db.notifications.forEach(n => n.read_at = iso(now())); return J(200, { ok: true });
      case 'users': { let l = db.members.filter(m => (!b.role || (b.role === 'client' ? m.role === 'client' : m.role === b.role)) && (!b.status || (b.status === 'suspendu' ? m.suspended : b.status === 'non_verifie' ? !m.identity_verified : m.role === 'companion' && !m.verified)) && (!b.q || JSON.stringify(m).toLowerCase().includes(String(b.q).toLowerCase()))); const P = page(l, b); return J(200, { users: P.rows.map(x => ({ ...x, total: P.total })), total: P.total, page: P.page, size: 50 }); }
      case 'user_detail': { const m = db.members.find(x => x.id === b.user_id); if (!m) return J(404, { error: 'Membre introuvable' }); audit('Consultation d\'une fiche membre', m.id);
        return J(200, { profile: { ...m, birth_date: '1985-01-01', privilege_since: null }, companion: m.role === 'companion' ? { id: m.id, verified: m.verified, tier: m.tier, admin_status: m.admin_status, hourly_rate: 35, bio: 'Guide-conférencière.', legal_status: 'micro', admin_doc_url: null } : null,
          bookings: db.bookings.filter(x => x.client_id === m.id || x.companion_id === m.id), identity: [], tickets: db.tickets.filter(t => t.user_id === m.id), logs: db.audit.filter(l => l.ref === m.id), photos: [], insurance: m.role === 'companion' ? [{ insurer: 'MAIF', policy_number: 'RC-2026-01', status: 'validee', ends_on: '2027-06-30' }] : null }); }
      case 'suspend': { const m = db.members.find(x => x.id === b.user_id); if (!m) return J(404, { error: 'Membre introuvable' }); if (String(b.reason || '').length < 5) return J(400, { error: 'Indiquez le motif (5 caractères minimum)' }); m.suspended = !!b.suspended; audit((b.suspended ? 'Suspension' : 'Réactivation') + ' du compte : ' + b.reason, m.id); return J(200, { ok: true }); }
      case 'identity_review': { if (!b.approve && String(b.reason || '').length < 5) return J(400, { error: 'Indiquez le motif du refus (5 caractères minimum)' }); const i = db.identity.findIndex(x => x.id === b.check_id); if (i < 0) return J(409, { error: 'Dossier déjà traité' }); const x = db.identity.splice(i, 1)[0]; if (b.approve) db.members.find(m => m.id === x.user_id).identity_verified = true; audit('Identité ' + (b.approve ? 'validée' : 'refusée'), x.user_id); return J(200, { ok: true }); }
      case 'companion_review': { const m = db.members.find(x => x.id === b.companion_id); m.verified = true; m.tier = b.tier; audit('Profil accompagnateur validé (' + b.tier + ')', m.id); return J(200, { ok: true }); }
      case 'admin_review': { const m = db.members.find(x => x.id === b.companion_id); if (m.admin_status !== 'en_cours') return J(409, { error: 'Dossier déjà traité' }); m.admin_status = b.approve ? 'valide' : 'refuse'; audit('Dossier administratif ' + (b.approve ? 'validé' : 'refusé'), m.id); return J(200, { ok: true }); }
      case 'photos': return J(200, { photos: db.photos });
      case 'photo_review': { const i = db.photos.findIndex(x => x.id === b.photo_id); if (i < 0) return J(409, { error: 'Photo déjà traitée' }); const p = db.photos.splice(i, 1)[0]; audit('Photo ' + (b.approve ? 'validée' : 'refusée'), p.companion_id); return J(200, { ok: true }); }
      case 'reviews': return J(200, { reviews: db.reviews.filter(r => r.status === (b.status || 'moderation')) });
      case 'review_moderate': { const r = db.reviews.find(x => x.id === b.review_id); r.status = b.publish ? 'publie' : 'masque'; audit('Avis ' + (b.publish ? 'publié' : 'masqué'), 'CMP-1101'); return J(200, { ok: true }); }
      case 'bookings': { const l = db.bookings.filter(x => (!b.status || x.status === b.status) && (!b.q || x.ref.includes(String(b.q).toUpperCase()))).map(x => ({ ...x, client: nm(x.client_id), companion: nm(x.companion_id) })); const P = page(l, b); return J(200, { bookings: P.rows, total: P.total, page: P.page, size: 50 }); }
      case 'booking_detail': { const x = db.bookings.find(y => y.id === b.booking_id); return J(200, { booking: { ...x, has_payment: true, client: nm(x.client_id), companion: nm(x.companion_id) }, events: [{ status: x.status, note: null, actor_name: 'Système', created_at: x.created_at }], ledger: db.ledger.filter(l => l.booking_id === x.id), disputes: db.disputes.filter(d => d.booking_id === x.id), invoices: [] }); }
      case 'transactions': { const l = db.ledger.filter(x => !b.kind || x.kind.startsWith(b.kind)).slice().reverse(); const P = page(l, b); return J(200, { transactions: P.rows, total: P.total, page: P.page, size: 50 }); }
      case 'finance': return J(200, { finance: fin(), rules: db.settings, from: b.from, to: b.to });
      case 'disputes': return J(200, { disputes: db.disputes.filter(d => d.status === (b.status || 'ouvert')) });
      case 'dispute_decide': { const d = db.disputes.find(x => x.id === b.dispute_id); if (!d || d.status !== 'ouvert') return J(409, { error: 'Dossier déjà tranché' }); d.status = 'decide'; d.decision = b.decision + ' — ' + b.note; audit('Litige tranché (' + b.decision + ') : ' + b.note, d.bookings.ref); return J(200, { ok: true }); }
      case 'support_list': { const l = db.tickets.filter(t => b.status ? t.status === b.status : ['ouverte', 'en_cours'].includes(t.status)).map(t => ({ ...t, user: nm(t.user_id), bookings: t.booking_id ? { ref: db.bookings.find(x => x.id === t.booking_id).ref } : null })); return J(200, { tickets: l, total: l.length, page: 0, size: 50 }); }
      case 'support_detail': { const t = db.tickets.find(x => x.id === b.ticket_id), m = db.members.find(x => x.id === t.user_id); return J(200, { ticket: { ...t, user: nm(t.user_id), email: m.email, role: m.role, phone: m.phone, bookings: t.booking_id ? { ref: db.bookings.find(x => x.id === t.booking_id).ref } : null }, messages: (db.tmsgs[t.id] || []).map(x => ({ ...x, author: x.from_staff ? 'Assistance Side by Side' : nm(x.author_id) })) }); }
      case 'support_reply': { const t = db.tickets.find(x => x.id === b.ticket_id); (db.tmsgs[t.id] = db.tmsgs[t.id] || []).push({ id: Date.now(), author_id: c.u.id, from_staff: true, body: b.body, created_at: iso(now()) }); t.status = b.status || 'repondue'; audit('Réponse à la demande d\'assistance (' + t.status + ')', t.ref); return J(200, { ok: true }); }
      case 'support_status': { const t = db.tickets.find(x => x.id === b.ticket_id); t.status = b.status; audit('Demande d\'assistance : statut « ' + b.status + ' »', t.ref); return J(200, { ok: true }); }
      case 'announcements': return J(200, { announcements: db.announcements });
      case 'announce': { if (String(b.body || '').length < 5) return J(400, { error: 'Rédigez le message' }); const n = db.members.filter(m => !m.suspended && (b.audience === 'all' || m.role === b.audience)).length; db.announcements.unshift({ id: db.announcements.length + 1, audience: b.audience, body: b.body, recipients: n, created_at: iso(now()) }); audit('Annonce envoyée (' + b.audience + ', ' + n + ' destinataire(s))'); return J(200, { ok: true, recipients: n }); }
      case 'audit': { const l = db.audit.filter(x => !b.q || x.action.toLowerCase().includes(String(b.q).toLowerCase())); const P = page(l, b); return J(200, { logs: P.rows, total: P.total, page: P.page, size: 50 }); }
      case 'auth_events': { const P = page(db.events, b); return J(200, { events: P.rows, total: P.total, page: P.page, size: 50 }); }
      case 'settings_get': return J(200, { settings: db.settings, editable: c.u.level === 'super' });
      case 'settings_update': { const before = { ...db.settings }; for (const [k, v] of Object.entries(b.settings || {})) { if (k === 'client_fee_pct' && (v < 0 || v > 30)) return J(400, { error: 'Valeur hors limites pour client_fee_pct (0 à 30)' }); db.settings[k] = v; } const ch = Object.keys(b.settings).filter(k => String(before[k]) !== String(db.settings[k])).map(k => k + ' : ' + before[k] + ' → ' + db.settings[k]); audit('Paramètres modifiés : ' + (ch.join(' ; ') || 'aucun changement'), 'settings'); return J(200, { ok: true, changes: ch }); }
      case 'admins': return J(200, { admins: db.users.filter(x => !x.client).map(x => ({ user_id: x.id, email: x.email, first_name: x.first_name, last_name: x.last_name, level: x.level, suspended: false, revoked_at: x.revoked || null, created_at: iso(T0 - 9 * D), totp: x.totp, last_login: null, locked_until: db.lock[x.email] && db.lock[x.email].until > now() ? iso(db.lock[x.email].until) : null })), can_manage: c.u.level === 'super' });
      case 'admin_create': { if (db.users.some(x => x.email === b.email)) return J(409, { error: 'Cette adresse est déjà utilisée par un compte' }); const id = 'a' + (db.users.length + 1); db.users.push({ id, email: b.email, pw: 'Tmp-' + id + '-Xy9!zz', totp: false, level: 'admin', must: true, first_name: b.first_name, last_name: b.last_name }); audit('Création d\'un administrateur : ' + b.email, id); return J(200, { ok: true, user_id: id, temporary_password: 'Tmp-' + id + '-Xy9!zz' }); }
      case 'admin_revoke': { const x = db.users.find(y => y.id === b.user_id); x.revoked = iso(now()); audit('Accès administrateur retiré', x.id); return J(200, { ok: true }); }
      case 'admin_reset_totp': { const x = db.users.find(y => y.id === b.user_id); x.totp = false; x.must = true; audit('Double authentification réinitialisée', x.id); return J(200, { ok: true }); }
      case 'admin_unlock': { delete db.lock[b.email]; ev('unlocked', null, b.email); audit('Déblocage de l\'accès : ' + b.email); return J(200, { ok: true }); }
      default: return J(400, { error: 'Action inconnue' });
    }
  }
  function adminAuth(b, auth) {
    if (b.action === 'login') {
      const email = String(b.email || '').trim().toLowerCase(), L = db.lock[email];
      if (L && L.until > now()) { ev('refused', null, email); return J(423, { error: `Accès bloqué après plusieurs échecs. Réessayez dans ${Math.ceil((L.until - now()) / 60e3)} min.` }); }
      const u = db.users.find(x => x.email === email);
      if (!u || u.pw !== b.password || u.client || u.revoked) { fail(email, u, 'login_fail'); return J(401, { error: 'Identifiants incorrects.' }); }
      ev('login_ok', u);
      return J(200, { ok: true, session: { access_token: tok(u, 'aal1', 'pre-' + u.id, []), refresh_token: 'r-' + u.id }, totp: u.totp ? { factor_id: 'f-' + u.id } : null, level: u.level });
    }
    if (b.action === 'mfa_verify' || b.action === 'stepup') {
      const p = payload(b.action === 'stepup' ? auth.replace(/^Bearer /, '') : String(b.access_token || '')), u = db.users.find(x => x.id === p.sub);
      if (!u) return J(401, { error: 'Session expirée : reconnectez-vous.' });
      if (b.action === 'stepup') { const c = admCtx(auth); if (c.e) return c.e; }
      if (String(b.code) !== '123456') { fail(u.email, u, b.action === 'stepup' ? 'stepup_fail' : 'mfa_fail'); return J(401, { error: 'Code incorrect.' }); }
      const sid = b.action === 'stepup' ? p.session_id : 's-' + Math.random().toString(36).slice(2);
      if (b.action === 'mfa_verify') { db.sessions[sid] = { user: u.id, last: now() }; u.totp = true; delete db.lock[u.email]; ev('mfa_ok', u); } else { db.sessions[sid].last = now(); ev('stepup_ok', u); }
      return J(200, { ok: true, session: { access_token: tok(u, 'aal2', sid, [{ method: 'totp', timestamp: Math.floor(now() / 1000) }, { method: 'password', timestamp: Math.floor(now() / 1000) }]), refresh_token: 'r2-' + u.id }, level: u.level, must_change_password: u.must });
    }
    if (b.action === 'change_password') { const c = admCtx(auth); if (c.e) return c.e; const pw = String(b.password || ''); if (pw.length < 14 || !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) return J(400, { error: '14 caractères minimum, avec minuscules, majuscules, chiffres et symboles.' }); c.u.pw = pw; c.u.must = false; ev('password_changed', c.u); Object.values(db.sessions).forEach(x => { if (x.user === c.u.id && !x.ended) x.ended = 'mot_de_passe'; }); return J(200, { ok: true, relogin: true }); }
    if (b.action === 'logout') { const p = payload(auth.replace(/^Bearer /, '')); if (db.sessions[p.session_id]) db.sessions[p.session_id].ended = b.reason || 'deconnexion'; const u = db.users.find(x => x.id === p.sub); if (u) ev(b.reason === 'inactivite' ? 'timeout' : 'logout', u); return J(200, { ok: true }); }
    return J(400, { error: 'Action inconnue' });
  }
  const _f = window.fetch;
  window.fetch = (url, o = {}) => {
    const u = String(url), m = u.match(/\/functions\/v1\/([a-z-]+)/);
    if (!m) return _f(url, o);
    const body = JSON.parse(o.body || '{}'), auth = (o.headers && (o.headers.Authorization || o.headers.authorization)) || '';
    db.calls.push({ fn: m[1], body: { ...body, password: body.password ? '***' : undefined } });
    if (m[1] === 'admin-auth') return adminAuth(body, auth);
    const c = admCtx(auth); if (c.e) return c.e;
    if (m[1] === 'admin-action') return adminAction(body, c);
    if (m[1] === 'refund-booking') { if (!c.stepOk) return J(428, { error: 'Confirmation requise : saisissez un nouveau code de double authentification.' }); const x = db.bookings.find(y => y.id === body.booking_id); x.status = 'annulee'; db.ledger.push({ id: db.ledger.length + 1, kind: 'Remboursement', amount: -x.amount_total, booking_id: x.id, created_at: iso(now()), bookings: { ref: x.ref } }); return J(200, { ok: true, refund: x.amount_total, pct: 100 }); }
    if (m[1] === 'release-payout') return J(200, { ok: true });
    if (m[1] === 'insurance') {
      db.ins = db.ins || [{ id: 'ins1', companion_id: 'u-comp', name: 'Camille Durand', insurer: 'MAIF', policy_number: 'RC-2026-01', starts_on: '2026-01-01', ends_on: '2027-06-30', status: 'validee', state: 'valide', created_at: iso(now()) },
        { id: 'ins2', companion_id: 'u-comp2', name: 'Lucas Bernard', insurer: 'AXA', policy_number: 'AX-778', starts_on: '2026-11-01', ends_on: '2027-10-31', status: 'en_attente', state: 'en_attente', created_at: iso(now()) }];
      if (body.action === 'list') { const st = x => x.state; return J(200, { rows: db.ins, uninsured: db.ins.filter(x => st(x) !== 'valide').map(x => ({ companion_id: x.companion_id, name: x.name })), affected: [], history: [], required: db.settings.insurance_required,
        counts: { assures: db.ins.filter(x => st(x) === 'valide').length, attente: db.ins.filter(x => st(x) === 'en_attente').length, expirees: 0, bientot: 0, sans: db.ins.filter(x => st(x) !== 'valide').length } }); }
      if (body.action === 'review') { if (!c.stepOk) return J(428, { error: 'Confirmation requise : saisissez un nouveau code de double authentification.' }); const x = db.ins.find(y => y.id === body.id); x.status = body.approve ? 'validee' : 'refusee'; x.state = body.approve ? 'valide' : 'refusee'; db.audit.unshift({ id: db.audit.length + 1, actor: 'Hamid', action: 'Attestation d\'assurance ' + (body.approve ? 'validée' : 'refusée'), ref: x.companion_id, created_at: iso(now()) }); return J(200, { ok: true }); }
      if (body.action === 'required') { if (c.u.level !== 'super') return J(403, { error: 'Réservé au super-administrateur.' }); if (!c.stepOk) return J(428, { error: 'Confirmation requise : saisissez un nouveau code de double authentification.' }); db.settings.insurance_required = !!body.on; return J(200, { ok: true }); }
      return J(200, { ok: true });
    }
    if (m[1] === 'tax-admin') {
      if (body.action === 'overview') return J(200, { year: body.year, companions_total: 2, concerned: 1, total_consideration: 112, total_fees: 28, rows: [], declarations: [], issues: [] });
      return J(200, { ok: true, declarations: [], list: [], items: [], issues: [] });
    }
    return J(400, { error: 'Fonction inconnue' });
  };
  const user = () => { if (!session) return null; const p = payload(session.access_token); return { id: p.sub, email: p.email }; };
  const auth = {
    setSession: async s => { setS({ ...s }); return { data: { session }, error: null }; },
    getSession: async () => ({ data: { session: session ? { ...session, user: user() } : null }, error: null }),
    getUser: async () => ({ data: { user: user() }, error: null }),
    signOut: async () => { setS(null); return { error: null }; },
    onAuthStateChange: f => { listeners.push(f); return { data: { subscription: { unsubscribe() {} } } }; },
    signInWithPassword: async () => ({ data: null, error: { message: 'Utiliser l\'espace de gestion' } }),
    mfa: {
      listFactors: async () => { const u = db.users.find(x => x.id === (user() || {}).id); const f = u && u.totp ? [{ id: 'f-' + u.id, factor_type: 'totp', status: 'verified' }] : []; return { data: { totp: f, all: f }, error: null }; },
      enroll: async () => ({ data: { id: 'f-new', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h29v29H0z"/><path stroke="#000" d="M4 4.5h7m1 0h1M4 5.5h1m5 0h1"/></svg>', secret: 'JBSWY3DPEHPK3PXP' } }, error: null }),
      unenroll: async () => ({ data: {}, error: null }),
    },
  };
  const from = t => { const q = { select: () => q, eq: () => q, single: async () => { const u = db.users.find(x => x.id === (user() || {}).id); return t === 'profiles' && u ? { data: { id: u.id, role: 'admin', first_name: u.first_name, last_name: u.last_name }, error: null } : { data: null, error: { message: 'x' } }; }, order: () => q, limit: () => q, then: r => r({ data: [], error: null }) }; return q; };
  window.supabase = { createClient: () => ({ auth, from, rpc: async () => ({ data: [], error: null }), channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {}, functions: { invoke: async () => ({ data: {}, error: null }) }, storage: { from: () => ({ createSignedUrls: async () => ({ data: [] }), createSignedUrl: async () => ({ data: {} }), upload: async () => ({}) }) } }) };
  window.SBS_CONFIG = { url: 'https://projet-test.supabase.co', key: 'sb_publishable_test', stripePk: '' };
  window.SBS_ADMIN_WEB = true;
})();
