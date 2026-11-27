const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const errs=[],R=[];const ck=(id,l,ok,d='')=>{R.push(ok);console.log((ok?'✅ ':'❌ ')+id+' '+l+(d?' — '+d:''))};
const page=async()=>{const p=await (await b.newContext({viewport:{width:400,height:860},acceptDownloads:true})).newPage();p.on('pageerror',e=>errs.push(e.message));await p.goto('file:///tmp/livetest/index.html');await p.waitForTimeout(800);return p};
const login=async(p,e)=>{await p.fill('#lv-mail',e);await p.fill('#lv-pw','Motdepasse1!');await p.click('form[data-form="live-login"] button.pri');await p.waitForTimeout(1000)};
let p=await page();await login(p,'camille@test.fr');await p.evaluate(()=>{S.tab='earnings';render()});await p.waitForTimeout(500);let t=(await p.evaluate(()=>document.body.innerText)).toLowerCase();
ck('L01','Mode connecté : revenus de l\'année chargés depuis le serveur',t.includes('mes documents fiscaux')&&/revenus nets/.test(t)&&t.includes('3'),'');
ck('L02','Mode connecté : attestation publiée listée',t.includes('attestation 2025'));
// v3.0 : la fiscalité DAC7 côté équipe est dans l'espace de gestion (/gestion : gestion.js G46, serveur : integration.mjs X01-X..)
p=await page();await login(p,'admin@test.fr');await p.waitForTimeout(600);
ck('L03','Application : aucun accès à la fiscalité DAC7 de l\'équipe (déplacée dans l\'espace de gestion)',!(await p.$('[data-a="dac7-generate"]'))&&!(await p.$('#mfa-code')));
ck('L05','Aucune erreur JavaScript',!errs.length,errs.join('|'));console.log(`${R.filter(Boolean).length}/${R.length} tests réussis`);await b.close()})();
