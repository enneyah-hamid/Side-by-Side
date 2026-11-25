const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await (await b.newContext()).newPage();await p.goto('file:///tmp/demo.html');await p.waitForTimeout(800);
const r=await p.evaluate(()=>{const out=[];const N=now();
 for(const b of S.bookings){const c=comp(b.companionId),h=b.history||[];
  for(let i=1;i<h.length;i++)if(h[i].t<h[i-1].t)out.push(`${b.ref} historique non chronologique : « ${h[i-1].s} » ${new Date(h[i-1].t).toISOString().slice(5,16)} puis « ${h[i].s} » ${new Date(h[i].t).toISOString().slice(5,16)}`);
  for(const e of h)if(e.t>N+6e4)out.push(`${b.ref} étape « ${e.s} » datée dans le futur`);
  const firstPay=h.find(e=>e.s==='paiement_confirme'),cr=h[0];
  if(['en_cours','double_attente','terminee','versement','cloturee'].includes(b.status)&&b.start>N)out.push(`${b.ref} statut ${b.status} mais rendez-vous dans le futur`);
  const d=new Date(b.start),hh=d.getHours()+d.getMinutes()/60,end=hh+b.hours+(b.extMins||0)/60;
  if(c&&(hh<c.from||end>c.to))out.push(`${b.ref} hors disponibilités de ${c.name} (${c.from} h–${c.to} h) : ${hh} h → ${end} h`);
  if(c&&!c.days.includes((d.getDay()+6)%7))out.push(`${b.ref} jour non travaillé par ${c.name}`);
  const sg=b.mission&&b.mission.signed||{};if(sg.client&&sg.companion&&firstPay&&firstPay.t<Math.max(sg.client,sg.companion))out.push(`${b.ref} payé avant la signature`);
  if(b.ends&&b.ends.client&&b.ends.client<b.start)out.push(`${b.ref} fin validée avant le début`);
  if(cr&&cr.t>b.start-24*36e5+6e4)out.push(`${b.ref} demande créée moins de 24 h avant le rendez-vous`);
 }
 // chevauchements
 for(const a of S.bookings)for(const x of S.bookings)if(a.id<x.id&&a.companionId===x.companionId&&ACTIVE.includes(a.status)&&ACTIVE.includes(x.status)&&a.start<endOf(x)&&x.start<endOf(a))out.push(`${a.ref} et ${x.ref} se chevauchent`);
 return out});
console.log(r.join('\n')||'aucune incohérence');console.log(r.length,'anomalie(s)');await b.close()})();
