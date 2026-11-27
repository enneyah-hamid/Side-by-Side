-- =====================================================================
-- Side by Side — 0013 : administration web sécurisée, assistance intégrée, modération des photos
-- Migration NON DESTRUCTIVE : aucune table ni colonne supprimée, aucune donnée effacée.
-- Restauration : serveur/supabase/rollback/0013_down.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Comptes administrateurs : un super-administrateur (dirigeant) et des administrateurs
-- ---------------------------------------------------------------------
create table if not exists admin_accounts (
  user_id uuid primary key references profiles(id),
  level text not null default 'admin' check (level in ('super','admin')),
  must_change_password boolean not null default true,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
-- Un seul super-administrateur actif
create unique index if not exists admin_one_super on admin_accounts ((level)) where level = 'super' and revoked_at is null;
alter table admin_accounts enable row level security;
revoke all on admin_accounts from anon;
revoke insert, update, delete on admin_accounts from authenticated;

-- ---------------------------------------------------------------------
-- 2. Sessions administrateur (déconnexion après 15 min d'inactivité), blocage, journal des connexions
-- ---------------------------------------------------------------------
create table if not exists admin_sessions (
  session_id uuid primary key,                       -- identifiant de session Supabase (jeton)
  user_id uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  stepup_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  ip text,
  user_agent text
);
create index if not exists admin_sessions_user_idx on admin_sessions(user_id, created_at desc);
create table if not exists admin_lockouts (
  email text primary key,
  fails int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists admin_auth_events (
  id bigserial primary key,
  user_id uuid references profiles(id),
  email text,
  event text not null check (event in ('login_ok','login_fail','mfa_ok','mfa_fail','locked','unlocked','logout','timeout',
                                       'stepup_ok','stepup_fail','refused','password_changed','totp_reset','new_device')),
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists admin_auth_events_idx on admin_auth_events(created_at desc);
alter table admin_sessions enable row level security;
alter table admin_lockouts enable row level security;
alter table admin_auth_events enable row level security;
revoke all on admin_sessions, admin_lockouts, admin_auth_events from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Contrôle administrateur renforcé (utilisé par toutes les règles RLS existantes)
--    rôle admin + compte administrateur actif + non suspendu + double authentification (aal2)
--    + session ouverte par l'espace de gestion et active depuis moins de 15 minutes
-- ---------------------------------------------------------------------
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p join admin_accounts a on a.user_id = p.id and a.revoked_at is null
                 where p.id = auth.uid() and p.role = 'admin' and not p.suspended)
     and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     and exists (select 1 from admin_sessions s
                 where s.session_id::text = coalesce(auth.jwt() ->> 'session_id', '')
                   and s.user_id = auth.uid() and s.ended_at is null
                   and s.last_seen_at > now() - interval '15 minutes')
$$;
create or replace function private.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select private.is_admin() and exists (select 1 from admin_accounts where user_id = auth.uid() and level = 'super' and revoked_at is null)
$$;
revoke execute on function private.is_super_admin() from public, anon;
grant execute on function private.is_super_admin() to authenticated;

drop policy if exists "admin_accounts_read" on admin_accounts;
create policy "admin_accounts_read" on admin_accounts for select to authenticated using (private.is_admin());
drop policy if exists "admin_sessions_read" on admin_sessions;
create policy "admin_sessions_read" on admin_sessions for select to authenticated using (private.is_admin());
drop policy if exists "admin_events_read" on admin_auth_events;
create policy "admin_events_read" on admin_auth_events for select to authenticated using (private.is_admin());
grant select on admin_accounts, admin_sessions, admin_auth_events to authenticated;

-- Activation du premier super-administrateur (dirigeant). Exécutée une seule fois, par l'équipe technique,
-- APRÈS que le compte admin@zyntell.fr a été créé dans Supabase. Refuse s'il existe déjà un super-administrateur.
create or replace function private.bootstrap_super_admin(p_email text) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid;
begin
  if exists (select 1 from admin_accounts where level = 'super' and revoked_at is null) then
    raise exception 'Un super-administrateur existe déjà';
  end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'Compte % introuvable : créez-le d''abord dans Supabase (Authentication > Users)', p_email; end if;
  update profiles set role = 'admin', suspended = false where id = uid;
  insert into admin_accounts (user_id, level, must_change_password, created_by) values (uid, 'super', false, uid)
    on conflict (user_id) do update set level = 'super', revoked_at = null;
  insert into audit_log (actor_id, action, ref) values (uid, 'Activation du super-administrateur (dirigeant)', uid::text);
  return uid;
end $$;
revoke execute on function private.bootstrap_super_admin(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Journal inviolable : aucune ligne ne peut être modifiée ni supprimée (même côté serveur)
-- ---------------------------------------------------------------------
alter table audit_log add column if not exists details jsonb;
alter table audit_log add column if not exists ip text;
create or replace function private.append_only() returns trigger language plpgsql as $$
begin
  raise exception 'Journal en ajout seul : modification et suppression interdites (%)', tg_table_name;
end $$;
revoke execute on function private.append_only() from public, anon, authenticated;
drop trigger if exists trg_audit_append_only on audit_log;
create trigger trg_audit_append_only before update or delete on audit_log for each row execute function private.append_only();
drop trigger if exists trg_auth_events_append_only on admin_auth_events;
create trigger trg_auth_events_append_only before update or delete on admin_auth_events for each row execute function private.append_only();

-- ---------------------------------------------------------------------
-- 5. Assistance intégrée : demandes des clients et accompagnateurs, suivies jusqu'à leur résolution
-- ---------------------------------------------------------------------
create sequence if not exists support_ref_seq start 1001;
create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null default 'AS-' || nextval('support_ref_seq'),
  user_id uuid not null references profiles(id),
  category text not null check (category in ('reservation','paiement','compte','securite','accompagnateur','technique','suppression','autre')),
  subject text not null check (char_length(subject) between 3 and 120),
  booking_id uuid references bookings(id),
  status text not null default 'ouverte' check (status in ('ouverte','en_cours','repondue','resolue','fermee')),
  priority text not null default 'normale' check (priority in ('normale','haute')),
  assigned_to uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index if not exists support_tickets_user_idx on support_tickets(user_id, created_at desc);
create index if not exists support_tickets_status_idx on support_tickets(status, last_message_at desc);
create table if not exists support_messages (
  id bigserial primary key,
  ticket_id uuid not null references support_tickets(id),
  author_id uuid references profiles(id),
  from_staff boolean not null default false,
  body text not null check (char_length(body) between 1 and 3000),
  created_at timestamptz not null default now()
);
create index if not exists support_messages_ticket_idx on support_messages(ticket_id, created_at);
alter table support_tickets enable row level security;
alter table support_messages enable row level security;
revoke all on support_tickets, support_messages from anon;
revoke insert, update, delete on support_tickets, support_messages from authenticated;
grant select on support_tickets, support_messages to authenticated;
drop policy if exists "support_own" on support_tickets;
create policy "support_own" on support_tickets for select to authenticated using (user_id = auth.uid() or private.is_admin());
drop policy if exists "support_msg_own" on support_messages;
create policy "support_msg_own" on support_messages for select to authenticated
  using (exists (select 1 from support_tickets t where t.id = ticket_id and t.user_id = auth.uid()) or private.is_admin());

-- Ouvrir une demande (5 par 24 h au plus) ; l'équipe est prévenue immédiatement
create or replace function public.support_open(p_category text, p_subject text, p_body text, p_booking_ref text default null)
returns support_tickets language plpgsql security definer set search_path = public as $$
declare t support_tickets; bid uuid; r user_role;
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  select role into r from profiles where id = auth.uid();
  if r is null or r = 'admin' then raise exception 'Demande impossible depuis ce compte'; end if;
  if char_length(coalesce(trim(p_body), '')) < 10 then raise exception 'Décrivez votre demande (10 caractères minimum)'; end if;
  if not public.rate_hit(auth.uid(), 'support_open', 5, 1440) then raise exception 'Trop de demandes aujourd''hui. Écrivez à contact@zyntell.fr.'; end if;
  if nullif(trim(coalesce(p_booking_ref, '')), '') is not null then
    select id into bid from bookings where ref = upper(trim(p_booking_ref)) and (client_id = auth.uid() or companion_id = auth.uid());
    if bid is null then raise exception 'Référence de réservation introuvable'; end if;
  end if;
  insert into support_tickets (user_id, category, subject, booking_id, priority)
    values (auth.uid(), p_category, trim(p_subject), bid, case when p_category = 'securite' then 'haute' else 'normale' end) returning * into t;
  insert into support_messages (ticket_id, author_id, body) values (t.id, auth.uid(), trim(p_body));
  insert into notifications (user_id, body, booking_id, kind)
    select p.id, 'Nouvelle demande d''assistance ' || t.ref || ' : ' || left(t.subject, 120), bid, 'assistance'
    from profiles p join admin_accounts a on a.user_id = p.id and a.revoked_at is null where p.role = 'admin' and not p.suspended;
  return t;
end $$;
-- Répondre à sa demande (rouvre la demande si elle avait reçu une réponse)
create or replace function public.support_reply(p_ticket uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare t support_tickets;
begin
  select * into t from support_tickets where id = p_ticket and user_id = auth.uid();
  if t.id is null then raise exception 'Demande introuvable'; end if;
  if t.status = 'fermee' then raise exception 'Demande fermée : ouvrez une nouvelle demande'; end if;
  if char_length(coalesce(trim(p_body), '')) < 2 then raise exception 'Message vide'; end if;
  if not public.rate_hit(auth.uid(), 'support_reply', 30, 60) then raise exception 'Trop de messages. Réessayez plus tard.'; end if;
  insert into support_messages (ticket_id, author_id, body) values (t.id, auth.uid(), trim(p_body));
  update support_tickets set status = case when status in ('repondue','resolue') then 'ouverte' else status end,
         updated_at = now(), last_message_at = now() where id = t.id;
  insert into notifications (user_id, body, booking_id, kind)
    select p.id, 'Nouveau message sur la demande ' || t.ref, t.booking_id, 'assistance'
    from profiles p join admin_accounts a on a.user_id = p.id and a.revoked_at is null where p.role = 'admin' and not p.suspended;
end $$;
-- Marquer sa demande comme résolue
create or replace function public.support_resolve(p_ticket uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update support_tickets set status = 'resolue', updated_at = now() where id = p_ticket and user_id = auth.uid() and status <> 'fermee';
  if not found then raise exception 'Demande introuvable'; end if;
end $$;
revoke execute on function public.support_open(text, text, text, text), public.support_reply(uuid, text), public.support_resolve(uuid) from public, anon;
grant execute on function public.support_open(text, text, text, text), public.support_reply(uuid, text), public.support_resolve(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Photos des accompagnateurs : toute nouvelle photo de profil est vérifiée par une personne avant d'être visible
-- ---------------------------------------------------------------------
create or replace function private.avatar_to_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'companion' and new.avatar_path is not null and new.avatar_path is distinct from old.avatar_path
     and exists (select 1 from companions where id = new.id) then
    update companion_photos set status = 'refused' where companion_id = new.id and status = 'pending' and not is_reference;
    insert into companion_photos (companion_id, storage_path, status) values (new.id, new.avatar_path, 'pending');
  end if;
  return new;
end $$;
revoke execute on function private.avatar_to_review() from public, anon, authenticated;
drop trigger if exists trg_avatar_review on profiles;
create trigger trg_avatar_review after update of avatar_path on profiles for each row execute function private.avatar_to_review();

-- Annuaire : ajoute la photo validée la plus récente (jamais la photo de référence)
drop function if exists public.companions_directory();
create function public.companions_directory()
returns table (id uuid, first_name text, city text, area text, bio text, hourly_rate numeric, tier text,
               languages text[], categories text[], included text[], excluded text[],
               work_days int[], hour_from int, hour_to int, rating numeric, reviews int,
               country text, city_key text, time_zone text, insured boolean, photo_path text)
language sql stable security definer set search_path = public as $$
  select c.id, p.first_name, p.city, c.area, c.bio, c.hourly_rate, c.tier, c.languages, c.categories,
         c.included, c.excluded, c.work_days, c.hour_from, c.hour_to,
         round(avg(r.stars)::numeric, 1), count(r.id)::int, p.country, p.city_key, c.time_zone,
         private.insurance_ok(c.id, now(), now() + interval '1 hour'),
         (select ph.storage_path from companion_photos ph where ph.companion_id = c.id and ph.status = 'ok' and not ph.is_reference
           order by ph.created_at desc limit 1)
  from companions c
  join profiles p on p.id = c.id
  left join reviews r on r.target_id = c.id and r.status = 'publie'
  where auth.uid() is not null
    and ((c.verified and c.video_interview_ok and not p.suspended) or c.id = auth.uid())
  group by c.id, p.first_name, p.city, p.country, p.city_key
$$;
revoke execute on function public.companions_directory() from public, anon;
grant execute on function public.companions_directory() to authenticated;

-- ---------------------------------------------------------------------
-- 7. Annonces de l'équipe aux membres (historique)
-- ---------------------------------------------------------------------
create table if not exists announcements (
  id bigserial primary key,
  audience text not null check (audience in ('all','client','companion')),
  body text not null check (char_length(body) between 5 and 400),
  created_by uuid references profiles(id),
  recipients int not null default 0,
  created_at timestamptz not null default now()
);
alter table announcements enable row level security;
revoke all on announcements from anon;
revoke insert, update, delete on announcements from authenticated;
drop policy if exists "announcements_admin" on announcements;
create policy "announcements_admin" on announcements for select to authenticated using (private.is_admin());

-- ---------------------------------------------------------------------
-- 8. Statistiques et listes de l'administration (réservées au serveur, calculées sur les données réelles)
-- ---------------------------------------------------------------------
create or replace function private.admin_finance(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  with done as (
    select * from bookings where status in ('terminee','versement','cloturee') and starts_at >= p_from and starts_at < p_to
  ), held as (
    select * from bookings where status in ('confirmee','controle','verifie','en_cours','fin_declaree','double_attente','a_verifier','incident','contestee')
  ), l as (
    select * from ledger where created_at >= p_from and created_at < p_to
  ), months as (
    select date_trunc('month', g)::date m from generate_series(date_trunc('month', p_to - interval '11 months'), date_trunc('month', p_to - interval '1 second'), interval '1 month') g
  )
  select jsonb_build_object(
    'encaisse', coalesce((select sum(amount) from l where kind like 'Encaissement%'), 0),
    'rembourse', coalesce((select -sum(amount) from l where kind like 'Remboursement%'), 0),
    'verse', coalesce((select sum(amount) from l where kind = 'Versement'), 0),
    'pourboires', coalesce((select sum(amount) from l where kind = 'Pourboire'), 0),
    'prestations_terminees', (select count(*) from done),
    'volume_prestations', coalesce((select sum(amount_service) from done), 0),
    'frais_service_ht', coalesce((select sum(amount_client_fee) from done), 0),
    'tva_collectee', coalesce((select sum(amount_vat) from done), 0),
    'commissions', coalesce((select sum(amount_commission) from done), 0),
    'chiffre_affaires_ht', coalesce((select sum(amount_client_fee + amount_commission) from done), 0),
    'fonds_detenus', coalesce((select sum(amount_total) from held), 0),
    'reservations', (select count(*) from bookings where created_at >= p_from and created_at < p_to),
    'reservations_annulees', (select count(*) from bookings where status = 'annulee' and created_at >= p_from and created_at < p_to),
    'par_mois', coalesce((select jsonb_agg(jsonb_build_object(
        'mois', to_char(m, 'YYYY-MM'),
        'ca_ht', coalesce((select sum(amount_client_fee + amount_commission) from bookings b where b.status in ('terminee','versement','cloturee') and date_trunc('month', b.starts_at) = m), 0),
        'commissions', coalesce((select sum(amount_commission) from bookings b where b.status in ('terminee','versement','cloturee') and date_trunc('month', b.starts_at) = m), 0),
        'encaisse', coalesce((select sum(amount) from ledger x where x.kind like 'Encaissement%' and date_trunc('month', x.created_at) = m), 0),
        'rembourse', coalesce((select -sum(amount) from ledger x where x.kind like 'Remboursement%' and date_trunc('month', x.created_at) = m), 0)
      ) order by m) from months), '[]'::jsonb),
    'par_ville', coalesce((select jsonb_agg(v order by (v->>'reservations')::int desc) from (
        select jsonb_build_object('ville', coalesce(p.city, '—'), 'pays', coalesce(p.country, ''), 'reservations', count(*), 'volume', coalesce(sum(b.amount_total), 0)) v
        from bookings b join profiles p on p.id = b.companion_id
        where b.created_at >= p_from and b.created_at < p_to group by p.city, p.country limit 30) z), '[]'::jsonb)
  )
$$;
revoke execute on function private.admin_finance(timestamptz, timestamptz) from public, anon, authenticated;

create or replace function private.admin_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'clients', (select count(*) from profiles where role in ('client','business')),
    'accompagnateurs', (select count(*) from profiles where role = 'companion'),
    'verifies', (select count(*) from profiles where identity_verified),
    'suspendus', (select count(*) from profiles where suspended),
    'identites_a_verifier', (select count(*) from identity_checks where status = 'pending'),
    'profils_a_valider', (select count(*) from companions where not verified),
    'dossiers_a_verifier', (select count(*) from companions where admin_status = 'en_cours'),
    'photos_a_verifier', (select count(*) from companion_photos where status = 'pending'),
    'litiges_ouverts', (select count(*) from disputes where status = 'ouvert'),
    'missions_a_verifier', (select count(*) from bookings where status in ('a_verifier','incident','contestee')),
    'alertes_7j', (select count(*) from safety_alerts where created_at > now() - interval '7 days'),
    'assistance_ouverte', (select count(*) from support_tickets where status in ('ouverte','en_cours')),
    'avis_a_moderer', (select count(*) from reviews where status = 'moderation')
  )
$$;
revoke execute on function private.admin_counts() from public, anon, authenticated;

create or replace function private.admin_users(p_role text, p_q text, p_status text, p_limit int, p_offset int)
returns table (id uuid, email text, role user_role, first_name text, last_name text, phone text, city text, country text,
               identity_verified boolean, suspended boolean, created_at timestamptz, verified boolean, tier text,
               admin_status text, bookings int, total bigint)
language sql stable security definer set search_path = public, auth as $$
  with f as (
    select p.*, u.email, c.verified, c.tier, c.admin_status
    from profiles p join auth.users u on u.id = p.id left join companions c on c.id = p.id
    where p.role <> 'admin'
      and (p_role is null or p_role = '' or (p_role = 'client' and p.role in ('client','business')) or p.role::text = p_role)
      and (p_status is null or p_status = '' or (p_status = 'suspendu' and p.suspended) or (p_status = 'non_verifie' and not p.identity_verified)
           or (p_status = 'a_valider' and c.id is not null and not c.verified))
      and (p_q is null or p_q = '' or p.first_name ilike '%' || p_q || '%' or p.last_name ilike '%' || p_q || '%' or u.email ilike '%' || p_q || '%'
           or p.city ilike '%' || p_q || '%' or regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') like '%' || nullif(regexp_replace(p_q, '\D', '', 'g'), '') || '%')
  )
  select f.id, f.email, f.role, f.first_name, f.last_name, f.phone, f.city, f.country, f.identity_verified, f.suspended, f.created_at,
         f.verified, f.tier, f.admin_status,
         (select count(*) from bookings b where b.client_id = f.id or b.companion_id = f.id)::int,
         count(*) over ()
  from f order by f.created_at desc limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)
$$;
revoke execute on function private.admin_users(text, text, text, int, int) from public, anon, authenticated;

create or replace function private.admin_list() returns table (user_id uuid, email text, first_name text, last_name text, level text,
  suspended boolean, revoked_at timestamptz, created_at timestamptz, totp boolean, last_login timestamptz, locked_until timestamptz)
language sql stable security definer set search_path = public, auth as $$
  select a.user_id, u.email, p.first_name, p.last_name, a.level, p.suspended, a.revoked_at, a.created_at,
         exists (select 1 from auth.mfa_factors f where f.user_id = a.user_id and f.factor_type = 'totp' and f.status = 'verified'),
         (select max(created_at) from admin_auth_events e where e.user_id = a.user_id and e.event = 'mfa_ok'),
         (select locked_until from admin_lockouts l where l.email = lower(u.email))
  from admin_accounts a join profiles p on p.id = a.user_id join auth.users u on u.id = a.user_id
  order by a.level desc, a.created_at
$$;
revoke execute on function private.admin_list() from public, anon, authenticated;

-- Exposition contrôlée pour les fonctions serveur (clé service uniquement)
create or replace function public.adm_finance(p_from timestamptz, p_to timestamptz) returns jsonb language sql stable security definer set search_path = public as $$ select private.admin_finance(p_from, p_to) $$;
create or replace function public.adm_counts() returns jsonb language sql stable security definer set search_path = public as $$ select private.admin_counts() $$;
create or replace function public.adm_users(p_role text, p_q text, p_status text, p_limit int, p_offset int)
  returns table (id uuid, email text, role user_role, first_name text, last_name text, phone text, city text, country text,
                 identity_verified boolean, suspended boolean, created_at timestamptz, verified boolean, tier text, admin_status text, bookings int, total bigint)
  language sql stable security definer set search_path = public as $$ select * from private.admin_users(p_role, p_q, p_status, p_limit, p_offset) $$;
create or replace function public.adm_admins() returns table (user_id uuid, email text, first_name text, last_name text, level text,
  suspended boolean, revoked_at timestamptz, created_at timestamptz, totp boolean, last_login timestamptz, locked_until timestamptz)
  language sql stable security definer set search_path = public as $$ select * from private.admin_list() $$;
create or replace function public.adm_email(p_user uuid) returns text language sql stable security definer set search_path = public, auth as $$ select email::text from auth.users where id = p_user $$;
create or replace function public.adm_user_by_email(p_email text) returns uuid language sql stable security definer set search_path = public, auth as $$ select id from auth.users where lower(email) = lower(trim(p_email)) $$;
revoke execute on function public.adm_finance(timestamptz, timestamptz), public.adm_counts(), public.adm_users(text, text, text, int, int),
  public.adm_admins(), public.adm_email(uuid), public.adm_user_by_email(text) from public, anon, authenticated;
grant execute on function public.adm_finance(timestamptz, timestamptz), public.adm_counts(), public.adm_users(text, text, text, int, int),
  public.adm_admins(), public.adm_email(uuid), public.adm_user_by_email(text) to service_role;
grant execute on function private.admin_finance(timestamptz, timestamptz), private.admin_counts(), private.admin_users(text, text, text, int, int),
  private.admin_list() to service_role;

-- ---------------------------------------------------------------------
-- 9. Notifications : les administrateurs retirés ne reçoivent plus les alertes de l'équipe
-- ---------------------------------------------------------------------
-- (les déclencheurs existants ciblent profiles.role = 'admin' ; un administrateur retiré repasse en rôle « client »)
