\set ON_ERROR_STOP 0
\pset tuples_only on
-- Données : 1 client, 1 accompagnateur, 1 admin
insert into auth.users(id, raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000a','{"first_name":"Sophie","last_name":"M","birth_date":"1990-01-01","role":"client"}'),
 ('00000000-0000-0000-0000-00000000000b','{"first_name":"Camille","last_name":"D","birth_date":"1992-01-01","role":"companion"}'),
 ('00000000-0000-0000-0000-00000000000c','{"first_name":"Admin","last_name":"Z","birth_date":"1980-01-01","role":"admin"}'),
 ('00000000-0000-0000-0000-00000000000d','{"first_name":"Intrus","last_name":"X","birth_date":"1985-01-01","role":"client"}');
update profiles set role='admin' where id='00000000-0000-0000-0000-00000000000c';
update companions set verified=true, video_interview_ok=true, categories='{shopping}' where id='00000000-0000-0000-0000-00000000000b';
create or replace function t_as(u text, aal text default 'aal1') returns void language sql as $$
  select set_config('request.jwt.claim.sub', u, false), set_config('request.jwt.claims', json_build_object('sub',u,'aal',aal)::text, false) $$;
grant execute on function t_as(text,text) to authenticated;
create or replace function t_ins(st timestamptz, h int, s booking_status default 'en_attente') returns text language plpgsql as $$
begin insert into bookings(client_id, companion_id, category, starts_at, hours, place, amount_service, amount_client_fee, amount_vat, amount_total, amount_commission, amount_payout, status)
 values ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b','shopping', st, h, 'Paris', 70, 10.5, 2.1, 82.6, 14, 56, s); return 'inséré';
exception when others then return 'refusé : ' || sqlerrm; end $$;
select 'T01 admin auto-attribué à l''inscription → rôle client : ' || role from profiles where id='00000000-0000-0000-0000-00000000000d';
select 'T02 1re réservation 10h-12h : ' || t_ins('2030-01-10 10:00+00', 2);
select 'T03 chevauchement 11h-13h même accompagnateur : ' || t_ins('2030-01-10 11:00+00', 2);
select 'T04 créneau collé 12h-13h : ' || t_ins('2030-01-10 12:00+00', 1);
select 'T05 chevauchement sur réservation annulée : ' || (update_res) from (select 1) x, lateral (select (select 'ok')) y(update_res) limit 0;
update bookings set status='annulee' where starts_at='2030-01-10 10:00+00';
select 'T05 nouveau créneau sur une réservation annulée : ' || t_ins('2030-01-10 10:30+00', 1);
select 'T06 annexe négative : ' || (select case when exists(select 1) then '' end) limit 0;
do $$ begin insert into bookings(client_id, companion_id, category, starts_at, hours, place, amount_service, amount_client_fee, amount_vat, amount_annex, amount_total, amount_commission, amount_payout)
 values ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b','shopping','2031-01-01 10:00+00',2,'Paris',70,10.5,2.1,-50,32.6,14,6); raise notice 'T06 annexe négative : ACCEPTÉE (anomalie)';
exception when others then raise notice 'T06 annexe négative : refusée'; end $$;
-- Prolongation : la fin recalculée bloque le créneau suivant
update bookings set extra_minutes=60 where starts_at='2030-01-10 12:00+00';
select 'T07 réservation 13h30 après prolongation jusqu''à 14h : ' || t_ins('2030-01-10 13:30+00', 1);
insert into booking_secrets(booking_id, code, distress, expires_at) select id,'123456','654321', now()+interval '1 day' from bookings where starts_at='2030-01-10 12:00+00';
set role authenticated; select t_as('00000000-0000-0000-0000-00000000000a');
select 'T08 client lit le code de rencontre (table) : ' || coalesce((select code from booking_secrets limit 1),'rien');
do $$ begin perform 1 from booking_secrets; raise notice 'T08b accès table secrets : AUTORISÉ (anomalie)'; exception when others then raise notice 'T08b accès table secrets : refusé (%)', sqlerrm; end $$;
select 'T09 client voit sa commission via my_bookings : ' || coalesce((select booking->>'amount_commission' from my_bookings() limit 1),'masquée');
do $$ begin perform hold_gift(gen_random_uuid(),'X','00000000-0000-0000-0000-00000000000a',10); raise notice 'T10 membre appelle hold_gift : AUTORISÉ (anomalie)'; exception when others then raise notice 'T10 membre appelle hold_gift : refusé'; end $$;
do $$ begin insert into disputes(booking_id, opened_by, reason, description, status, decision) select id, auth.uid(), 'Retard', 'Test', 'resolu', 'remboursé 100 %' from bookings limit 1; raise notice 'T11 litige avec statut choisi : AUTORISÉ (anomalie)'; exception when others then raise notice 'T11 litige avec statut/décision imposés : refusé'; end $$;
do $$ begin insert into disputes(booking_id, opened_by, reason, description) select id, auth.uid(), 'Retard', 'Arrivé 40 min en retard' from bookings limit 1; raise notice 'T12 litige normal : accepté'; exception when others then raise notice 'T12 litige normal : refusé (%)', sqlerrm; end $$;
do $$ begin insert into business_accounts(id, company_name, siret, monthly_limit_eur, non_circumvention_accepted_at, active, stripe_payment_method_id) values (auth.uid(),'ACME','12345678901234',2500,now(),true,'pm_x'); raise notice 'T13 entreprise activée sans carte : AUTORISÉ (anomalie)'; exception when others then raise notice 'T13 entreprise activée sans carte : refusé'; end $$;
do $$ begin insert into business_accounts(id, company_name, siret, monthly_limit_eur, non_circumvention_accepted_at) values (auth.uid(),'ACME','12345678901234',1000000,now()); raise notice 'T14 plafond 1 000 000 € : AUTORISÉ (anomalie)'; exception when others then raise notice 'T14 plafond 1 000 000 € : refusé'; end $$;
do $$ begin update profiles set identity_verified=true where id=auth.uid(); raise notice 'T15 auto-vérification identité : AUTORISÉ (anomalie)'; exception when others then raise notice 'T15 auto-vérification identité : refusée'; end $$;
do $$ begin insert into identity_checks(user_id, doc_path) values (auth.uid(), '00000000-0000-0000-0000-00000000000d/id.jpg'); raise notice 'T16 dépôt pièce d''identité dans le dossier d''un autre : AUTORISÉ (anomalie)'; exception when others then raise notice 'T16 pièce dans le dossier d''un autre : refusée'; end $$;
do $$ begin insert into identity_checks(user_id, doc_path, selfie_path) values (auth.uid(), auth.uid()||'/id.jpg', auth.uid()||'/selfie.jpg'); raise notice 'T17 dépôt pièce d''identité normal : accepté'; exception when others then raise notice 'T17 dépôt normal : refusé (%)', sqlerrm; end $$;
do $$ begin update identity_checks set status='approved'; raise notice 'T18 auto-approbation : % ligne(s)', (select count(*) from identity_checks where status='approved'); exception when others then raise notice 'T18 auto-approbation identité : refusée'; end $$;
-- Admin sans double authentification
select t_as('00000000-0000-0000-0000-00000000000c','aal1');
select 'T19 admin sans MFA voit les profils des autres : ' || count(*) from profiles where id <> '00000000-0000-0000-0000-00000000000c';
select 'T20 admin sans MFA recherche par téléphone : ' || count(*) from admin_find_by_phone('06');
select t_as('00000000-0000-0000-0000-00000000000c','aal2');
select 'T21 admin AVEC MFA voit les profils : ' || count(*) from profiles;
select t_as('00000000-0000-0000-0000-00000000000d');
select 'T22 intrus voit les réservations des autres : ' || count(*) from bookings;
select 'T23 intrus voit les notifications des autres : ' || count(*) from notifications;
do $$ begin insert into notifications(user_id, body) values (auth.uid(),'faux'); raise notice 'T24 fabriquer une notification : AUTORISÉ (anomalie)'; exception when others then raise notice 'T24 fabriquer une notification : refusé'; end $$;
reset role;
