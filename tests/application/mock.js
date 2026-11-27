// Faux serveur Supabase pour tester le mode connecté sans réseau
(function(){
const db={users:[{id:'uA',email:'admin@test.fr',pw:'Motdepasse1!',confirmed:true},{id:'uN',email:'paul@test.fr',pw:'Motdepasse1!',confirmed:true},{id:'uC',email:'sophie@test.fr',pw:'Motdepasse1!',confirmed:true},{id:'uP',email:'camille@test.fr',pw:'Motdepasse1!',confirmed:true}],
 profiles:[{id:'uC',role:'client',first_name:'Sophie',last_name:'M',city:'Paris',phone:'0612345678',identity_verified:true,suspended:false,referral_code:'ABCD1234',birth_date:'1980-01-01'},
           {id:'uP',role:'companion',first_name:'Camille',last_name:'D',city:'Paris',identity_verified:true,suspended:false,birth_date:'1992-03-04'},
           {id:'uA',role:'admin',first_name:'Hamid',last_name:'E',city:'Maromme',identity_verified:true,suspended:false,birth_date:'1980-01-01'},
           {id:'uN',role:'client',first_name:'Paul',last_name:'N',city:'Paris',identity_verified:false,suspended:false,birth_date:'1985-01-01'}],
 companions:[{id:'uP',first_name:'Camille',city:'Paris',area:'Le Marais',bio:'Guide passionnée',hourly_rate:35,tier:'Standard',languages:['Français','Anglais'],categories:['shopping','musees','seniors'],included:[],excluded:[],work_days:[0,1,2,3,4,5,6],hour_from:9,hour_to:21,rating:5,reviews:2,photo_path:'uP/avatar-1.jpg'}],
 companion_insurances:[],support_tickets:[],support_messages:[],open_requests:[],request_offers:[],bookings:[],messages:[],notifications:[],tax_certificates:[{year:2025,version:1,data:{quarters:[{missions:1,consideration:61,fees:14,taxes:0},{missions:0,consideration:0,fees:0,taxes:0},{missions:0,consideration:0,fees:0,taxes:0},{missions:1,consideration:84,fees:21,taxes:0}],missions:2,consideration:145,fees:35},published_at:'2026-01-20T10:00:00Z'}],companions_rows:[],identity_checks:[],uploads:[],calls:[],seq:1100,aal:'aal1',factor:null};
let session=null;const subs=[];window.__db=db;
const ok=d=>Promise.resolve({data:d,error:null}),ko=m=>Promise.resolve({data:null,error:{message:m}}),ko2=(st,m)=>Promise.resolve({data:null,error:{message:m,context:{json:async()=>({error:m})}}});
const prof=()=>db.profiles.find(p=>p.id===session.user.id);
function q(table){let rows=null,filters=[],single=false,op='select',payload=null;
  const api={select(){return api},limit(){return api},maybeSingle(){single=true;return api},update(p){op='update';payload=p;return api},eq(k,v){filters.push(r=>r[k]===v);return api},in(k,v){filters.push(r=>v.includes(r[k]));return api},order(){return api},single(){single=true;return api},
    insert(p){op='insert';payload=p;return api},
    then(res,rej){let out;if(op==='update'){rows=(db[table]||[]).filter(r=>filters.every(f=>f(r)));rows.forEach(r=>Object.assign(r,payload));out={data:rows,error:null}}else if(op==='insert'){const r={id:Date.now(),created_at:new Date().toISOString(),...(table==='companion_insurances'?{id:'ins'+Date.now(),status:'en_attente'}:{}),...payload};db[table].push(r);subs.forEach(f=>f());out={data:r,error:null}}
      else{rows=(db[table]||[]).filter(r=>filters.every(f=>f(r)));out={data:single?rows[0]||null:rows,error:single&&!rows[0]?{message:'not found'}:null}}
      return Promise.resolve(out).then(res,rej)}};return api}
function rpc(name){const me=session&&session.user.id;
  if(name==='my_tax_year')return ok([{month:3,quarter:1,missions:2,gross:140,fees:28,tips:5,annex:0},{month:11,quarter:4,missions:1,gross:105,fees:21,tips:0,annex:0}]);
  if(name==='search_open_requests'){const c=(arguments[1]||{}).p_city;db.searched=c;return ok((db.open_requests||[]).filter(r=>!c||r.city.toLowerCase()===String(c).toLowerCase()).map(r=>({id:r.id,city:r.city,country:r.country,starts_at:r.starts_at,hours:r.hours,category:r.category,note:r.note,client_first_name:'Sophie',offers:0,mine:false})))}
  if(name==='my_request_offers')return ok((db.request_offers||[]).map(o=>({request_id:o.request_id,companion_id:o.companion_id,first_name:'Camille',hourly_rate:35,message:o.message,status:'proposee'})));
  if(name==='tax_profile_issues')return ok([{field:'NIF',message:'Numéro fiscal manquant (il figure sur votre avis d\'impôt)',blocking:false}]);
  if(name==='my_tax_breakdown')return ok([{missions:3,gross:245,commission:49,annex:0,tips:5,net_paid:201,declarable:201,cancelled:1,taxes:0}]);
  if(name==='companions_directory')return ok(db.companions);
  if(name==='support_open'){const a=arguments[1]||{};if(String(a.p_body||'').trim().length<10)return ko('Décrivez votre demande (10 caractères minimum)');const t={id:'tk'+(db.support_tickets.length+1),ref:'AS-'+(1001+db.support_tickets.length),user_id:me,category:a.p_category,subject:a.p_subject,status:'ouverte',created_at:new Date().toISOString(),last_message_at:new Date().toISOString()};db.support_tickets.push(t);db.support_messages.push({ticket_id:t.id,from_staff:false,body:a.p_body,created_at:t.created_at});db.calls.push({fn:'rpc:support_open',body:a});return ok(t)}
  if(name==='support_reply'){const a=arguments[1]||{};db.support_messages.push({ticket_id:a.p_ticket,from_staff:false,body:a.p_body,created_at:new Date().toISOString()});return ok(null)}
  if(name==='support_resolve'){const t=db.support_tickets.find(x=>x.id===(arguments[1]||{}).p_ticket);if(t)t.status='resolue';return ok(null)}
  if(name==='my_bookings')return ok(db.bookings.filter(b=>b.client_id===me||b.companion_id===me).map(b=>({booking:b,client_first_name:db.profiles.find(p=>p.id===b.client_id).first_name,companion_first_name:db.profiles.find(p=>p.id===b.companion_id).first_name})));
  return ko('unknown rpc')}
function invoke(fn,{body}){const me=session&&session.user.id;let r;db.calls.push({fn,body});
  if(fn==='mission-action'){const b=db.bookings.find(x=>x.id===body.booking_id);const a=body.action;
    if(a==='get_code'){if(b.client_id!==me)return ko2(409,'Code indisponible');return ok({code:'482613',distress:'905172',expires_at:new Date(Date.now()+5*36e5).toISOString()})}
    if(a==='presence'){b.status='controle';b[me===b.client_id?'presence_client':'presence_companion']=new Date().toISOString()}
    if(a==='verify_code'){if(body.code!=='482613'&&body.code!=='905172')return ko2(400,'Code incorrect. Il reste 4 essai(s).');b.status='verifie'}
    if(a==='start'){b[me===b.client_id?'start_client':'start_companion']=new Date().toISOString();if(b.start_client&&b.start_companion)b.status='en_cours'}
    if(a==='end'){b[me===b.client_id?'end_client':'end_companion']=new Date().toISOString();b.status=b.end_client&&b.end_companion?'cloturee':'double_attente'}
    if(a==='interrupt')b.status='incident';
    if(a==='dispute')b.status='contestee';
    subs.forEach(f=>f());return ok({ok:true})}
  if(fn==='tax-admin'){if(db.aal!=='aal2')return ko2(403,'Double authentification requise');db.calls.push({fn,body});
    if(body.action==='overview')return ok({year:body.year,companions_total:12,concerned:3,total_missions:9,total_consideration:812,total_fees:203,sellers:[{name:'Camille D',missions:3,consideration:279,fees:49,issues:0}],issues:[{who:'Zyntell (opérateur)',field:'SIREN',blocking:true,message:'SIREN manquant'}],blocking:1,declarations:[{id:'d1',version:1,kind:'initiale',status:'a_corriger',message_ref_id:'OP_2025_123456789_001',sellers:3,total_consideration:812,errors:[{code:'80010',details:'TIN invalide',doc_ref_id:'OP_V1'}]}],certificates_published:3,deadline:'x',portal:'https://www.impots.gouv.fr',stage:'a_corriger',breakdown:[{companion_id:'uP',name:'Camille D',missions:3,client_paid:330.5,client_fees:36.75,client_vat:7.35,gross:245,commission:49,annex:0,tips:5,net_paid:201,declarable:201,cancelled:1,refunds:82.6,taxes:0}],receipts:[{id:'r1',declaration_id:'d1',official_status:'accepte_avec_erreurs',reference:'CR-2026-7',file_name:'cr.xml',created_at:'2026-01-25T10:00:00Z'}]});
    if(body.action==='export')return ok({csv:'\ufeffAnnée;Nom',name:'x.csv'});if(body.action==='certificates_bundle')return ok({certificates:[{companion_id:'uP',year:body.year,version:1,data:{name:'Camille D',quarters:[{missions:2,consideration:117,fees:28,taxes:0},{missions:0,consideration:0,fees:0,taxes:0},{missions:0,consideration:0,fees:0,taxes:0},{missions:1,consideration:84,fees:21,taxes:0}],missions:3,consideration:201,fees:49},nif:'1234567890123',postal_address:'8 rue de Bretagne, 75003 Paris',tax_country:'FR'}]});if(body.action==='import_receipt')return ok({ok:true,status:'a_corriger',official:'accepte_avec_erreurs',errors:[{code:'80010',details:'TIN invalide',doc_ref_id:'X'}]});return ok({ok:true})}
  if(fn==='complete-profile'){const p=prof();if(p.birth_date)return ko2(409,'Profil déjà complété');Object.assign(p,{birth_date:body.birth_date,role:body.role,city:body.city,country:body.country,phone:body.phone});return ok({ok:true})}
  if(fn==='insurance'){if(db.aal!=='aal2')return ko2(403,'Double authentification requise');
    if(body.action==='list')return ok({rows:db.companion_insurances.map(i=>({...i,name:'Camille D',state:i.status==='validee'?'valide':i.status})),uninsured:[{companion_id:'uP',name:'Camille D'}],affected:[{booking_id:'b9',ref:'CMP-1200',companion_id:'uP',companion_name:'Camille D',starts_at:new Date(Date.now()+5*864e5).toISOString(),status:'confirmee'}],history:[],required:true,counts:{assures:0,attente:db.companion_insurances.filter(i=>i.status==='en_attente').length,expirees:0,bientot:0,sans:1}});
    if(body.action==='review'){const i=db.companion_insurances.find(x=>x.id===body.id);if(!body.approve&&!(body.reason||'').trim())return ko2(400,'Indiquez le motif du refus');i.status=body.approve?'validee':'refusee';i.refusal_reason=body.reason||null;return ok({ok:true})}
    if(body.action==='doc')return ok({url:'https://example.invalid/attestation.pdf'});return ok({ok:true})}
  if(fn==='sos')return ok({ok:true,emergency_number:'112'});
  if(fn==='create-payment')return ko2(503,'Le paiement en ligne sera disponible très bientôt.');
  if(fn==='account')return ok(body.action==='export'?{profile:prof(),bookings:[]}:{ok:true});
  if(fn==='admin-action'){if(db.aal!=='aal2')return ko2(403,'Double authentification requise');
    if(body.action==='overview')return ok({identity:[{id:'idc1',user_id:'uN',doc_url:'https://x/doc',selfie_url:'https://x/selfie',created_at:new Date().toISOString(),profiles:{first_name:'Paul',last_name:'N',birth_date:'1990-01-01',role:'client'}}],companions:[],disputes:[{id:'d1',reason:'Retard',description:'Arrivé 40 minutes en retard',deadline:new Date(Date.now()+864e5).toISOString(),bookings:{ref:'CMP-1100',amount_total:82.6,amount_payout:56}}],alerts:[{id:1,kind:'code de détresse (client)',user_id:'uC',created_at:new Date().toISOString(),latitude:48.85,longitude:2.35,bookings:{ref:'CMP-1100'}}],review:[],logs:[{created_at:new Date().toISOString(),action:'Consultation du tableau de bord',ref:null}]});
    return ok({ok:true})}
  if(fn==='create-booking'){const c=db.companions.find(x=>x.id===body.companion_id);if(!c)return ok({error:'Accompagnateur indisponible'});
    const svc=Math.round(c.hourly_rate*body.hours*100)/100,fee=Math.round(svc*15)/100,vat=Math.round(fee*20)/100,comm=Math.round(svc*20)/100;
    const b={id:'bk'+(db.seq),ref:'CMP-'+(db.seq++),client_id:me,companion_id:body.companion_id,category:body.category,starts_at:body.starts_at,hours:body.hours,place:body.place,language:body.language,note:body.note,amount_service:svc,amount_client_fee:fee,amount_vat:vat,amount_annex:body.annex||0,amount_total:svc+fee+vat+(body.annex||0),amount_commission:comm,amount_payout:svc-comm,status:'en_attente',created_at:new Date().toISOString(),tip:0,gift_used:0,
      beneficiary_name:body.beneficiary&&body.beneficiary.name,beneficiary_relation:body.beneficiary&&body.beneficiary.relation,beneficiary_phone:body.beneficiary&&body.beneficiary.phone,beneficiary_needs:body.beneficiary&&body.beneficiary.needs,beneficiary_info:body.beneficiary&&body.beneficiary.info};
    db.bookings.push(b);window.__lastBody=body;r={booking:b}}
  else if(fn==='booking-action'){const b=db.bookings.find(x=>x.id===body.booking_id);if(!b)return ok({error:'Réservation introuvable'});
    if(body.action==='accept'){if(b.companion_id!==me||b.status!=='en_attente')return ok({error:'Demande déjà traitée'});b.status='acceptee';b.mission_signed_companion=new Date().toISOString()}
    else if(body.action==='refuse'){b.status='refusee'}else if(body.action==='sign'){b.mission_signed_client=new Date().toISOString()}r={ok:true}}
  else if(fn==='refund-booking'){const b=db.bookings.find(x=>x.id===body.booking_id);b.status='annulee';r={ok:true}}
  subs.forEach(f=>f());return ok(r)}
window.supabase={createClient(){return{
  auth:{getSession:()=>ok({session}),getUser:()=>ok({user:session&&session.user}),
    signInWithPassword:({email,password})=>{const u=db.users.find(x=>x.email===email&&x.pw===password);if(!u)return ko('Invalid login credentials');if(!u.confirmed)return ko('Email not confirmed');session={user:{id:u.id,email,email_confirmed_at:'2026-01-01'}};return ok({session})},
    signUp:({email,password,options})=>{if(db.users.some(u=>u.email===email))return ko('User already registered');const id='u'+Date.now();db.users.push({id,email,pw:password,confirmed:false});const m=options.data;
      if(new Date(m.birth_date)>new Date(Date.now()-18*365.25*864e5))return ko('Database error saving new user');
      db.profiles.push({id,role:m.role==='admin'?'client':m.role,first_name:m.first_name,last_name:m.last_name,city:m.city,phone:m.phone,identity_verified:false,suspended:false});window.__signup=m;return ok({user:{id}})},
    signOut:()=>{session=null;db.aal='aal1';return ok({})},
    mfa:{getAuthenticatorAssuranceLevel:()=>ok({currentLevel:db.aal}),listFactors:()=>ok({totp:db.factor&&db.factor.verified?[{id:'f1',status:'verified'}]:[],all:[]}),
      enroll:()=>{db.factor={id:'f1',verified:false};return ok({id:'f1',totp:{qr_code:'data:image/svg+xml;utf-8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22/>',secret:'JBSWY3DPEHPK3PXP'}})},
      challengeAndVerify:({code})=>{if(code!=='123456')return ko('Invalid TOTP code');db.factor.verified=true;db.aal='aal2';return ok({})},unenroll:()=>ok({})},resetPasswordForEmail:(email,opts)=>{db.reset={email,opts};return ok({})},onAuthStateChange:(f)=>{db.authCb=f;return {data:{subscription:{unsubscribe(){}}}}},
    signInWithOAuth:(o)=>{db.oauth=o;return ok({url:'https://test.supabase.co/auth/v1/authorize?provider='+o.provider})},
    exchangeCodeForSession:(code)=>{if(code!=='bon-code')return ko('invalid flow state');const u=db.users.find(x=>x.id===db.codeUser);session={user:{id:u.id,email:u.email,email_confirmed_at:'2026-11-26'}};return ok({session})},
    setSession:()=>ok({}),updateUser:(p)=>{db.updated=p;return ok({user:session&&session.user})}},
  from:q,rpc,functions:{invoke},
  storage:{from:()=>({upload:(path)=>{db.uploads.push(path);return ok({path})},createSignedUrls:(paths)=>ok(paths.map(x=>({path:x,signedUrl:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 4 4%22%3E%3Crect width=%224%22 height=%224%22 fill=%22%23D4AF37%22/%3E%3C/svg%3E'})))})},
  channel(){const ch={on(){return ch},subscribe(){subs.push(()=>{});return ch}};return ch},removeChannel(){}}}};
window.SBS_CONFIG={url:'https://test.supabase.co',key:'sb_publishable_test'};
const _f=window.fetch;window.fetch=(u,o)=>String(u).includes('/auth/v1/settings')?Promise.resolve(new Response(JSON.stringify({external:{google:!!db.googleOn,apple:false,email:true}}),{headers:{'Content-Type':'application/json'}})):_f(u,o);
})();
