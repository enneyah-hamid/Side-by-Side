// Tests de l'espace de gestion (/gestion) avec un faux serveur reproduisant la sécurité (mock_gestion.js)
// Lancer : node tests/application/gestion.js  (page de test : /tmp/gestiontest/index.html)
const { chromium } = require('playwright');
const URL = process.env.GESTION || 'file:///tmp/gestiontest/index.html';
(async () => {
  const b = await chromium.launch(); const R = []; const errs = [];
  const ck = (id, l, ok, d = '') => { R.push(ok); console.log((ok ? '✅ ' : '❌ ') + id + ' ' + l + (d ? ' — ' + d : '')); };
  const page = async (w = 1280, h = 900) => { const ctx = await b.newContext({ viewport: { width: w, height: h } }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); await p.goto(URL); await p.waitForTimeout(1800); return p; };
  const txt = p => p.evaluate(() => document.body.innerText);
  const login = async (p, email, pw, code = '123456') => {
    await p.fill('[name=email]', email); await p.fill('[name=password]', pw); await p.click('form[data-form="adm-login"] button'); await p.waitForTimeout(600);
    if (code && await p.$('form[data-form="adm-mfa"]')) { await p.fill('[name=code]', code); await p.click('form[data-form="adm-mfa"] button.pri'); await p.waitForTimeout(1000); }
  };
  const tab = async (p, t) => { await p.evaluate(t => document.querySelector(`[data-a=tab][data-v=${t}]`).click(), t); await p.waitForTimeout(600); };
  const stepup = async (p, code = '123456') => { await p.waitForSelector('form[data-form="adm-stepup"]', { timeout: 3000 }); await p.fill('#su-code', code); await p.click('form[data-form="adm-stepup"] button'); await p.waitForTimeout(800); };
  const db = (p, f) => p.evaluate(f);

  // 1. Accès
  let p = await page(); let t = await txt(p);
  ck('G01', 'L\'adresse ouvre directement la connexion de l\'espace de gestion (aucune inscription, aucun espace client)', /Espace de gestion/.test(t) && !/Créer un compte|Je suis Client|Je suis Accompagnateur|S'inscrire/.test(t));
  ck('G02', 'Page non indexable par les moteurs de recherche', await p.evaluate(() => document.querySelector('meta[name=robots]')?.content === 'noindex, nofollow'));
  ck('G03', 'Aucun script intégré dans la page (politique de sécurité stricte possible)', await p.evaluate(() => [...document.scripts].every(s => s.src)));
  await login(p, 'admin@zyntell.fr', 'mauvais', null); t = await txt(p);
  ck('G04', 'Mauvais mot de passe : message générique', /Identifiants incorrects/.test(t));
  await login(p, 'sophie.martin@exemple.fr', 'x', null); t = await txt(p);
  ck('G05', 'Compte client : refusé avec le même message', /Identifiants incorrects/.test(t) && !(await p.$('form[data-form="adm-mfa"]')));
  for (let i = 0; i < 5; i++) await login(p, 'moderation@zyntell.fr', 'faux' + i, null);
  await login(p, 'moderation@zyntell.fr', 'Moderation-Test-2026!', null); t = await txt(p);
  ck('G06', '5 échecs : accès bloqué même avec le bon mot de passe', /bloqué/.test(t), t.match(/Accès bloqué[^\n]*/)?.[0]);
  await login(p, 'admin@zyntell.fr', 'Dirigeant-Test-2026!', '000000'); t = await txt(p);
  ck('G07', 'Mot de passe correct mais code TOTP faux : refusé', /Code incorrect/.test(t) && !(await p.$('nav.tabs')));
  await p.fill('[name=code]', '123456'); await p.click('form[data-form="adm-mfa"] button.pri'); await p.waitForTimeout(1200); t = await txt(p);
  ck('G08', 'Mot de passe + TOTP : tableau de bord avec les données du serveur', /Tableau de bord/.test(t) && /330,40/.test(t) && /28,00/.test(t) && /CLIENTS\s*\n?\s*3/i.test(t));
  ck('G09', 'Neuf rubriques : tableau, comptes, vérifications, réservations, finances, litiges, assistance, journal, réglages', (await p.$$eval('nav.tabs button', x => x.map(y => y.dataset.v))).join() === 'dashboard,users,verif,bookings,finances,disputes,support,audit,settings');
  ck('G10', 'Aucune donnée de démonstration affichée (notifications, alertes)', !/Camille \(accompagnatrice\)|Sophie \(cliente\)/.test(t));

  // 2. Modules
  await tab(p, 'users'); await p.fill('form[data-form="adm-users"] [name=q]', 'paul'); await p.click('form[data-form="adm-users"] button'); await p.waitForTimeout(500); t = await txt(p);
  ck('G11', 'Comptes : recherche d\'un membre', /Paul Noël/.test(t) && !/Sophie Martin/.test(t));
  await p.fill('form[data-form="adm-users"] [name=q]', ''); await p.selectOption('form[data-form="adm-users"] [name=status]', 'suspendu'); await p.click('form[data-form="adm-users"] button'); await p.waitForTimeout(500);
  await p.click('[data-a=adm-user]'); await p.waitForTimeout(600); t = await p.evaluate(() => document.querySelector('.sheet').innerText);
  ck('G12', 'Fiche membre : e-mail, statut, réservations, historique', /intrus@exemple.fr/.test(t) && /Compte suspendu/.test(t) && /Réactiver/.test(t));
  await p.fill('form[data-form="adm-suspend"] [name=reason]', 'Contestation acceptée'); await p.click('form[data-form="adm-suspend"] button'); await p.waitForTimeout(600);
  ck('G13', 'Code saisi il y a moins de 5 minutes : pas de nouvelle demande de code', !(await p.$('form[data-form="adm-stepup"]')));
  ck('G14', 'Compte réactivé et décision journalisée', await db(p, () => !__gdb.members.find(m => m.id === 'm5').suspended && __gdb.audit.some(a => a.action.startsWith('Réactivation du compte : Contestation'))));
  await db(p, () => { __gdb.clock += 6 * 60e3; }); await p.evaluate(() => { S.sheet = null; render(); });
  await p.click('[data-a=adm-refresh]').catch(() => {}); await p.waitForTimeout(300);
  await p.evaluate(() => { open('admuser', { id: 'm1' }); render(); }); await p.waitForTimeout(700);
  await p.fill('form[data-form="adm-suspend"] [name=reason]', 'Comportement inapproprié'); await p.click('form[data-form="adm-suspend"] button'); await p.waitForTimeout(500);
  const askCode = !!(await p.$('form[data-form="adm-stepup"]'));
  await stepup(p, '000000'); const stillOpen = !!(await p.$('form[data-form="adm-stepup"]'));
  await stepup(p); await p.waitForTimeout(500);
  ck('G15', 'Opération sensible après 5 min : nouveau code exigé (faux code refusé), puis suspension effectuée', askCode && stillOpen && await db(p, () => __gdb.members.find(m => m.id === 'm1').suspended));
  await db(p, () => { __gdb.members.find(m => m.id === 'm1').suspended = false; });
  await tab(p, 'verif'); await p.click('form[data-form="adm-id"] button[value="0"]'); await p.waitForTimeout(400); t = await txt(p);
  ck('G16', 'Refus d\'une pièce d\'identité sans motif : impossible', /motif du refus/.test(t) && await db(p, () => __gdb.identity.length === 1));
  await p.click('form[data-form="adm-id"] button[value="1"]'); await p.waitForTimeout(600);
  ck('G17', 'Validation de l\'identité', await db(p, () => __gdb.identity.length === 0 && __gdb.members.find(m => m.id === 'm2').identity_verified));
  ck('G18', 'Dossier administratif (A4) et photo à vérifier (A5) affichés', !!(await p.$('form[data-form="adm-dossier"]')) && !!(await p.$('form[data-form="adm-photo"]')));
  await p.click('form[data-form="adm-dossier"] button[value="1"]'); await p.waitForTimeout(600);
  await p.fill('form[data-form="adm-photo"] [name=reason]', 'Photo floue et recadrée'); await p.click('form[data-form="adm-photo"] button[value="0"]'); await p.waitForTimeout(600);
  ck('G19', 'Dossier administratif validé ; photo refusée avec motif', await db(p, () => __gdb.members.find(m => m.id === 'm4').admin_status === 'valide' && __gdb.photos.length === 0));
  await p.click('[data-a=adm-rev][data-v="0"]'); await p.waitForTimeout(500);
  ck('G20', 'Avis masqué par la modération', await db(p, () => __gdb.reviews[0].status === 'masque'));
  await tab(p, 'bookings'); t = await txt(p);
  ck('G21', 'Réservations : liste réelle (références, statuts, montants)', /CMP-1101/.test(t) && /CMP-1103/.test(t) && /94,40/.test(t));
  await p.evaluate(() => document.querySelector('[data-a=adm-resa]').click()); await p.waitForTimeout(600);
  await p.evaluate(() => { open('admresa', { id: 'b3' }); render(); }); await p.waitForTimeout(600); t = await p.evaluate(() => document.querySelector('.sheet').innerText);
  ck('G22', 'Détail : frais, TVA, commission ZYNTELL, versement, mouvements', /Commission ZYNTELL/.test(t) && /TVA sur les frais/.test(t) && /Versement à l'accompagnateur/.test(t));
  await db(p, () => { __gdb.clock += 6 * 60e3; });
  await p.click('[data-a=adm-cancel-resa]'); await p.waitForTimeout(300); await p.click('[data-a=adm-cancel-resa]'); await p.waitForTimeout(500);
  await stepup(p); await p.waitForTimeout(500);
  ck('G23', 'Annulation par l\'équipe : double confirmation, nouveau code, remboursement enregistré', await db(p, () => __gdb.bookings.find(x => x.id === 'b3').status === 'annulee' && __gdb.ledger.some(l => l.booking_id === 'b3' && l.amount < 0)));
  await p.evaluate(() => { S.sheet = null; render(); });
  await tab(p, 'finances'); t = await txt(p);
  ck('G24', 'Finances : encaissé, chiffre d\'affaires HT, commissions, remboursements, TVA, règles 15 % / 20 %', /Montants encaissés/.test(t) && /Commissions ZYNTELL/.test(t) && /TVA collectée/.test(t) && /frais de service client 15 %/.test(t) && /commission accompagnateur 20 %/.test(t));
  ck('G25', 'Transactions : mouvements du grand livre', /Encaissement/.test(t) && /Versement/.test(t) && /re_test_1/.test(t));
  const [dlx] = await Promise.all([p.waitForEvent('download', { timeout: 3000 }).catch(() => null), p.click('[data-a=adm-csv-tx]')]);
  ck('G26', 'Export comptable des transactions (CSV)', !!dlx && /transactions-.*\.csv/.test(dlx.suggestedFilename()));
  await tab(p, 'disputes'); await p.fill('form[data-form="adm-decide"] [name=note]', 'Absence confirmée par les messages'); await p.selectOption('form[data-form="adm-decide"] [name=decision]', 'refund'); await p.click('form[data-form="adm-decide"] button'); await p.waitForTimeout(800);
  if (await p.$('form[data-form="adm-stepup"]')) await stepup(p);
  ck('G27', 'Litige tranché (remboursement motivé)', await db(p, () => __gdb.disputes[0].status === 'decide'));
  await tab(p, 'support'); t = await txt(p);
  ck('G28', 'Assistance : demandes à traiter, priorité sécurité signalée', /AS-1001/.test(t) && /AS-1002/.test(t) && /Prioritaire/.test(t));
  await p.evaluate(() => document.querySelector('[data-a=adm-ticket]').click()); await p.waitForTimeout(700);
  await p.fill('form[data-form="adm-sup-reply"] [name=body]', 'Le remboursement a été relancé, il arrive sous 5 jours.'); await p.click('form[data-form="adm-sup-reply"] button'); await p.waitForTimeout(700);
  ck('G29', 'Réponse envoyée au membre, statut « Répondue »', await db(p, () => { const t = __gdb.tickets.find(x => x.status === 'repondue'); return !!t && __gdb.tmsgs[t.id].some(m => m.from_staff); }));
  await p.evaluate(() => { S.sheet = null; render(); });
  await tab(p, 'audit'); t = await txt(p);
  ck('G30', 'Journal : décisions et connexions (échecs, blocage, connexion réussie)', /Réactivation du compte/.test(t) && /Échec de connexion/.test(t) && /Accès bloqué 15 min/.test(t) && /Connexion réussie/.test(t));
  await tab(p, 'settings'); t = await txt(p);
  ck('G31', 'Réglages : paramètres modifiables par le dirigeant, équipe, annonces, sécurité', /Paramètres financiers/.test(t) && /Équipe d'administration/.test(t) && /Ajouter un administrateur/.test(t) && /Annonces aux membres/.test(t) && !(await p.$eval('#st-client_fee_pct', e => e.disabled)));
  await db(p, () => { __gdb.clock += 6 * 60e3; });
  await p.fill('#st-cancel_mid_pct', '55'); await p.click('form[data-form="adm-settings"] button'); await p.waitForTimeout(500); await stepup(p); await p.waitForTimeout(400);
  ck('G32', 'Modification d\'un paramètre (nouveau code, journalisée avant/après)', await db(p, () => __gdb.settings.cancel_mid_pct === 55 && /cancel_mid_pct : 50 → 55/.test(__gdb.audit[0].action)));
  await p.fill('#ac-f', 'Inès'); await p.fill('#ac-l', 'Admin'); await p.fill('#ac-e', 'ines.admin@zyntell.fr'); await p.click('form[data-form="adm-create"] button'); await p.waitForTimeout(700);
  t = await p.evaluate(() => document.querySelector('.sheet')?.innerText || '');
  ck('G33', 'Création d\'un administrateur : mot de passe provisoire affiché une seule fois', /une seule fois/.test(t) && /Tmp-/.test(t));
  await p.click('.sheet [data-a=close]'); await p.waitForTimeout(300);
  await p.fill('#an-b', 'L\'assistance est désormais disponible dans l\'application.'); await p.click('form[data-form="adm-announce"] button'); await p.waitForTimeout(700);
  ck('G34', 'Annonce envoyée aux membres et historisée', await db(p, () => __gdb.announcements.length === 1 && __gdb.announcements[0].recipients > 0));

  // 3. Inactivité et déconnexion
  await p.evaluate(() => { admLastAct = Date.now() - 16 * 60e3; admIdleWatch(); }); await p.waitForTimeout(800); t = await txt(p);
  ck('G35', '15 minutes sans activité : déconnexion automatique, journalisée', /déconnecté après 15 minutes/.test(t) && await db(p, () => __gdb.events.some(e => e.event === 'timeout')) && !(await p.$('nav.tabs')));
  await login(p, 'admin@zyntell.fr', 'Dirigeant-Test-2026!');
  await db(p, () => { __gdb.clock += 16 * 60e3; }); await tab(p, 'users'); await p.waitForTimeout(800); t = await txt(p);
  ck('G36', 'Session expirée côté serveur (inactivité) : retour à la connexion', /Espace de gestion/.test(t) && !(await p.$('nav.tabs')));
  await login(p, 'admin@zyntell.fr', 'Dirigeant-Test-2026!'); await tab(p, 'settings'); await p.click('[data-a=adm-logout]'); await p.waitForTimeout(700); t = await txt(p);
  ck('G37', 'Déconnexion volontaire : session fermée sur le serveur', /Vous êtes déconnecté/.test(t) && await db(p, () => Object.values(__gdb.sessions).some(s => s.ended === 'deconnexion')));

  // 4. Administrateur simple et premier accès
  await db(p, () => { delete __gdb.lock['moderation@zyntell.fr']; });
  await login(p, 'moderation@zyntell.fr', 'Moderation-Test-2026!'); await tab(p, 'settings'); t = await txt(p);
  ck('G38', 'Administrateur simple : paramètres en lecture seule, pas de gestion de l\'équipe', /Lecture seule/.test(t) && !/Ajouter un administrateur/.test(t) && await p.$eval('#st-client_fee_pct', e => e.disabled));
  await p.click('[data-a=adm-logout]'); await p.waitForTimeout(500);
  await login(p, 'nouveau@zyntell.fr', 'Provisoire-123!', null); t = await txt(p);
  ck('G39', 'Premier accès : QR code d\'activation de Google Authenticator', /Activer la double authentification/.test(t) && !!(await p.$('img[alt="QR code de double authentification"]')));
  await p.waitForTimeout(300);
  const qr = await p.evaluate(() => { const i = document.querySelector('img[alt="QR code de double authentification"]'); return { ok: i.complete && i.naturalWidth > 0, txt: document.body.innerText }; });
  ck('G39b', 'QR code au format réel de Supabase : image lisible, aucun code HTML affiché', qr.ok && !/<svg|<path|xmlns|shape-rendering/.test(qr.txt));
  ck('G39c', 'Clé de saisie manuelle masquée par défaut, affichée seulement sur demande avec mise en garde', !qr.txt.includes('JBSWY3DPEHPK3PXP') && await (async () => { await p.evaluate(() => document.querySelector('[data-a="adm-showkey"]').click()); await p.waitForTimeout(200); const t2 = await p.evaluate(() => document.body.innerText); return t2.includes('JBSWY3DPEHPK3PXP') && /Ne la photographiez pas/.test(t2); })());
  await p.fill('[name=code]', '123456'); await p.click('form[data-form="adm-mfa"] button.pri'); await p.waitForTimeout(800); t = await txt(p);
  ck('G40', 'Mot de passe provisoire : changement obligatoire avant tout accès', /Choisissez votre mot de passe/.test(t) && !(await p.$('nav.tabs')));
  await p.fill('#ap-1', 'court'); await p.fill('#ap-2', 'court'); await p.click('form[data-form="adm-pw"] button'); await p.waitForTimeout(500); const weak = /14 caractères/.test(await txt(p));
  await p.fill('#ap-1', 'Karim-Gestion-2026!#'); await p.fill('#ap-2', 'Karim-Gestion-2026!#'); await p.click('form[data-form="adm-pw"] button'); await p.waitForTimeout(1000);
  const relog = /Reconnectez-vous avec votre nouveau mot de passe/.test(await txt(p)) && !(await p.$('nav.tabs'));
  await login(p, 'nouveau@zyntell.fr', 'Karim-Gestion-2026!#');
  ck('G41', 'Mot de passe faible refusé ; mot de passe fort accepté, sessions fermées, reconnexion (nouveau mot de passe + TOTP) puis accès', weak && relog && !!(await p.$('nav.tabs')));

  // 4 bis. Assurance responsabilité civile obligatoire et fiscalité DAC7 (depuis le tableau de bord)
  await tab(p, 'settings'); await p.click('[data-a=adm-logout]'); await p.waitForTimeout(500);
  await login(p, 'admin@zyntell.fr', 'Dirigeant-Test-2026!'); await tab(p, 'dashboard'); await db(p, () => { __gdb.clock += 6 * 60e3; });
  await p.evaluate(() => document.querySelector('[data-a="ins-admin"]').click()); await p.waitForTimeout(1000); t = await p.evaluate(() => (document.querySelector('.sheet') || document.body).innerText);
  ck('G44', 'Assurances : attestations réelles du serveur (assurés, en attente) et règle « obligatoire » rappelée', /Lucas Bernard/.test(t) && /AXA/.test(t) && /bloquées automatiquement/.test(t), t.slice(0, 120).replace(/\n/g, ' '));
  await p.evaluate(() => document.querySelector('[data-a="ins-ok"][data-id="ins2"]').click()); await p.waitForTimeout(600);
  const insStep = !!(await p.$('form[data-form="adm-stepup"]')); if (insStep) await stepup(p);
  await p.waitForTimeout(800);
  ck('G45', 'Validation d\'une attestation : nouveau code TOTP exigé, puis attestation validée et journalisée', insStep && await db(p, () => __gdb.ins.find(x => x.id === 'ins2').status === 'validee' && __gdb.audit.some(a => /Attestation d'assurance validée/.test(a.action))));
  await p.evaluate(() => { S.sheet = null; render(); document.querySelector('[data-a="dac7"]').click(); }); await p.waitForTimeout(1200); t = await p.evaluate(() => (document.querySelector('.sheet') || document.body).innerText);
  ck('G46', 'Fiscalité DAC7 accessible depuis la gestion, chiffres du serveur', /DAC7/.test(t) && /112/.test(t), t.slice(0, 160).replace(/\n/g, ' '));
  await p.evaluate(() => { S.sheet = null; render(); });

  // 5. Affichage
  const over = [];
  for (const [w, h] of [[390, 844], [768, 1024], [1280, 800], [1920, 1080]]) { const q = await page(w, h); await login(q, 'admin@zyntell.fr', 'Dirigeant-Test-2026!');
    for (const tb of ['dashboard', 'users', 'verif', 'bookings', 'finances', 'support', 'audit', 'settings']) { await tab(q, tb); const sw = await q.evaluate(() => document.documentElement.scrollWidth); if (sw > w + 1) over.push(`${tb}@${w}:${sw}`); } await q.context().close(); }
  ck('G42', 'Aucun débordement horizontal de la page (390 à 1920 px)', over.length === 0, over.join(', '));
  ck('G43', 'Aucune erreur JavaScript', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close(); const n = R.filter(Boolean).length; console.log(`\n${n}/${R.length} tests réussis`); process.exit(n === R.length ? 0 : 1);
})();
