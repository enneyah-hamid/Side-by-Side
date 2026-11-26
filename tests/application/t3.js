const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const errs=[];const R=[];const ck=(id,l,ok,d='')=>{R.push(ok);console.log((ok?'✅ ':'❌ ')+id+' '+l+(d?' — '+d:''))};
const page=async()=>{const p=await (await b.newContext({viewport:{width:400,height:860},geolocation:{latitude:48.8566,longitude:2.3522},permissions:['geolocation']})).newPage();p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!/fonts|Failed to load resource/.test(m.text()))errs.push('console:'+m.text())});await p.goto('file:///tmp/livetest/index.html');await p.waitForTimeout(900);return p};
const login=async(p,e)=>{await p.fill('#lv-mail',e);await p.fill('#lv-pw','Motdepasse1!');await p.click('form[data-form="live-login"] button.pri');await p.waitForTimeout(900)};
const seed=(p,st,extra={})=>p.evaluate(([st,extra])=>{__db.bookings.push({id:'bk1',ref:'CMP-1100',client_id:'uC',companion_id:'uP',category:'shopping',starts_at:new Date(Date.now()+30*6e4).toISOString(),ends_at:new Date(Date.now()+150*6e4).toISOString(),hours:2,extra_minutes:0,place:'Musée d\'Orsay',amount_service:70,amount_client_fee:10.5,amount_vat:2.1,amount_annex:0,amount_total:82.6,amount_commission:14,amount_payout:56,status:st,created_at:new Date().toISOString(),tip:0,gift_used:0,mission_signed_client:new Date().toISOString(),mission_signed_companion:new Date().toISOString(),...extra})},[st,extra]);
const txt=p=>p.evaluate(()=>document.body.innerText);
// 1. Client : code de rencontre fourni par le serveur
let p=await page();await seed(p,'confirmee');await login(p,'sophie@test.fr');
await p.evaluate(()=>{S.tab='bookings';render()});await p.waitForTimeout(300);
let t=await txt(p);ck('U01','Client : code de rencontre (serveur) affiché','482 613'.replace(' ','')&&/482 613/.test(t));
ck('U02','Client : code de détresse disponible',/Code de détresse/.test(t));
// SOS : signalement + position
await p.evaluate(()=>{open('sos',{id:'bk1'});render()});await p.waitForTimeout(200);
const sosBtns=await p.$$eval('[data-a^="sos-"]',x=>x.map(e=>e.dataset.a));
await p.evaluate(()=>{const e=document.querySelector('[data-a="sos-report"]');e&&e.click()});await p.waitForTimeout(300);
await p.evaluate(()=>{const e=document.querySelector('[data-a="sos-loc"]');e&&e.click()});await p.waitForTimeout(800);
const calls=await p.evaluate(()=>__db.calls.filter(c=>c.fn==='sos').map(c=>c.body.kind+(c.body.latitude?'@'+c.body.latitude:'')));
ck('U03','SOS : signalement et position envoyés au serveur',calls.includes('report')&&calls.some(x=>/^location@48\.85/.test(x)),`boutons ${sosBtns.join(',')} · appels ${calls.join(',')}`);
// paiement indisponible : message honnête
await p.evaluate(()=>{__db.bookings[0].status='acceptee';liveLoad()});await p.waitForTimeout(500);
await p.evaluate(()=>{const b=S.bookings[0];res(api.pay(b))});await p.waitForTimeout(500);
t=await txt(p);ck('U04','Paiement : message « bientôt disponible » (pas de faux paiement)',/bientôt/.test(t));
// 2. Accompagnateur : saisie du code, début, fin
p=await page();await seed(p,'controle');await login(p,'camille@test.fr');
let r=await p.evaluate(()=>{const b=S.bookings[0];return api.verifyCode(b,'111')});ck('U05','Code incomplet refusé côté application',!!r.err,r.err);
await p.evaluate(()=>{const b=S.bookings[0];api.verifyCode(b,'000000')});await p.waitForTimeout(500);t=await txt(p);
ck('U06','Code faux : message du serveur affiché',/Code incorrect/.test(t));
await p.evaluate(()=>{api.verifyCode(S.bookings[0],'482613')});await p.waitForTimeout(600);
ck('U07','Code juste : rendez-vous vérifié (statut serveur)',(await p.evaluate(()=>S.bookings[0].status))==='verifie');
await p.evaluate(()=>{api.start(S.bookings[0],'companion')});await p.waitForTimeout(500);
await p.evaluate(()=>{__db.bookings[0].start_client=new Date().toISOString();__db.bookings[0].status='en_cours';liveLoad()});await p.waitForTimeout(500);
await p.evaluate(()=>{api.declareEnd(S.bookings[0],'companion')});await p.waitForTimeout(500);
ck('U08','Fin déclarée par l\'accompagnateur seul → double validation en attente',(await p.evaluate(()=>S.bookings[0].status))==='double_attente');
r=await p.evaluate(()=>api.openDispute(S.bookings[0],'companion','Retard','court','contestee'));ck('U09','Litige : description trop courte refusée',!!r.err);
// 3. Membre non vérifié : dépôt de pièce d'identité
p=await page();await login(p,'paul@test.fr');await p.evaluate(()=>{S.tab='account';S.accSub='identite';render()});await p.waitForTimeout(300);
t=await txt(p);ck('U10','Carte « Vérification d\'identité » affichée au membre non vérifié',/Vérification d'identité/.test(t));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
await p.setInputFiles('#id-doc',{name:'cni.png',mimeType:'image/png',buffer:png});await p.setInputFiles('#id-selfie',{name:'selfie.png',mimeType:'image/png',buffer:png});
await p.click('form[data-form="live-id"] button.pri');await p.waitForTimeout(900);
const up=await p.evaluate(()=>({u:__db.uploads,c:__db.identity_checks.length}));
ck('U11','Pièce et selfie envoyés dans le dossier privé du membre',up.u.length===2&&up.u.every(x=>x.startsWith('uN/'))&&up.c===1,up.u.join(' , '));
await p.evaluate(()=>{S.accSub='privee';render()});
ck('U12','Rubrique confidentialité (export / suppression) présente',/Confidentialité et suppression de compte/i.test(await txt(p))&&/Exporter mes données/.test(await txt(p)));
// 4. Administrateur : MFA obligatoire
p=await page();await login(p,'admin@test.fr');await p.waitForTimeout(600);t=await txt(p);
ck('A01','Admin : écran de double authentification avec QR code avant tout accès',/Double authentification/.test(t)&&!!(await p.$('img[alt^="QR"]'))&&!/Tableau de bord/.test(t));
await p.fill('#mfa-code','000000');await p.click('form[data-form="live-mfa"] button');await p.waitForTimeout(500);
ck('A02','Admin : mauvais code TOTP refusé',/Code invalide/.test(await txt(p))&&!(await p.evaluate(()=>S.adminOk)));
await p.fill('#mfa-code','123456');await p.click('form[data-form="live-mfa"] button');await p.waitForTimeout(900);t=await txt(p);
ck('A03','Admin : bon code TOTP → tableau de bord serveur (alertes)',/Tableau de bord/.test(t)&&/code de détresse/.test(t));
await p.evaluate(()=>{S.tab='users';render()});await p.waitForTimeout(300);await p.evaluate(()=>document.querySelector('[data-a="live-adm-id"][data-v="1"]').click());await p.waitForTimeout(500);
ck('A04','Admin : validation d\'identité envoyée au serveur',(await p.evaluate(()=>__db.calls.some(c=>c.fn==='admin-action'&&c.body.action==='identity_review'&&c.body.approve))));
await p.evaluate(()=>{S.tab='disputes';render()});await p.waitForTimeout(300);
await p.fill('form[data-form="live-adm-decide"] textarea','Retard confirmé par les messages');await p.click('form[data-form="live-adm-decide"] button.pri');await p.waitForTimeout(500);
ck('A05','Admin : décision de litige motivée envoyée',(await p.evaluate(()=>__db.calls.some(c=>c.fn==='admin-action'&&c.body.action==='dispute_decide'))));
ck('A06','Aucun code administrateur dans le code source',!(await p.content()).includes('246810'));
await p.evaluate(()=>{});{const q=await page();await seed(q,'confirmee');await login(q,'sophie@test.fr');await q.evaluate(()=>{api.send(S.bookings[0],'client','Mon numéro 06 12 34 56 78')});await q.waitForTimeout(300);const m=await q.evaluate(()=>__db.messages.map(x=>x.body));ck('U13','Message envoyé au serveur déjà masqué (téléphone)',m.length===1&&/\[masqué\]/.test(m[0])&&!/06 12/.test(m[0]),m.join('|'))}
console.log('Erreurs JS :',errs.length?errs.join(' | '):'aucune');
console.log(`${R.filter(Boolean).length}/${R.length} tests réussis`);await b.close()})();
