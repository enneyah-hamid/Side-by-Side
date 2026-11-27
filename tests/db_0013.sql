\set QUIET on
-- Tests de la migration 0013 (administration sécurisée, assistance, photos, statistiques) — base PostgreSQL locale
create or replace function pg_temp.ok(id text, label text, cond boolean, detail text default '') returns void language plpgsql as $$
begin raise notice '%', (case when cond then '✅ ' else '❌ ' end) || id || ' ' || label || (case when coalesce(detail,'') <> '' then ' — ' || detail else '' end); end $$;
create or replace function pg_temp.as_user(uid text, aal text default 'aal1', sid text default '') returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', uid, false);
      perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal, 'session_id', sid)::text, false); end $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into auth.users(id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-0000000000a1','sophie@test.fr','{"first_name":"Sophie","last_name":"Martin","birth_date":"1980-01-01","city":"Paris","country":"FR","terms":true}'),
 ('00000000-0000-0000-0000-0000000000a2','paul@test.fr','{"first_name":"Paul","last_name":"Noel","birth_date":"1981-01-01","city":"Lyon","country":"FR","terms":true}'),
 ('00000000-0000-0000-0000-0000000000b1','camille@test.fr','{"first_name":"Camille","last_name":"Durand","birth_date":"1992-03-04","role":"companion","city":"Paris","time_zone":"Europe/Paris"}'),
 ('00000000-0000-0000-0000-0000000000d1','admin@zyntell.fr','{"first_name":"Hamid","last_name":"E","birth_date":"1980-01-01"}'),
 ('00000000-0000-0000-0000-0000000000d2','modo@zyntell.fr','{"first_name":"Modo","last_name":"R","birth_date":"1985-01-01"}');
update profiles set identity_verified = true where id in ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1');
update companions set verified = true, video_interview_ok = true, hourly_rate = 40;
update settings set insurance_required = false;

-- 1. Super-administrateur
do $$ begin perform private.bootstrap_super_admin('inconnu@zyntell.fr'); perform pg_temp.ok('Z01','Activation refusée si le compte n''existe pas', false);
exception when others then perform pg_temp.ok('Z01','Activation refusée si le compte n''existe pas', sqlerrm like '%introuvable%', sqlerrm); end $$;
select private.bootstrap_super_admin('ADMIN@zyntell.fr') = '00000000-0000-0000-0000-0000000000d1' as z02;
select pg_temp.ok('Z02','Activation du super-administrateur admin@zyntell.fr', (select role from profiles where id='00000000-0000-0000-0000-0000000000d1') = 'admin'
  and (select level from admin_accounts where user_id='00000000-0000-0000-0000-0000000000d1') = 'super');
do $$ begin perform private.bootstrap_super_admin('modo@zyntell.fr'); perform pg_temp.ok('Z03','Un seul super-administrateur', false);
exception when others then perform pg_temp.ok('Z03','Un seul super-administrateur', true, sqlerrm); end $$;
do $$ begin insert into admin_accounts(user_id, level) values ('00000000-0000-0000-0000-0000000000d2','super'); perform pg_temp.ok('Z04','Second super-administrateur impossible même côté serveur', false);
exception when unique_violation then perform pg_temp.ok('Z04','Second super-administrateur impossible même côté serveur', true); end $$;
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000d2';
insert into admin_accounts(user_id, level, created_by) values ('00000000-0000-0000-0000-0000000000d2','admin','00000000-0000-0000-0000-0000000000d1');

-- 2. Contrôle administrateur : rôle + compte actif + aal2 + session de moins de 15 minutes
insert into admin_sessions(session_id, user_id, last_seen_at) values
 ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-0000000000d1', now()),
 ('22222222-2222-2222-2222-222222222222','00000000-0000-0000-0000-0000000000d1', now() - interval '16 minutes'),
 ('33333333-3333-3333-3333-333333333333','00000000-0000-0000-0000-0000000000d1', now()),
 ('44444444-4444-4444-4444-444444444444','00000000-0000-0000-0000-0000000000d2', now());
update admin_sessions set ended_at = now(), end_reason = 'logout' where session_id = '33333333-3333-3333-3333-333333333333';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1','aal2','11111111-1111-1111-1111-111111111111');
select pg_temp.ok('Z05','Admin, double authentification, session active : accès accordé', private.is_admin() and private.is_super_admin());
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1','aal1','11111111-1111-1111-1111-111111111111');
select pg_temp.ok('Z06','Sans double authentification (aal1) : refusé', not private.is_admin());
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1','aal2','');
select pg_temp.ok('Z07','Jeton sans session ouverte par l''espace de gestion : refusé', not private.is_admin());
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1','aal2','22222222-2222-2222-2222-222222222222');
select pg_temp.ok('Z08','Inactivité de plus de 15 minutes : refusé', not private.is_admin());
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1','aal2','33333333-3333-3333-3333-333333333333');
select pg_temp.ok('Z09','Session déconnectée : refusé', not private.is_admin());
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1','aal2','44444444-4444-4444-4444-444444444444');
select pg_temp.ok('Z10','Session d''un autre administrateur : refusé', not private.is_admin());
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d2','aal2','44444444-4444-4444-4444-444444444444');
select pg_temp.ok('Z11','Administrateur simple : accès admin mais pas super-administrateur', private.is_admin() and not private.is_super_admin());
select pg_temp.ok('Z12','Lecture de la liste des administrateurs par un admin', (select count(*) from admin_accounts) = 2);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1','aal2','11111111-1111-1111-1111-111111111111');
select pg_temp.ok('Z13','Client : aucun accès aux comptes, sessions et journal de connexion admin',
  (select count(*) from admin_accounts) = 0 and (select count(*) from admin_sessions) = 0 and (select count(*) from admin_auth_events) = 0);
do $$ begin insert into admin_accounts(user_id, level) values (auth.uid(), 'super'); perform pg_temp.ok('Z14','Client : impossible de se déclarer administrateur', false);
exception when others then perform pg_temp.ok('Z14','Client : impossible de se déclarer administrateur', true); end $$;
do $$ begin insert into admin_sessions(session_id, user_id) values (gen_random_uuid(), auth.uid()); perform pg_temp.ok('Z15','Client : impossible de créer une session admin', false);
exception when others then perform pg_temp.ok('Z15','Client : impossible de créer une session admin', true); end $$;
do $$ begin update profiles set role = 'admin' where id = auth.uid(); perform pg_temp.ok('Z16','Client : impossible de changer son rôle', false);
exception when others then perform pg_temp.ok('Z16','Client : impossible de changer son rôle', true); end $$;
do $$ begin perform public.adm_counts(); perform pg_temp.ok('Z17','Client : statistiques admin inaccessibles par l''API', false);
exception when others then perform pg_temp.ok('Z17','Client : statistiques admin inaccessibles par l''API', true); end $$;
do $$ begin perform * from public.adm_users(null,null,null,50,0); perform pg_temp.ok('Z18','Client : liste des membres inaccessible par l''API', false);
exception when others then perform pg_temp.ok('Z18','Client : liste des membres inaccessible par l''API', true); end $$;
do $$ begin perform private.bootstrap_super_admin('sophie@test.fr'); perform pg_temp.ok('Z19','Client : activation super-admin inaccessible', false);
exception when others then perform pg_temp.ok('Z19','Client : activation super-admin inaccessible', true); end $$;
reset role;

-- 3. Journal inviolable
insert into audit_log(actor_id, action, ref) values ('00000000-0000-0000-0000-0000000000d1','Test','x');
do $$ begin update audit_log set action = 'falsifié'; perform pg_temp.ok('Z20','Journal : modification impossible (même côté serveur)', false);
exception when others then perform pg_temp.ok('Z20','Journal : modification impossible (même côté serveur)', true); end $$;
do $$ begin delete from audit_log; perform pg_temp.ok('Z21','Journal : suppression impossible', false);
exception when others then perform pg_temp.ok('Z21','Journal : suppression impossible', true); end $$;
insert into admin_auth_events(email, event) values ('x@y.fr','login_fail');
do $$ begin delete from admin_auth_events; perform pg_temp.ok('Z22','Journal des connexions : suppression impossible', false);
exception when others then perform pg_temp.ok('Z22','Journal des connexions : suppression impossible', true); end $$;

-- 4. Assistance
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare t support_tickets; begin t := public.support_open('paiement','Remboursement non reçu','Bonjour, je n''ai pas reçu mon remboursement.');
  perform pg_temp.ok('Z23','Le client ouvre une demande d''assistance', t.ref like 'AS-%' and t.status = 'ouverte', t.ref);
exception when others then perform pg_temp.ok('Z23','Le client ouvre une demande d''assistance', false, sqlerrm); end $$;
do $$ begin perform public.support_open('autre','Court','trop'); perform pg_temp.ok('Z24','Message trop court refusé', false);
exception when others then perform pg_temp.ok('Z24','Message trop court refusé', true); end $$;
do $$ begin perform public.support_open('autre','Réservation','Réservation inconnue', 'CMP-99999'); perform pg_temp.ok('Z25','Référence d''une réservation qui n''est pas la sienne refusée', false);
exception when others then perform pg_temp.ok('Z25','Référence d''une réservation qui n''est pas la sienne refusée', true); end $$;
do $$ begin insert into support_tickets(user_id, category, subject) values (auth.uid(),'autre','Direct'); perform pg_temp.ok('Z26','Écriture directe dans les tables d''assistance interdite', false);
exception when others then perform pg_temp.ok('Z26','Écriture directe dans les tables d''assistance interdite', true); end $$;
select pg_temp.ok('Z27','Le client voit sa demande et son message', (select count(*) from support_tickets) = 1 and (select count(*) from support_messages) = 1);
reset role;
select pg_temp.ok('Z28','L''équipe (2 administrateurs actifs) est prévenue', (select count(*) from notifications where kind = 'assistance') = 2);
insert into support_messages(ticket_id, author_id, from_staff, body) select id, '00000000-0000-0000-0000-0000000000d1', true, 'Nous vérifions.' from support_tickets;
update support_tickets set status = 'repondue';
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
select pg_temp.ok('Z29','Un autre membre ne voit ni la demande ni les messages', (select count(*) from support_tickets) = 0 and (select count(*) from support_messages) = 0);
do $$ begin perform public.support_reply((select id from support_tickets limit 1), 'intrusion'); perform pg_temp.ok('Z30','Un autre membre ne peut pas répondre', false);
exception when others then perform pg_temp.ok('Z30','Un autre membre ne peut pas répondre', true); end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select public.support_reply((select id from support_tickets limit 1), 'Merci, j''attends.');
select pg_temp.ok('Z31','Réponse du client : la demande repasse « ouverte », 3 messages', (select status from support_tickets limit 1) = 'ouverte' and (select count(*) from support_messages) = 3);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1','aal2','11111111-1111-1111-1111-111111111111');
select pg_temp.ok('Z32','L''administrateur voit toutes les demandes', (select count(*) from support_tickets) = 1);
do $$ declare i int; begin for i in 1..5 loop perform public.support_open('autre','Sujet','Le corps de la demande'); end loop; perform pg_temp.ok('Z33','Demande depuis un compte administrateur refusée', false);
exception when others then perform pg_temp.ok('Z33','Demande depuis un compte administrateur refusée', true); end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare i int; begin for i in 1..5 loop perform public.support_open('autre','Sujet ' || i,'Le corps de la demande'); end loop; perform pg_temp.ok('Z34','6e demande de la journée refusée (5 maximum)', false);
exception when others then perform pg_temp.ok('Z34','6e demande de la journée refusée (5 maximum)', sqlerrm like '%Trop de demandes%', sqlerrm); end $$;
reset role;

-- 5. Photos des accompagnateurs : vérification humaine avant publication
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
update profiles set avatar_path = '00000000-0000-0000-0000-0000000000b1/avatar-1.jpg' where id = auth.uid();
reset role;
select pg_temp.ok('Z35','Nouvelle photo de profil : à vérifier, équipe prévenue', (select status from companion_photos where storage_path like '%avatar-1.jpg') = 'pending'
  and (select count(*) from notifications where kind = 'admin' and body like '%photo%') >= 1);
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok('Z36','Photo non validée : invisible dans l''annuaire', (select photo_path from public.companions_directory() where first_name = 'Camille') is null);
reset role;
update companion_photos set status = 'ok' where storage_path like '%avatar-1.jpg';
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok('Z37','Photo validée : visible dans l''annuaire', (select photo_path from public.companions_directory() where first_name = 'Camille') like '%avatar-1.jpg');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
update profiles set avatar_path = '00000000-0000-0000-0000-0000000000b1/avatar-2.jpg' where id = auth.uid();
reset role;
select pg_temp.ok('Z38','Changement de photo : l''ancienne reste visible jusqu''à validation de la nouvelle',
  (select count(*) from companion_photos where status = 'ok') = 1 and (select count(*) from companion_photos where status = 'pending') = 1);

-- 6. Statistiques financières réelles (règles validées : 15 % frais client + TVA 20 % sur frais, 20 % commission)
insert into bookings(client_id, companion_id, category, starts_at, hours, place, amount_service, amount_client_fee, amount_vat, amount_total, amount_commission, amount_payout, status)
values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','culture', now() - interval '10 days', 2, 'Louvre', 80, 12, 2.4, 94.4, 16, 64, 'cloturee'),
       ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','culture', now() - interval '5 days', 3, 'Orsay', 120, 18, 3.6, 141.6, 24, 96, 'annulee'),
       ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','culture', now() + interval '5 days', 1, 'Opéra', 40, 6, 1.2, 47.2, 8, 32, 'confirmee');
insert into ledger(booking_id, kind, amount) select id, 'Encaissement', amount_total from bookings;
insert into ledger(booking_id, kind, amount) select id, 'Remboursement', -141.6 from bookings where status = 'annulee';
insert into ledger(booking_id, kind, amount) select id, 'Versement', 64 from bookings where status = 'cloturee';
select pg_temp.ok('Z39','Statistiques : encaissé, remboursé, versé', (public.adm_finance(now() - interval '1 year', now() + interval '1 day')->>'encaisse')::numeric = 283.2
  and (public.adm_finance(now() - interval '1 year', now() + interval '1 day')->>'rembourse')::numeric = 141.6
  and (public.adm_finance(now() - interval '1 year', now() + interval '1 day')->>'verse')::numeric = 64);
select pg_temp.ok('Z40','Commissions ZYNTELL et chiffre d''affaires HT (prestations terminées uniquement)',
  (public.adm_finance(now() - interval '1 year', now() + interval '30 days')->>'commissions')::numeric = 16
  and (public.adm_finance(now() - interval '1 year', now() + interval '30 days')->>'chiffre_affaires_ht')::numeric = 28
  and (public.adm_finance(now() - interval '1 year', now() + interval '30 days')->>'tva_collectee')::numeric = 2.4,
  public.adm_finance(now() - interval '1 year', now() + interval '30 days')::text);
select pg_temp.ok('Z41','Fonds détenus (payé, prestation à venir)', (public.adm_finance(now() - interval '1 year', now())->>'fonds_detenus')::numeric = 47.2);
select pg_temp.ok('Z42','Évolution sur 12 mois', jsonb_array_length(public.adm_finance(now() - interval '1 year', now())->'par_mois') = 12);
select pg_temp.ok('Z43','Compteurs réels (clients, accompagnateurs, assistance, photos)', (public.adm_counts()->>'clients')::int = 2 and (public.adm_counts()->>'accompagnateurs')::int = 1
  and (public.adm_counts()->>'assistance_ouverte')::int = 1 and (public.adm_counts()->>'photos_a_verifier')::int = 1, public.adm_counts()::text);
select pg_temp.ok('Z44','Recherche de membres par e-mail, nom ou ville (admins exclus)', (select count(*) from public.adm_users('', 'sophie', '', 50, 0)) = 1
  and (select email from public.adm_users('', 'Durand', '', 50, 0)) = 'camille@test.fr' and (select count(*) from public.adm_users('', 'zyntell', '', 50, 0)) = 0);
select pg_temp.ok('Z45','Liste des administrateurs avec niveau', (select count(*) from public.adm_admins()) = 2 and (select level from public.adm_admins() where email = 'admin@zyntell.fr') = 'super');
-- 7. Données existantes préservées
select pg_temp.ok('Z46','Aucune donnée existante supprimée (profils, accompagnateurs, réservations)', (select count(*) from profiles) = 5 and (select count(*) from companions) = 1 and (select count(*) from bookings) = 3);
