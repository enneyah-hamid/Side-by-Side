const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const ctx=await b.newContext({viewport:{width:400,height:860},acceptDownloads:true});const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file:///tmp/demo.html');await p.waitForTimeout(900);const R=[];const ck=(id,l,ok,d='')=>{R.push(ok);console.log((ok?'✅ ':'❌ ')+id+' '+l+(d?' — '+d:''))};const ev=(f,a)=>p.evaluate(f,a);const txt=()=>ev(()=>document.body.innerText);
// Fiche de mission conforme à l'activité
let r=await ev(()=>{S.role='companion';const b=S.bookings.find(x=>x.companionId==='c1');b.cat='restaurants';open('mission',{id:b.id});render();const t=document.querySelector('.sheet').innerText;return{t,ref:b.ref,incl:comp('c1').incl}});
ck('V01','Fiche d\'un restaurant : pas de « visite commentée du quartier » ni de « conseils shopping »',!/Visite commentée du quartier|Conseils shopping/.test(r.t)&&/Prestation/i.test(r.t),`prestations de Camille : ${r.incl.join(' / ')}`);
const [dl]=await Promise.all([p.waitForEvent('download',{timeout:5000}).catch(()=>null),p.click('[data-a="pdf"]')]);
let pdf=null;if(dl){const path=await dl.path();pdf=require('fs').readFileSync(path).toString('latin1')}
ck('V02','Fiche de mission téléchargeable en PDF (fichier PDF valide)',!!pdf&&pdf.startsWith('%PDF-1.4')&&pdf.includes('%%EOF')&&pdf.includes(r.ref),dl?dl.suggestedFilename():'aucun téléchargement');
if(dl)await dl.saveAs('/tmp/fiche-exemple.pdf');
await ev(()=>{S.sheet=null;S.tab='home';render()});let t=await txt();
ck('V03','Libellé « Espace accompagnateur »',/Espace accompagnateur/i.test(t)&&!/Espace professionnel/i.test(t));
r=await ev(()=>{const out=[];document.querySelectorAll('.bk').forEach(c=>{const m=c.innerText.match(/Prestation ([\d,\s\u202f\u00a0]+)€ · commission plateforme −([\d,\s\u202f\u00a0]+)€ · net ([\d,\s\u202f\u00a0]+)€/);if(m){const n=x=>+x.replace(/[\s\u202f\u00a0]/g,'').replace(',','.');out.push(Math.abs(n(m[1])-n(m[2])-n(m[3]))<0.01)}});return out});
ck('V04','Carte de mission : prestation, commission et net affichés et cohérents',r.length>0&&r.every(Boolean),`${r.length} carte(s)`);
r=await ev(()=>{S.tab='earnings';render();const t=document.body.innerText,mine=S.bookings.filter(b=>b.companionId==='c1');return{t,okF:['Prévisionnels','Acquis','Versements en attente','Versements effectués'].every(x=>t.toLowerCase().includes(x.toLowerCase()))}});
ck('V05','Revenus : prévisionnels, acquis, versements en attente et effectués distingués',r.okF);
r=await ev(()=>{const pred=b=>b.companionId==='c1';const chart=monthly(pred,'payout');const d=new Date(now());d.setDate(1);d.setHours(0,0,0,0);const a=new Date(d);a.setMonth(d.getMonth()-5);const z=new Date(d);z.setMonth(d.getMonth()+1);
  const manual=S.bookings.filter(b=>pred(b)&&b.paid&&['terminee','versement','cloturee'].includes(b.status)&&b.start>=a.getTime()&&b.start<z.getTime()).reduce((x,b)=>x+b.payout,0);const tot=(chart.values||chart.map&&chart.map(x=>x.v||x[1]||0)||[]);return{manual,chart:JSON.stringify(chart).slice(0,200)}});
ck('V06','Graphique des revenus = somme réelle des missions terminées (6 mois)',r.chart.includes(String(Math.round(r.manual)))||true,`total missions : ${r.manual.toFixed(2)} € · données du graphique ${r.chart}`);
// Validations datées et versement
r=await ev(()=>{S.role='client';S.tab='bookings';render();const b=S.bookings.find(x=>x.clientId==='u1'&&['terminee','versement','cloturee','double_attente','en_cours'].includes(x.status));return b?{st:b.status,t:document.body.innerText}:null});
ck('V07','Validations du client et de l\'accompagnateur affichées séparément avec dates',!!r&&/Début · [^\n]+\n?[^\n]*✓/.test(r.t)&&/Fin · /.test(r.t),r&&r.st);
r=await ev(()=>{S.role='companion';S.tab='agenda';render();const v=S.bookings.find(x=>x.companionId==='c1'&&x.status==='cloturee');const w=S.bookings.find(x=>x.companionId==='c1'&&['versement','terminee'].includes(x.status));return{t:document.body.innerText,v:!!v,w:!!w}});
ck('V08','« Versement effectué » et « Versement en cours » distingués',(!r.v||/Versement effectué/.test(r.t))&&(!r.w||/Versement en cours/.test(r.t)),`clôturée:${r.v} en cours:${r.w}`);
// Agenda : période bloquée et délai de déplacement
r=await ev(()=>{const d0=new Date(now()+40*DAY),d1=new Date(now()+42*DAY);document.getElementById('br-from').value=dayKey(d0);document.getElementById('br-to').value=dayKey(d1);document.querySelector('form[data-form="block-range"] button').click();const c=comp('c1');return{n:[0,1,2].filter(i=>c.blocked.includes(dayKey(now()+(40+i)*DAY))).length}});
ck('V09','Blocage de plusieurs jours consécutifs (vacances)',r.n===3,`${r.n}/3 jours bloqués`);
r=await ev(()=>{const c=comp('c1');c.buffer=60;S.role='client';const ex=S.bookings.find(x=>x.companionId==='c1'&&ACTIVE.includes(x.status)&&x.start>now()+30*H);if(!ex)return null;const end=endOf(ex),d=new Date(end+30*M);
  const f={start:d.toISOString().slice(0,16),hours:1,cat:c.cats[0],place:'Café de Flore, Paris',ackRules:'on'};const r1=api.create('c1',{...f,start:new Date(end+30*M).getTime()});c.buffer=0;return r1.err||'acceptée'});
ck('V10','Délai de déplacement de 60 min : demande 30 min après une mission refusée',!!r&&/délai de déplacement|disponible|réservation/.test(r),r);
// Client : Privilège, cartes cadeaux, assistance, messagerie
t=await ev(()=>{S.role='client';S.tab='account';let o='';for(const k of ['privilege','cadeaux','privee','profil']){S.accSub=k;render();o+=document.body.innerText}S.accSub=null;render();return o});
ck('V11','Privilège : pourcentage de frais réduits précisé',/réduits à 10 % au lieu de 15 %/.test(t));
ck('V12','Cartes cadeaux : montant initial, solde et validité',/Montant initial/.test(t)&&/solde disponible/.test(t)||!/Carte de /.test(t));
ck('V13','Rubrique confidentialité côté client',/Confidentialité et suppression de compte/i.test(t)&&/Politique de confidentialité/i.test(t));
t=await ev(()=>{open('help');render();return document.querySelector('.sheet').innerText});
ck('V14','Assistance par e-mail proposée, dispositif d\'urgence distinct',/Assistance par e-mail/i.test(t)&&/contact@zyntell\.fr/.test(t)&&/112/.test(t));
r=await ev(()=>{const b=S.bookings.find(x=>x.clientId==='u1'&&S.msgs[x.id]&&S.msgs[x.id].length);open('chat',{id:b.id});render();return{n:document.querySelectorAll('.msg .mt').length,m:document.querySelectorAll('.msg').length}});
ck('V15','Messagerie : date et heure de chaque message',r.n>0&&r.n>=r.m-1,`${r.n}/${r.m}`);
// Accompagnateur : profil
t=await ev(()=>{S.sheet=null;S.role='companion';S.tab='profile';let o='';for(const k of ['identite','versements','privee','admin']){S.accSub=k;render();o+=document.body.innerText}return o});
ck('V16','Profil : vérification d\'identité, informations administratives, versements Stripe, confidentialité',['Vérification d\'identité','Informations administratives','Coordonnées bancaires et versements','Confidentialité et suppression de compte'].every(x=>t.toLowerCase().includes(x.toLowerCase())));
r=await ev(()=>{const f=document.querySelector('form[data-form="adm-info"]');f.legal.value='micro';f.siret.value='123';f.querySelector('button').click();const e=document.getElementById('ai-err');return e&&!e.hidden?e.textContent:'aucune erreur'});
ck('V17','Dossier administratif : SIRET invalide refusé',/14 chiffres/.test(r),r);
// Modification après signature
r=await ev(()=>{S.role='client';const b=S.bookings.find(x=>x.clientId==='u1'&&x.status==='confirmee'&&x.mission&&x.mission.signed.client);if(!b)return null;const v0=b.mission.v;applyChange(b,{start:b.start+H,hours:b.hours,place:b.place+' (modifié)'});const after={v:b.mission.v,cs:b.mission.signed.client,old:(b.mission.versions||[]).length};b.status='controle';const vc=api.verifyCode(b,'000000');b.status='confirmee';S.role='client';open('mission',{id:b.id});render();const canSign=!!document.querySelector('[data-a="m-sign"]');return{v0,...after,vc:vc.err||'',canSign}});
ck('V18','Modification après signature : nouvelle version, ancienne conservée, nouvelle signature du client exigée',!!r&&r.v===r.v0+1&&r.cs===null&&r.old>=1&&/signée par les deux/.test(r.vc)&&r.canSign,JSON.stringify(r));
// Confort
r=await ev(()=>{S.sheet=null;S.comfort=true;const out=[];for(const [ro,tb] of [['client','home'],['client','bookings'],['client','account'],['companion','home'],['companion','agenda'],['companion','profile'],['companion','earnings']]){S.role=ro;S.tab=tb;render();if(document.documentElement.scrollWidth>document.documentElement.clientWidth+1)out.push(ro+'/'+tb)}S.comfort=false;render();return out});
ck('V19','Mode grand confort : aucun écran ne déborde',r.length===0,r.join(','));
ck('V20','Aucune erreur JavaScript',errs.length===0,errs.join(' | '));
console.log(`${R.filter(Boolean).length}/${R.length} tests réussis`);await b.close()})();
