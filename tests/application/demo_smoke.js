const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await (await b.newContext({viewport:{width:400,height:860}})).newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file:///tmp/demo.html');await p.waitForTimeout(1200);const ev=s=>p.evaluate(s);const R=[];const ck=(id,l,ok,d='')=>{R.push(ok);console.log((ok?'✅ ':'❌ ')+id+' '+l+(d?' — '+d:''))};
ck('D01','Démo : mode connecté inactif (aucun serveur)',(await ev('LIVE'))===false);
for(const role of ['client','companion']){await ev(`S.role='${role}';S.tab='home';render()`);for(const tab of await ev(`({client:['home','explore','bookings','messages','account'],companion:['home','requests','agenda','messages','profile']})['${role}']`)){await ev(`S.tab='${tab}';render()`)}}
ck('D02','Démo : tous les onglets client et accompagnateur s\'affichent sans erreur',errs.length===0,errs.join('|'));
await ev(`S.role='admin';S.adminOk=false;render()`);let t=await ev('document.body.innerText');
ck('D03','Démo admin : création du mot de passe exigée (aucun code par défaut)',/Créer le mot de passe administrateur/.test(t));
await p.fill('#as-new','faible');await p.fill('#as-new2','faible');await p.click('form[data-form="adm-setup"] button');await p.waitForTimeout(200);
ck('D04','Démo admin : mot de passe faible refusé',!(await ev('S.adminOk')));
await p.fill('#as-new','Rq7!vLm2#Tz9pK');await p.fill('#as-new2','Rq7!vLm2#Tz9pK');await p.click('form[data-form="adm-setup"] button');await p.waitForTimeout(500);
ck('D05','Démo admin : mot de passe robuste accepté → administration',await ev('S.adminOk'));
for(const tab of ['dashboard','disputes','users','settings','audit'])await ev(`S.tab='${tab}';render()`);
ck('D06','Démo admin : tous les onglets s\'affichent',errs.length===0,errs.join('|'));
await ev(`S.adminOk=false;render()`);await p.fill('#mfa-code','246810');await p.click('form[data-form="mfa"] button');await p.waitForTimeout(400);
ck('D07','Démo admin : l\'ancien code 246810 ne fonctionne plus',!(await ev('S.adminOk')));
await p.fill('#mfa-code','Rq7!vLm2#Tz9pK');await p.click('form[data-form="mfa"] button');await p.waitForTimeout(400);
ck('D08','Démo admin : connexion avec le mot de passe personnel',await ev('S.adminOk'));
for(const l of ['en','ar','de']){await ev(`S.lang='${l}';render()`)}
ck('D09','Démo : changement de langue (EN, AR, DE) sans erreur',errs.length===0,errs.join('|'));
console.log(`${R.filter(Boolean).length}/${R.length} tests réussis`);await b.close()})();
