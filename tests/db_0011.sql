-- Tests de la migration 0011 (assurance RC, compléments fiscaux) — base locale, aucune donnée réelle
\set QUIET on
create or replace function pg_temp.ok(id text, label text, cond boolean, detail text default '') returns void language plpgsql as $$
begin raise notice '%', (case when cond then '✅ ' else '❌ ' end) || id || ' ' || label || (case when coalesce(detail,'') <> '' then ' — ' || detail else '' end); end $$;
create or replace function pg_temp.as_user(uid text, aal text default 'aal1') returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', uid, false);
      perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal, 'session_id', '99999999-9999-9999-9999-999999999999')::text, false); end $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id,raw_user_meta_data) values
 ('00000000-0000-0000-0000-0000000000a1','{"first_name":"Sophie","last_name":"B","birth_date":"1980-01-01"}'),
 ('00000000-0000-0000-0000-0000000000b1','{"first_name":"Camille","last_name":"Durand","birth_date":"1992-03-04","role":"companion"}'),
 ('00000000-0000-0000-0000-0000000000b2','{"first_name":"Yanis","last_name":"Martin","birth_date":"1990-06-06","role":"companion"}'),
 ('00000000-0000-0000-0000-0000000000c1','{"first_name":"Admin","last_name":"Z","birth_date":"1980-01-01"}');
update profiles set role='admin' where id='00000000-0000-0000-0000-0000000000c1';
-- Depuis 0013 : un administrateur doit avoir un compte administrateur actif et une session ouverte par l'espace de gestion
do $$ begin if to_regclass('public.admin_accounts') is not null then
  execute $q$insert into admin_accounts(user_id, level) values ('00000000-0000-0000-0000-0000000000c1','admin');
             insert into admin_sessions(session_id, user_id) values ('99999999-9999-9999-9999-999999999999','00000000-0000-0000-0000-0000000000c1')$q$;
end if; end $$;
update companions set verified=true, video_interview_ok=true where id in ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2');

-- ---------- Assurance ----------
do $$ begin
  insert into bookings(client_id,companion_id,category,starts_at,hours,place,amount_service,amount_client_fee,amount_vat,amount_total,amount_commission,amount_payout)
  values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','shopping',now()+interval '10 days',2,'Paris',70,10.5,2.1,82.6,14,56);
  perform pg_temp.ok('I01','Réservation sans assurance refusée', false);
exception when others then perform pg_temp.ok('I01','Réservation sans assurance refusée', sqlstate = 'P0010', sqlerrm); end $$;

set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ begin
  insert into companion_insurances(companion_id,insurer,policy_number,starts_on,ends_on,doc_path,covers_paid_activity,status)
  values (auth.uid(),'MAIF','RC-123456',current_date-30,current_date+20,auth.uid()||'/a.pdf',true,'validee');
  perform pg_temp.ok('I02','Un accompagnateur ne peut pas s''auto-valider', false);
exception when others then perform pg_temp.ok('I02','Un accompagnateur ne peut pas s''auto-valider', true, sqlerrm); end $$;
do $$ begin
  insert into companion_insurances(companion_id,insurer,policy_number,starts_on,ends_on,doc_path,covers_paid_activity)
  values (auth.uid(),'  MAIF ','RC-123456',current_date-30,current_date+20,auth.uid()||'/a.pdf',true);
  perform pg_temp.ok('I03','Dépôt de l''attestation : statut « en attente »', (select status from companion_insurances where companion_id=auth.uid() limit 1)='en_attente'
    and (select insurer from companion_insurances where companion_id=auth.uid() limit 1)='MAIF');
exception when others then perform pg_temp.ok('I03','Dépôt de l''attestation', false, sqlerrm); end $$;
do $$ begin
  insert into companion_insurances(companion_id,insurer,policy_number,starts_on,ends_on,doc_path,covers_paid_activity)
  values ('00000000-0000-0000-0000-0000000000b2','AXA','X-999',current_date,current_date+300,'00000000-0000-0000-0000-0000000000b2/x.pdf',true);
  perform pg_temp.ok('I04','Dépôt au nom d''un autre accompagnateur refusé', false);
exception when others then perform pg_temp.ok('I04','Dépôt au nom d''un autre accompagnateur refusé', true); end $$;
do $$ begin
  insert into companion_insurances(companion_id,insurer,policy_number,starts_on,ends_on,doc_path,covers_paid_activity)
  values (auth.uid(),'AXA','X-999',current_date-400,current_date-2,auth.uid()||'/x.pdf',true);
  perform pg_temp.ok('I05','Attestation déjà expirée refusée', false);
exception when others then perform pg_temp.ok('I05','Attestation déjà expirée refusée', true, sqlerrm); end $$;
do $$ begin
  insert into companion_insurances(companion_id,insurer,policy_number,starts_on,ends_on,doc_path,covers_paid_activity)
  values (auth.uid(),'AXA','X-999',current_date,current_date+300,auth.uid()||'/x.pdf',false);
  perform pg_temp.ok('I06','Garanties non confirmées : dépôt refusé', false);
exception when others then perform pg_temp.ok('I06','Garanties non confirmées : dépôt refusé', true); end $$;
do $$ begin
  insert into companion_insurances(companion_id,insurer,policy_number,starts_on,ends_on,doc_path,covers_paid_activity)
  values (auth.uid(),'AXA','X-999',current_date,current_date+300,'00000000-0000-0000-0000-0000000000b2/x.pdf',true);
  perform pg_temp.ok('I07','Justificatif rangé dans le dossier d''un autre : refusé', false);
exception when others then perform pg_temp.ok('I07','Justificatif rangé dans le dossier d''un autre : refusé', true); end $$;
do $$ declare n int; begin
  update companion_insurances set status='validee' where companion_id=auth.uid(); get diagnostics n = row_count;
  perform pg_temp.ok('I08','L''accompagnateur ne peut pas modifier le statut', n = 0);
exception when others then perform pg_temp.ok('I08','L''accompagnateur ne peut pas modifier le statut', true); end $$;
select pg_temp.ok('I09','Historique : dépôt journalisé', (select count(*) from insurance_reviews r join companion_insurances i on i.id=r.insurance_id where i.companion_id=auth.uid() and r.decision='depot')=1);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok('I10','Un client ne voit aucune attestation', (select count(*) from companion_insurances)=0);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1','aal1');
select pg_temp.ok('I11','Admin sans double authentification : aucun accès', (select count(*) from companion_insurances)=0);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1','aal2');
select pg_temp.ok('I12','Admin avec double authentification : attestations visibles', (select count(*) from companion_insurances)=1);
select pg_temp.ok('I13','L''équipe est prévenue du dépôt', (select count(*) from notifications where user_id=auth.uid() and body like '%assurance%')=1);
reset role;

-- Validation (fonction serveur) → réservation possible ; au-delà de l'expiration → refusée
update companion_insurances set status='validee', reviewed_at=now() where companion_id='00000000-0000-0000-0000-0000000000b1';
do $$ begin
  insert into bookings(id,client_id,companion_id,category,starts_at,hours,place,amount_service,amount_client_fee,amount_vat,amount_total,amount_commission,amount_payout,status)
  values ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','shopping',now()+interval '10 days',2,'Paris',70,10.5,2.1,82.6,14,56,'confirmee');
  perform pg_temp.ok('I14','Assurance validée : réservation acceptée', true);
exception when others then perform pg_temp.ok('I14','Assurance validée : réservation acceptée', false, sqlerrm); end $$;
do $$ begin
  insert into bookings(client_id,companion_id,category,starts_at,hours,place,amount_service,amount_client_fee,amount_vat,amount_total,amount_commission,amount_payout)
  values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','shopping',now()+interval '40 days',2,'Paris',70,10.5,2.1,82.6,14,56);
  perform pg_temp.ok('I15','Prestation après l''expiration du contrat : refusée', false);
exception when others then perform pg_temp.ok('I15','Prestation après l''expiration du contrat : refusée', sqlstate='P0010'); end $$;
select pg_temp.ok('I16','Aucune réservation existante affectée tant que l''assurance couvre', (select count(*) from insurance_affected_bookings())=0);
update companion_insurances set status='expiree' where companion_id='00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok('I17','Assurance expirée : la réservation à venir est signalée', (select count(*) from insurance_affected_bookings() where ref is not null)=1);
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok('I18','Liste des réservations affectées réservée à l''équipe', (select count(*) from insurance_affected_bookings())=0);
select pg_temp.ok('I19','Statut « réservable » consultable sans détail du contrat', companion_insured('00000000-0000-0000-0000-0000000000b1') = false);
reset role;
update settings set insurance_required=false;
select pg_temp.ok('I20','Obligation désactivable par la direction (réglage)', companion_insured('00000000-0000-0000-0000-0000000000b2') = true);
update settings set insurance_required=true;
-- Fichiers : chacun son dossier, l'équipe en lecture
insert into storage.objects(bucket_id,name) values ('insurance','00000000-0000-0000-0000-0000000000b1/a.pdf');
grant usage on schema storage to authenticated; grant select, insert on storage.objects to authenticated;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select pg_temp.ok('I21','Attestation d''un autre accompagnateur illisible', (select count(*) from storage.objects where bucket_id='insurance')=0);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok('I22','Le titulaire lit sa propre attestation', (select count(*) from storage.objects where bucket_id='insurance')=1);
reset role;

-- ---------- Fiscalité : informations selon le statut ----------
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select pg_temp.ok('F11','Statut manquant détecté', exists(select 1 from tax_profile_issues(auth.uid()) where field='statut' and blocking));
update companions set legal_status='particulier', postal_address='3 rue Verte, 76000 Rouen', nif='9234567890123' where id=auth.uid();
select pg_temp.ok('F12','Numéro fiscal incorrect et lieu de naissance manquant détectés',
  exists(select 1 from tax_profile_issues(auth.uid()) where field='NIF' and blocking) and exists(select 1 from tax_profile_issues(auth.uid()) where field='lieu de naissance'),
  (select string_agg(field||':'||message, ' | ') from tax_profile_issues(auth.uid())));
update companions set legal_status='societe', tax_id='73282932000074', business_name=null, vat_number='FR44732829320' where id=auth.uid();
select pg_temp.ok('F13','Société : raison sociale exigée, SIRET valide accepté, naissance non demandée',
  exists(select 1 from tax_profile_issues(auth.uid()) where field='raison sociale') and not exists(select 1 from tax_profile_issues(auth.uid()) where field in ('SIRET','lieu de naissance','NIF')),
  (select string_agg(field, ',') from tax_profile_issues(auth.uid())));
update companions set business_name='Yanis Services SAS', tax_id='73282932000075' where id=auth.uid();
select pg_temp.ok('F14','SIRET à clé invalide signalé (non bloquant)', exists(select 1 from tax_profile_issues(auth.uid()) where field='SIRET' and not blocking));
select pg_temp.ok('F15','Un membre ne voit pas les informations manquantes d''un autre', (select count(*) from tax_profile_issues('00000000-0000-0000-0000-0000000000b1'))=0);
reset role;

-- ---------- Fiscalité : ventilation des montants ----------
update settings set insurance_required=false;
insert into bookings(id,client_id,companion_id,category,starts_at,hours,place,amount_service,amount_client_fee,amount_vat,amount_total,amount_commission,amount_payout,amount_annex,status,stripe_transfer_id,tip) values
 ('30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2','shopping','2025-03-10 10:00+00',2,'Paris',100,15,3,148,20,110,30,'cloturee','tr_a',10),
 ('30000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2','shopping','2025-04-10 10:00+00',2,'Paris',100,15,3,118,20,40,0,'cloturee','tr_b',0),
 ('30000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2','shopping','2025-05-10 10:00+00',2,'Paris',100,15,3,118,20,80,0,'annulee',null,0);
insert into ledger(booking_id,kind,amount,created_at) values ('30000000-0000-0000-0000-000000000002','Remboursement (litige)',-59,'2025-04-12'),('30000000-0000-0000-0000-000000000003','Remboursement',-118,'2025-05-01');
select pg_temp.ok('F16','Litige remboursé à 50 % : contrepartie déclarée = net réellement versé',
  (select gross - fees from private.tax_lines(2025) where booking_id='30000000-0000-0000-0000-000000000002') = 40,
  (select 'brut '||gross||' commission '||fees from private.tax_lines(2025) where booking_id='30000000-0000-0000-0000-000000000002'));
set role service_role; select set_config('request.jwt.claims','{"role":"service_role"}',false);
select pg_temp.ok('F17','Ventilation : payé client, frais client, TVA, commission, net, annexes, remboursements, annulations',
  (select client_paid=276 and client_fees=30 and client_vat=6 and gross=150 and commission=30 and annex=30 and tips=10 and net_paid=160 and declarable=130 and cancelled=1 and refunds=177 and taxes=0
   from tax_breakdown(2025) where companion_id='00000000-0000-0000-0000-0000000000b2'),
  (select row(t.*)::text from tax_breakdown(2025) t where companion_id='00000000-0000-0000-0000-0000000000b2'));
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select pg_temp.ok('F18','L''accompagnateur voit sa ventilation, sans les frais facturés au client', (select declarable from my_tax_breakdown(2025))=130 and (select count(*) from tax_breakdown(2025))=0);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok('F19','Rien pour un autre accompagnateur', (select count(*) from my_tax_breakdown(2025))=0);
reset role;

-- ---------- Déclarations : statuts et accusés ----------
insert into tax_declarations(id,year,kind,status,message_ref_id,message_type_indic) values ('40000000-0000-0000-0000-000000000001',2025,'initiale','transmise','OP_2025_123456789_001','DPI401');
update tax_declarations set status='a_corriger' where year=2025;
select pg_temp.ok('F20','Statut « à corriger » enregistré', (select status from tax_declarations where year=2025)='a_corriger');
insert into tax_receipts(declaration_id,official_status,reference,file_path,file_sha256) values ('40000000-0000-0000-0000-000000000001','accepte_avec_erreurs','CR-2026-1','2025/cr.xml','x');
do $$ begin delete from tax_receipts; perform pg_temp.ok('F21','Accusé de réception archivé : suppression interdite', false);
exception when others then perform pg_temp.ok('F21','Accusé de réception archivé : suppression interdite', true); end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok('F22','Accusés invisibles pour les accompagnateurs', (select count(*) from tax_receipts)=0);
reset role;
