const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await (await b.newContext({viewport:{width:400,height:860}})).newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file:///tmp/demo.html');await p.waitForTimeout(1200);const ev=s=>p.evaluate(s);const R=[];const ck=(id,l,ok,d='')=>{R.push(ok);console.log((ok?'✅ ':'❌ ')+id+' '+l+(d?' — '+d:''))};
ck('D01','Démo : mode connecté inactif (aucun serveur)',(await ev('LIVE'))===false);
for(const role of ['client','companion']){await ev(`S.role='${role}';S.tab='home';render()`);for(const tab of await ev(`({client:['home','explore','bookings','messages','account'],companion:['home','requests','agenda','messages','profile']})['${role}']`)){await ev(`S.tab='${tab}';render()`)}}
ck('D02','Démo : tous les onglets client et accompagnateur s\'affichent sans erreur',errs.length===0,errs.join('|'));
await ev(`S.role='admin';S.adminOk=false;render()`);let t=await ev('document.body.innerText');
ck('D03','Application v3.0 : aucun accès administrateur (renvoi vers l\'espace de gestion sécurisé)',!/Créer le mot de passe administrateur/.test(t)&&!(await p.$('form[data-form="mfa"]'))&&!(await p.$('form[data-form="adm-setup"]')),t.slice(0,120).replace(/\n/g,' '));
await ev(`S.role=null;render()`);t=await ev('document.body.innerText');
ck('D04','Écran d\'accueil : plus de lien « Accès administrateur »',!/Accès administrateur/.test(t));
await ev(`S.role='client';S.tab='home';render()`);
for(const l of ['en','ar','de']){await ev(`S.lang='${l}';render()`)}
ck('D09','Démo : changement de langue (EN, AR, DE) sans erreur',errs.length===0,errs.join('|'));
console.log(`${R.filter(Boolean).length}/${R.length} tests réussis`);await b.close()})();
