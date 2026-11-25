const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const res=new Set();
for(const w of [340,400]){for(const comfort of [false,true]){const p=await (await b.newContext({viewport:{width:w,height:900}})).newPage();await p.goto('file:///tmp/demo.html');await p.waitForTimeout(700);
 const views=[['client','home'],['client','bookings'],['client','account'],['companion','home'],['companion','requests'],['companion','agenda'],['companion','profile'],['companion','messages']];
 for(const [r,t] of views){const o=await p.evaluate(([r,t,c])=>{S.comfort=c;S.role=r;S.tab=t;render();const out=[];const W=document.documentElement.clientWidth;
   document.querySelectorAll('main .pill, main .badge, main .gtile i').forEach(e=>{const a=e.getBoundingClientRect();if(a.right>W+1)out.push('déborde écran: '+e.textContent.trim().slice(0,30));
     [...e.parentElement.children].forEach(x=>{if(x===e)return;const q=x.getBoundingClientRect();if(q.width&&a.width&&a.left<q.right-1&&q.left<a.right-1&&a.top<q.bottom-1&&q.top<a.bottom-1&&!x.contains(e)&&!e.contains(x))out.push('chevauche: «'+e.textContent.trim().slice(0,30)+'» / «'+x.textContent.trim().slice(0,30)+'»')})});
   if(document.documentElement.scrollWidth>W+1)out.push('page plus large que l\'écran');return out},[r,t,comfort]);
  o.forEach(x=>res.add(`${w}${comfort?' confort':''} ${r}/${t} ${x}`))}
 for(const [r] of [['client'],['companion']]){const o=await p.evaluate(([r,c])=>{S.comfort=c;S.role=r;const b=S.bookings.find(x=>(r==='client'?x.clientId==='u1':x.companionId==='c1')&&S.msgs[x.id]);if(!b)return[];open('chat',{id:b.id});render();const W=document.documentElement.clientWidth,out=[];document.querySelectorAll('.qr .chip').forEach(e=>{if(e.getBoundingClientRect().right>W+1)out.push('message prédéfini hors écran: '+e.textContent.slice(0,25))});S.sheet=null;return out},[r,comfort]);o.forEach(x=>res.add(`${w}${comfort?' confort':''} ${r}/chat ${x}`))}
 await p.close()}}
console.log([...res].join('\n')||'aucun chevauchement ni débordement');await b.close()})();
