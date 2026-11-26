const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:390,height:844}});const errs=[];p.on('pageerror',e=>errs.push(e.message));await p.goto('file:///tmp/demo.html');await p.waitForTimeout(900);
const R=[];const ck=(id,l,ok,d='')=>{R.push(ok);console.log((ok?'✅ ':'❌ ')+id+' '+l+(d?' — '+d:''))};const ev=f=>p.evaluate(f);
await ev(()=>{S.role='client';S.tab='home';render()});
for(const h of ['3','4','5']){await p.selectOption('#hs-dur',h);await p.fill('#hs-city','Paris');await p.click('#hs-form button.pri');await p.waitForTimeout(200);
  const ok=await ev(()=>S.hs.dur);await p.click('#hs-res [data-a="hs-book"]');await p.waitForTimeout(200);
  const v=await p.inputValue('#b-h'),pr=await ev(()=>document.getElementById('pricebox').innerText);const c=await ev(()=>comp(S.sheet.cid).rate);
  ck('D'+h,`Accueil ${h} h → fiche de réservation ${h} h, prix calculé sur ${h} h`,ok===+h&&v===h&&pr.includes(new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(c*h)),`fiche ${v} h`);await ev(()=>{S.sheet=null;render()})}
// Depuis Explorer (filtre Durée) puis profil → Réserver
await ev(()=>{S.tab='explore';S.openFilters=true;render()});await p.selectOption('#f-dur','5');await p.waitForTimeout(200);
await ev(()=>{open('book',{cid:'c1'});render()});ck('E1','Explorer 5 h → fiche 5 h',(await p.inputValue('#b-h'))==='5');
// Jour choisi dans le calendrier du profil
await ev(()=>{S.lastDur=4;S.sheet=null;const d=freeDays(comp('c1'),4)[0];document.body.insertAdjacentHTML('beforeend',`<button id="pd" data-a="pick-day" data-id="c1" data-v="${d}"></button>`)});await ev(()=>document.getElementById('pd').click());await p.waitForTimeout(200);
ck('P1','Jour choisi dans le calendrier → durée choisie conservée (4 h)',(await ev(()=>S.sheet&&S.sheet.hours))===4&&(await p.inputValue('#b-h'))==='4');
// Changement dans la fiche puis envoi
await p.selectOption('#b-h','3');await p.waitForTimeout(200);const r=await ev(()=>{const f=document.querySelector('form[data-form="book"]');const s0=f.querySelector('#b-start');return {h:f.querySelector('#b-h').value,start:s0?s0.value:''}});
const res=await ev(()=>{const f=document.querySelector('form[data-form="book"]'),fd=Object.fromEntries(new FormData(f));const n=S.bookings.length;const x=api.create(f.dataset.cid,{...fd,place:'Musée du Louvre, Paris',ackRules:'1'});const b=S.bookings[S.bookings.length-1];return{err:x.err,hours:S.bookings.length>n?b.hours:null,prest:b&&b.prest}});
ck('B1','Réservation envoyée avec 3 h, montant calculé sur 3 h',res.hours===3&&res.prest===35*3,JSON.stringify(res));
// Assistant : « pendant 4 heures » et sans durée écrite
await ev(()=>{S.sheet=null;S.tab='home';render();const f=document.querySelector('form[data-form="assist"]');f.ask.value='musée à Paris le 30 novembre pendant 4 heures';f.querySelector('button').click()});
ck('A1','Assistant « pendant 4 heures » → 4 h',await ev(()=>S.assist.R.q.dur===4&&S.lastDur===4));
await ev(()=>{S.hs.dur=5;const f=document.querySelector('form[data-form="assist"]');f.ask.value='une promenade à Paris samedi';f.querySelector('button').click()});
ck('A2','Assistant sans durée écrite → durée choisie dans la recherche (5 h)',await ev(()=>S.assist.R.q.dur===5));
ck('Z','Aucune erreur',errs.length===0,errs.join('|'));console.log(`\n${R.filter(Boolean).length}/${R.length}`);await b.close()})();
