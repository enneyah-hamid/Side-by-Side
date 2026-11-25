const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();
for(const w of [320,360,400]){for(const comfort of [false,true]){for(const lang of ['fr','de','pt']){const p=await (await b.newContext({viewport:{width:w,height:800}})).newPage();await p.goto('file:///tmp/demo.html');await p.waitForTimeout(700);
 const r=await p.evaluate(([c,l])=>{S.comfort=c;S.lang=l;const out=[];for(const role of ['client','companion']){S.role=role;S.tab='home';render();document.querySelectorAll('.tabs button span').forEach(s=>{if(s.scrollWidth>s.clientWidth+1)out.push(role+':'+s.textContent)})}return out},[comfort,lang]);
 if(r.length)console.log(w,comfort?'confort':'normal',lang,'TRONQUÉ',r.join(', '));await p.close()}}}console.log('fin');await b.close()})();
