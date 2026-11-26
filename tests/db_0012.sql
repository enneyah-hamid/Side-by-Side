\set QUIET on
create or replace function pg_temp.ok(id text, label text, cond boolean, detail text default '') returns void language plpgsql as $$
begin raise notice '%', (case when cond then '✅ ' else '❌ ' end) || id || ' ' || label || (case when coalesce(detail,'') <> '' then ' — ' || detail else '' end); end $$;
create or replace function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', uid, false); perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal1')::text, false); end $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;
select pg_temp.ok('V01','Villes normalisées (accents, majuscules, tirets, espaces)', private.norm_city('  Saint-Étienne ')=private.norm_city('SAINT  ETIENNE') and private.norm_city('Rouen')='rouen' and private.norm_city('New York')='new york', private.norm_city('  Saint-Étienne '));
insert into auth.users(id,raw_user_meta_data) values
 ('00000000-0000-0000-0000-0000000000a1','{"first_name":"Sophie","last_name":"B","birth_date":"1980-01-01","city":"bordeaux ","country":"fr","lang":"en","terms":true}'),
 ('00000000-0000-0000-0000-0000000000b1','{"first_name":"Camille","last_name":"Durand","birth_date":"1992-03-04","role":"companion","city":"Rouen","time_zone":"Europe/Paris"}'),
 ('00000000-0000-0000-0000-0000000000b2','{"first_name":"Kenji","last_name":"S","birth_date":"1990-03-04","role":"companion","city":"Tokyo","country":"JP","time_zone":"Asia/Tokyo"}'),
 ('00000000-0000-0000-0000-0000000000f1','{"full_name":"Jean Dupont","email":"jean@gmail.com","iss":"https://accounts.google.com"}');
select pg_temp.ok('V02','Inscription : pays, langue, consentements enregistrés', (select country='FR' and lang='en' and terms_accepted_at is not null and city_key='bordeaux' from profiles where id='00000000-0000-0000-0000-0000000000a1'));
select pg_temp.ok('V03','Connexion Google : profil créé sans date de naissance (à compléter)', (select first_name='Jean' and last_name='Dupont' and birth_date is null and role='client' from profiles where id='00000000-0000-0000-0000-0000000000f1'));
select pg_temp.ok('V04','Fuseau horaire de l''accompagnateur enregistré', (select time_zone from companions where id='00000000-0000-0000-0000-0000000000b2')='Asia/Tokyo');
do $$ begin insert into auth.users(id,raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000e1','{"first_name":"Jeune","last_name":"T","birth_date":"2015-01-01"}'); perform pg_temp.ok('V05','Mineur toujours refusé', false);
exception when others then perform pg_temp.ok('V05','Mineur toujours refusé', true); end $$;
update profiles set identity_verified=true where id in ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f1');
update companions set verified=true, video_interview_ok=true;
update settings set insurance_required=false;
-- Demandes ouvertes
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin insert into open_requests(client_id,city,country,starts_at,hours,category) values (auth.uid(),'  Paris ','FR',now()+interval '3 days',2,'musees'); perform pg_temp.ok('V06','Le client publie sa demande de sortie', true);
exception when others then perform pg_temp.ok('V06','Le client publie sa demande de sortie', false, sqlerrm); end $$;
do $$ begin insert into open_requests(client_id,city,country,starts_at,hours,category) values (auth.uid(),'Paris','FR',now()+interval '3 hours',2,'musees'); perform pg_temp.ok('V07','Demande à moins de 24 h refusée', false);
exception when others then perform pg_temp.ok('V07','Demande à moins de 24 h refusée', true); end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ begin insert into open_requests(client_id,city,country,starts_at,hours,category) values (auth.uid(),'Paris','FR',now()+interval '3 days',2,'musees'); perform pg_temp.ok('V08','Profil incomplet (sans date de naissance) : demande refusée', false);
exception when others then perform pg_temp.ok('V08','Profil incomplet (sans date de naissance) : demande refusée', true); end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok('V09','Accompagnateur de Rouen : rien dans sa ville par défaut', (select count(*) from search_open_requests())=0);
select pg_temp.ok('V10','Recherche dans une autre ville (« paris ») : demande trouvée, prénom seul', (select count(*) from search_open_requests('paris','fr'))=1 and (select client_first_name from search_open_requests('PARIS'))='Sophie');
select pg_temp.ok('V11','Le détail des demandes n''est pas lisible directement', (select count(*) from open_requests)=0);
do $$ begin insert into request_offers(request_id,companion_id,message) select id, auth.uid(), 'Ravie de vous faire découvrir le Louvre' from search_open_requests('Paris'); perform pg_temp.ok('V12','Proposition envoyée, client prévenu', (select count(*) from request_offers)=1);
exception when others then perform pg_temp.ok('V12','Proposition envoyée', false, sqlerrm); end $$;
reset role;
select pg_temp.ok('V13','Notification au client', (select count(*) from notifications where user_id='00000000-0000-0000-0000-0000000000a1' and body like '%propose de vous accompagner%')=1);
-- Proposition refusée si l'accompagnateur est déjà réservé
insert into bookings(client_id,companion_id,category,starts_at,hours,place,amount_service,amount_client_fee,amount_vat,amount_total,amount_commission,amount_payout,status)
 select '00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2','musees',starts_at+interval '1 hour',2,'Paris',70,10.5,2.1,82.6,14,56,'confirmee' from open_requests limit 1;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
do $$ begin insert into request_offers(request_id,companion_id) select id, auth.uid() from search_open_requests('Paris'); perform pg_temp.ok('V14','Accompagnateur déjà réservé sur le créneau : proposition refusée', false);
exception when others then perform pg_temp.ok('V14','Accompagnateur déjà réservé sur le créneau : proposition refusée', sqlerrm like '%déjà une réservation%', sqlerrm); end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok('V15','Le client voit la proposition (prénom, tarif)', (select first_name from my_request_offers())='Camille');
do $$ declare n int; begin update open_requests set status='annulee' where client_id=auth.uid(); get diagnostics n=row_count; perform pg_temp.ok('V16','Le client annule sa demande', n=1); end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok('V17','Demande annulée : plus visible', (select count(*) from search_open_requests('Paris'))=0);
do $$ declare n int; begin update profiles set country='JP', lang='ja' where id=auth.uid(); perform pg_temp.ok('V18','Langue non prise en charge refusée', false);
exception when others then perform pg_temp.ok('V18','Langue non prise en charge refusée', true); end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok('V19','Annuaire : pays, ville normalisée et fuseau', (select count(*) from companions_directory() where city_key='tokyo' and country='JP' and time_zone='Asia/Tokyo')=1);
reset role;
