const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await (await b.newContext({viewport:{width:390,height:780}})).newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file:///tmp/demo.html');await p.waitForTimeout(900);const R=[];const ck=(l,ok,d='')=>{R.push(ok);console.log((ok?'✅ ':'❌ ')+l+(d?' — '+d:''))};
const st=()=>p.evaluate(()=>{const t=document.querySelector('.tabs');const r=t.getBoundingClientRect();return{hid:document.documentElement.classList.contains('navhide'),top:Math.round(r.top),vh:innerHeight,h:document.documentElement.scrollHeight}});
for(const [role,tab] of [['client','home'],['companion','home']]){await p.evaluate(([r,t])=>{S.role=r;S.tab=t;render();scrollTo(0,0)},[role,tab]);await p.waitForTimeout(300);
 await p.mouse.wheel(0,500);await p.waitForTimeout(500);let a=await st();ck(`${role} : défilement vers le bas → barre masquée`,a.hid&&a.top>=a.vh-1,`hauteur page ${a.h}`);
 await p.mouse.wheel(0,-150);await p.waitForTimeout(500);a=await st();ck(`${role} : défilement vers le haut → barre réapparaît`,!a.hid&&a.top<a.vh);
 await p.mouse.wheel(0,400);await p.waitForTimeout(400);await p.evaluate(()=>{S.tab=S.role==='client'?'bookings':'agenda';render()});await p.waitForTimeout(400);a=await st();ck(`${role} : changement d'onglet → barre visible`,!a.hid);
 await p.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await p.waitForTimeout(500);a=await st();ck(`${role} : bas de page atteint → barre visible`,!a.hid)}
ck('Aucune erreur JavaScript',!errs.length,errs.join('|'));console.log(`${R.filter(Boolean).length}/${R.length}`);await b.close()})();
