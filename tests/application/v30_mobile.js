// Application mobile v3.0 : plus d'accès administrateur, assistance intégrée, assurance RC obligatoire, photos vérifiées
const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const R=[],errs=[];const ck=(id,l,ok,d='')=>{R.push(ok);console.log((ok?'✅ ':'❌ ')+id+' '+l+(d?' — '+d:''))};
const page=async(u)=>{const ctx=await b.newContext({viewport:{width:390,height:844}});const p=await ctx.newPage();p.on('pageerror',e=>errs.push(e.message));await p.goto(u);await p.waitForTimeout(2300);return p};
// Démonstration
let p=await page('file:///tmp/demo.html');let t=await p.evaluate(()=>document.body.innerText);
ck('A01','Écran d\'accueil : plus aucun lien « Accès administrateur »',!/Accès administrateur/.test(t)&&!(await p.$('[data-a=role][data-v=admin]')));
await p.evaluate(()=>{S.page='app';S.role='admin';S.adminOk=true;S.tab='dashboard';render()});await p.waitForTimeout(300);t=await p.evaluate(()=>document.querySelector('main').innerText);
ck('A02','Même en forçant le rôle, l\'application n\'affiche aucune donnée d\'administration',!/Tableau de bord|Finances|Centre de résolution|Journal d'audit/.test(t));
await p.evaluate(()=>{S.role='client';S.adminOk=false;S.tab='account';S.accSub='aide';render()});await p.waitForTimeout(400);t=await p.evaluate(()=>document.querySelector('main').innerText);
ck('A03','Compte → Aide et assistance : « Mes demandes d\'assistance » avec suivi',/Mes demandes d'assistance/.test(t)&&/Question sur ma facture/.test(t)&&/Réponse reçue/.test(t));
await p.evaluate(()=>document.querySelector('[data-a=sup-new]').click());await p.waitForTimeout(300);await p.selectOption('#sup-cat','paiement');await p.fill('#sup-sub','Remboursement');await p.fill('#sup-body','court');await p.evaluate(()=>document.querySelector('form[data-form="sup-new"] button').click());await p.waitForTimeout(300);
const shortErr=await p.evaluate(()=>!document.getElementById('sup-err').hidden);
await p.fill('#sup-body','Je n\'ai pas reçu le remboursement de ma réservation annulée.');await p.evaluate(()=>document.querySelector('form[data-form="sup-new"] button').click());await p.waitForTimeout(400);t=await p.evaluate(()=>document.body.innerText);
ck('A04','Nouvelle demande : message trop court refusé, puis demande envoyée et suivie',shortErr&&/Remboursement/.test(t)&&/Envoyée/.test(t));
await p.evaluate(()=>{S.sheet=null;render();document.querySelector('[data-a=sup-open][data-id=sd1]').click()});await p.waitForTimeout(300);t=await p.evaluate(()=>document.querySelector('.sheet').innerText);
ck('A05','Fil de la demande : réponse de l\'assistance visible, réponse possible',/Assistance Side by Side/.test(t)&&!!(await p.$('form[data-form="sup-reply"]')));
const leg=await p.evaluate(()=>({c:legalDoc('contrat'),g:legalDoc('cgu')}));
ck('A06','Contrat accompagnateur : assurance RC obligatoire (plus « recommandée »)',/obligatoire : sans attestation valide/.test(leg.c)&&!/recommandée/.test(leg.c));
ck('A07','CGU : attestation d\'assurance RC exigée des accompagnateurs',/attestation d'assurance responsabilité civile à jour/.test(leg.g));
// Mode connecté (faux serveur)
p=await page('file:///tmp/livetest/index.html');
await p.fill('#lv-mail','admin@test.fr');await p.fill('#lv-pw','Motdepasse1!');await p.click('form[data-form="live-login"] button.pri');await p.waitForTimeout(1800);t=await p.evaluate(()=>document.body.innerText);
const st=await p.evaluate(()=>({role:S.role,me:typeof ME!=='undefined'&&ME?ME.role:null,qr:!!document.querySelector('img[alt*="QR"]')}));
ck('A08','Compte administrateur dans l\'application : refusé, déconnecté, aucune double authentification proposée',!st.qr&&st.role===null&&!/Tableau de bord/.test(t),JSON.stringify(st));
p=await page('file:///tmp/livetest/index.html');
await p.fill('#lv-mail','sophie@test.fr');await p.fill('#lv-pw','Motdepasse1!');await p.click('form[data-form="live-login"] button.pri');await p.waitForTimeout(1500);
await p.evaluate(()=>{S.tab='account';S.accSub='aide';render()});await p.waitForTimeout(600);
await p.evaluate(()=>document.querySelector('[data-a=sup-new]').click());await p.waitForTimeout(300);await p.selectOption('#sup-cat','reservation');await p.fill('#sup-sub','Changement d\'horaire');await p.fill('#sup-body','Puis-je décaler ma sortie de samedi à 15 h ?');await p.evaluate(()=>document.querySelector('form[data-form="sup-new"] button').click());await p.waitForTimeout(900);
const call=await p.evaluate(()=>__db.calls.find(c=>c.fn==='rpc:support_open'));t=await p.evaluate(()=>document.querySelector('main').innerText);
ck('A09','Mode connecté : la demande est enregistrée sur le serveur et apparaît dans la liste',!!call&&call.body.p_category==='reservation'&&/Changement d'horaire/.test(t)&&/AS-1001/.test(t));
const ph=await p.evaluate(()=>Object.keys(PHOTOS).some(k=>/^data:image\/svg/.test(PHOTOS[k])));
ck('A10','Photo validée de l\'accompagnateur affichée par lien temporaire',ph);
ck('A11','Aucune erreur JavaScript',errs.length===0,errs.slice(0,3).join(' | '));
await b.close();const n=R.filter(Boolean).length;console.log(`\n${n}/${R.length} tests réussis`);process.exit(n===R.length?0:1)})();
