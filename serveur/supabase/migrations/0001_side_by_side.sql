-- =====================================================================
-- Side by Side (groupe Zyntell) — schéma de base de données Supabase
-- À exécuter une seule fois : Supabase > SQL Editor > coller > Run
-- Toutes les tables sont protégées par la sécurité au niveau des lignes (RLS).
-- =====================================================================

create schema if not exists extensions;
create extension if not exists "pgcrypto" with schema extensions;

-- ---------- Types ----------
create type user_role as enum ('client','companion','business','admin');
create type booking_status as enum (
  'en_attente','acceptee','refusee','expiree','paiement_confirme','confirmee','controle',
  'verifie','en_cours','fin_declaree','double_attente','terminee','versement','cloturee',
  'annulee','absence','contestee'
);
create type review_status as enum ('aveugle','moderation','publie','masque');

-- ---------- Réglages (une seule ligne, modifiable par l'admin) ----------
create table settings (
  id int primary key default 1 check (id = 1),
  client_fee_pct numeric not null default 15,      -- frais de service client
  companion_fee_pct numeric not null default 20,   -- commission accompagnateur
  privilege_fee_pct numeric not null default 10,   -- frais client Privilège
  privilege_price_eur numeric not null default 9.90,
  vat_pct numeric not null default 20,
  referral_eur numeric not null default 10,
  min_hours int not null default 1,
  max_hours int not null default 8,
  cancel_early_pct int not null default 100,       -- remboursé si > 48 h
  cancel_mid_pct int not null default 50,          -- 24 à 48 h
  cancel_late_pct int not null default 0,          -- < 24 h
  noshow_pct int not null default 50,
  dispute_days int not null default 3,
  updated_at timestamptz not null default now()
);
insert into settings (id) values (1);

-- ---------- Profils (un par compte Supabase Auth) ----------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'client',
  first_name text not null,
  last_name text not null,
  phone text unique,
  city text,
  birth_date date not null check (birth_date <= current_date - interval '18 years'),
  identity_verified boolean not null default false,
  suspended boolean not null default false,
  privilege_since timestamptz,                     -- abonnement Privilège actif
  referral_code text unique default upper(substr(encode(extensions.gen_random_bytes(6),'hex'),1,8)),
  referred_by uuid references profiles(id),
  trusted_contact text,
  biometric_unlock boolean not null default false,
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

-- ---------- Accompagnateurs ----------
create table companions (
  id uuid primary key references profiles(id) on delete cascade,
  bio text,
  hourly_rate numeric not null check (hourly_rate between 10 and 1000),
  tier text not null default 'Standard' check (tier in ('Standard','Prestige')),
  languages text[] not null default '{}',
  categories text[] not null default '{}',
  included text[] not null default '{}',
  excluded text[] not null default '{}',
  work_days int[] not null default '{0,1,2,3,4,5,6}',
  hour_from int not null default 9,
  hour_to int not null default 20,
  area text,
  verified boolean not null default false,
  video_interview_ok boolean not null default false,
  photo_locked boolean not null default false,
  stripe_account_id text unique,                   -- compte Stripe Connect Express
  payouts_enabled boolean not null default false,
  non_circumvention_accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create table companion_photos (
  id uuid primary key default gen_random_uuid(),
  companion_id uuid not null references companions(id) on delete cascade,
  storage_path text not null,                      -- bucket privé « photos »
  is_reference boolean not null default false,     -- photo de référence : jamais publique
  status text not null default 'pending' check (status in ('draft','pending','ok','refused')),
  ai_suspect boolean not null default false,
  created_at timestamptz not null default now()
);

create table companion_blocked_days (
  companion_id uuid references companions(id) on delete cascade,
  day date not null,
  primary key (companion_id, day)
);

-- ---------- Comptes entreprise (empreinte bancaire obligatoire) ----------
create table business_accounts (
  id uuid primary key references profiles(id) on delete cascade,
  company_name text not null,
  siret text not null check (siret ~ '^[0-9]{14}$'),
  vat_number text,
  monthly_limit_eur numeric not null default 2500,
  stripe_payment_method_id text,                   -- carte enregistrée (SetupIntent)
  card_saved_at timestamptz,
  non_circumvention_accepted_at timestamptz not null,
  active boolean not null default false            -- devient true une fois la carte enregistrée
);

-- ---------- Expériences ----------
create table experiences (
  id uuid primary key default gen_random_uuid(),
  companion_id uuid not null references companions(id) on delete cascade,
  title text not null,
  description text not null,
  category text not null,
  hours int not null check (hours between 1 and 8),
  status text not null default 'pending' check (status in ('pending','ok','refused')),
  created_at timestamptz not null default now()
);

-- ---------- Réservations ----------
create sequence booking_ref_seq start 1100;
create table bookings (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null default 'CMP-' || nextval('booking_ref_seq'),
  client_id uuid not null references profiles(id),
  companion_id uuid not null references companions(id),
  business_id uuid references business_accounts(id),
  experience_id uuid references experiences(id),
  category text not null,
  language text,
  starts_at timestamptz not null,
  hours int not null,
  extra_minutes int not null default 0,
  place text not null,
  note text,
  -- montants calculés côté serveur uniquement
  amount_service numeric not null,      -- prestation (tarif × heures)
  amount_client_fee numeric not null,   -- frais de service client
  amount_vat numeric not null,          -- TVA sur frais
  amount_annex numeric not null default 0,
  amount_total numeric not null,        -- payé par le client
  amount_commission numeric not null,   -- commission retenue à l'accompagnateur
  amount_payout numeric not null,       -- versé à l'accompagnateur
  gift_code text,
  gift_used numeric not null default 0,
  tip numeric not null default 0,
  status booking_status not null default 'en_attente',
  mission_signed_client timestamptz,
  mission_signed_companion timestamptz,
  meeting_code_hash text,
  start_client timestamptz,             -- « Je commence la mission »
  start_companion timestamptz,
  end_client timestamptz,               -- « Je termine la mission »
  end_companion timestamptz,
  review_client_done boolean not null default false,
  review_companion_done boolean not null default false,
  stripe_payment_intent_id text,
  stripe_transfer_id text,
  created_at timestamptz not null default now()
);
create index on bookings (client_id);
create index on bookings (companion_id, starts_at);

-- Historique horodaté (preuve en cas de litige) : on n'efface jamais
create table booking_events (
  id bigserial primary key,
  booking_id uuid not null references bookings(id) on delete cascade,
  status booking_status,
  actor uuid references profiles(id),
  note text,
  created_at timestamptz not null default now()
);

-- Demandes de modification de réservation
create table booking_changes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  new_starts_at timestamptz not null,
  new_hours int not null,
  new_place text not null,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz not null default now()
);

-- ---------- Messages ----------
create table messages (
  id bigserial primary key,
  booking_id uuid not null references bookings(id) on delete cascade,
  sender_id uuid not null references profiles(id),
  body text,
  attachment_path text,
  created_at timestamptz not null default now()
);

-- ---------- Avis (à l'aveugle) ----------
create table reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  author_id uuid not null references profiles(id),
  target_id uuid not null references profiles(id),
  stars int not null check (stars between 1 and 5),
  body text,
  status review_status not null default 'aveugle',
  created_at timestamptz not null default now(),
  unique (booking_id, author_id)
);

-- Publie les deux avis quand les deux ont été donnés
create or replace function reveal_reviews() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from reviews where booking_id = new.booking_id) = 2 then
    update reviews set status = case when coalesce(body,'') = '' then 'publie'::review_status else 'moderation'::review_status end
    where booking_id = new.booking_id and status = 'aveugle';
  end if;
  return new;
end $$;
create trigger trg_reveal_reviews after insert on reviews for each row execute function reveal_reviews();
-- Publication automatique après 14 jours : planifier avec pg_cron (voir README)

-- ---------- Cartes cadeaux, parrainage, abonnements ----------
create table gift_cards (
  code text primary key,
  amount numeric not null,
  balance numeric not null,
  buyer_id uuid references profiles(id),
  recipient_name text,
  recipient_email text,
  message text,
  experience_id uuid references experiences(id),
  is_referral_credit boolean not null default false,
  owner_id uuid references profiles(id),           -- rempli quand la carte est rattachée à un compte
  expires_at timestamptz not null default now() + interval '1 year',
  created_at timestamptz not null default now()
);

create table referrals (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid not null references profiles(id),
  referee_id uuid not null unique references profiles(id),
  first_booking_done_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- Comptabilité ----------
create table ledger (
  id bigserial primary key,
  booking_id uuid references bookings(id),
  kind text not null,          -- Encaissement, Versement, Remboursement, Pourboire, Abonnement Privilège, Carte cadeau…
  amount numeric not null,
  stripe_object_id text,
  created_at timestamptz not null default now()
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  number text unique not null,                     -- F-2026-1100 (client) / FA-2026-1100 (accompagnateur)
  kind text not null check (kind in ('client','companion','business_monthly')),
  booking_id uuid references bookings(id),
  recipient_id uuid not null references profiles(id),
  pdf_path text,
  total numeric not null,
  created_at timestamptz not null default now()
);

-- ---------- Sécurité et litiges ----------
create table disputes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  opened_by uuid not null references profiles(id),
  reason text not null,
  description text not null,
  status text not null default 'ouvert',
  decision text,
  deadline timestamptz not null,
  created_at timestamptz not null default now()
);

create table safety_alerts (
  id bigserial primary key,
  booking_id uuid references bookings(id),
  user_id uuid not null references profiles(id),
  kind text not null,                              -- SOS, code de détresse, point sécurité manqué…
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  actor_id uuid references profiles(id),
  action text not null,
  ref text,
  created_at timestamptz not null default now()
);

-- =====================================================================
-- Sécurité au niveau des lignes (RLS)
-- =====================================================================
create or replace function is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;
-- Fonctions « security definer » : évitent la récursion des règles RLS sur la même table
create or replace function my_role() returns user_role language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;
create or replace function my_companion_verified() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select verified from companions where id = auth.uid()), false)
$$;

alter table settings enable row level security;
alter table profiles enable row level security;
alter table companions enable row level security;
alter table companion_photos enable row level security;
alter table companion_blocked_days enable row level security;
alter table business_accounts enable row level security;
alter table experiences enable row level security;
alter table bookings enable row level security;
alter table booking_events enable row level security;
alter table booking_changes enable row level security;
alter table messages enable row level security;
alter table reviews enable row level security;
alter table gift_cards enable row level security;
alter table referrals enable row level security;
alter table ledger enable row level security;
alter table invoices enable row level security;
alter table disputes enable row level security;
alter table safety_alerts enable row level security;
alter table audit_log enable row level security;

-- Réglages : lecture pour tous les connectés, écriture admin
create policy "settings_read" on settings for select to authenticated using (true);
create policy "settings_admin" on settings for update to authenticated using (is_admin());

-- Profils : chacun voit et modifie le sien ; l'admin voit tout
create policy "profiles_self" on profiles for select to authenticated using (id = auth.uid() or is_admin());
create policy "profiles_self_update" on profiles for update to authenticated using (id = auth.uid())
  with check (id = auth.uid() and role = my_role());
create policy "profiles_insert_self" on profiles for insert to authenticated with check (
  id = auth.uid() and role in ('client','companion','business')
  and identity_verified = false and suspended = false and privilege_since is null and referred_by is null and stripe_customer_id is null);
create policy "profiles_admin" on profiles for all to authenticated using (is_admin());

-- Accompagnateurs : profils vérifiés visibles par tous les connectés
create policy "companions_public" on companions for select to authenticated
  using ((verified and video_interview_ok and not exists (select 1 from profiles p where p.id = companions.id and p.suspended)) or id = auth.uid() or is_admin());
create policy "companions_self" on companions for update to authenticated using (id = auth.uid())
  with check (id = auth.uid() and verified = my_companion_verified());
create policy "companions_insert_self" on companions for insert to authenticated with check (
  id = auth.uid() and verified = false and video_interview_ok = false and photo_locked = false
  and stripe_account_id is null and payouts_enabled = false and tier = 'Standard');
create policy "companions_admin" on companions for all to authenticated using (is_admin());

-- Photos : seules les photos validées, hors photo de référence, sont publiques
create policy "photos_public" on companion_photos for select to authenticated
  using ((status = 'ok' and not is_reference) or companion_id = auth.uid() or is_admin());
create policy "photos_self_insert" on companion_photos for insert to authenticated
  with check (companion_id = auth.uid() and status in ('draft','pending')
              and not (select photo_locked from companions where id = auth.uid()));
create policy "photos_admin" on companion_photos for all to authenticated using (is_admin());

create policy "blocked_read" on companion_blocked_days for select to authenticated using (true);
create policy "blocked_self" on companion_blocked_days for all to authenticated using (companion_id = auth.uid());

create policy "business_self" on business_accounts for select to authenticated using (id = auth.uid() or is_admin());
create policy "business_insert" on business_accounts for insert to authenticated with check (id = auth.uid() and active = false);
create policy "business_admin" on business_accounts for all to authenticated using (is_admin());

create policy "exp_public" on experiences for select to authenticated using (status = 'ok' or companion_id = auth.uid() or is_admin());
create policy "exp_self" on experiences for insert to authenticated with check (companion_id = auth.uid() and status = 'pending');
create policy "exp_admin" on experiences for all to authenticated using (is_admin());

-- Réservations : seules les deux parties et l'admin les voient.
-- Création et changements de statut passent par les fonctions serveur (service_role).
create policy "bookings_parties" on bookings for select to authenticated
  using (client_id = auth.uid() or companion_id = auth.uid() or is_admin());
create policy "events_parties" on booking_events for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and (b.client_id = auth.uid() or b.companion_id = auth.uid())) or is_admin());
create policy "changes_parties" on booking_changes for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and (b.client_id = auth.uid() or b.companion_id = auth.uid())) or is_admin());

create policy "messages_parties" on messages for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and (b.client_id = auth.uid() or b.companion_id = auth.uid())) or is_admin());
create policy "messages_send" on messages for insert to authenticated
  with check (sender_id = auth.uid() and exists (select 1 from bookings b where b.id = booking_id and (b.client_id = auth.uid() or b.companion_id = auth.uid())));

-- Avis : on ne voit jamais un avis « à l'aveugle » qui ne nous appartient pas
create policy "reviews_read" on reviews for select to authenticated
  using (status = 'publie' or author_id = auth.uid() or is_admin());
create policy "reviews_write" on reviews for insert to authenticated
  with check (author_id = auth.uid() and status = 'aveugle' and exists (
    select 1 from bookings b where b.id = booking_id and b.status in ('terminee','versement','cloturee')
      and ((b.client_id = auth.uid() and target_id = b.companion_id) or (b.companion_id = auth.uid() and target_id = b.client_id))));
create policy "reviews_admin" on reviews for update to authenticated using (is_admin());

create policy "gifts_owner" on gift_cards for select to authenticated using (buyer_id = auth.uid() or owner_id = auth.uid() or is_admin());
create policy "referrals_self" on referrals for select to authenticated using (sponsor_id = auth.uid() or referee_id = auth.uid() or is_admin());
create policy "ledger_admin" on ledger for select to authenticated using (is_admin());
create policy "invoices_self" on invoices for select to authenticated using (recipient_id = auth.uid() or is_admin());
create policy "disputes_parties" on disputes for select to authenticated
  using (opened_by = auth.uid() or exists (select 1 from bookings b where b.id = booking_id and (b.client_id = auth.uid() or b.companion_id = auth.uid())) or is_admin());
create policy "disputes_open" on disputes for insert to authenticated with check (opened_by = auth.uid()
  and exists (select 1 from bookings b where b.id = booking_id and (b.client_id = auth.uid() or b.companion_id = auth.uid())));
create policy "alerts_self" on safety_alerts for insert to authenticated with check (user_id = auth.uid()
  and (booking_id is null or exists (select 1 from bookings b where b.id = booking_id and (b.client_id = auth.uid() or b.companion_id = auth.uid()))));
create policy "alerts_admin" on safety_alerts for select to authenticated using (is_admin());
create policy "audit_admin" on audit_log for select to authenticated using (is_admin());

-- Recherche admin par téléphone (renvoie la dernière mission)
create or replace function admin_find_by_phone(q text)
returns table (profile_id uuid, name text, role user_role, phone text, last_booking uuid, last_ref text, last_status booking_status)
language sql stable security definer set search_path = public as $$
  select p.id, p.first_name || ' ' || p.last_name, p.role, p.phone, b.id, b.ref, b.status
  from profiles p
  left join lateral (
    select id, ref, status from bookings
    where client_id = p.id or companion_id = p.id
    order by starts_at desc limit 1) b on true
  where is_admin() and regexp_replace(p.phone, '\D', '', 'g') like '%' || regexp_replace(q, '\D', '', 'g') || '%'
$$;

-- =====================================================================
-- Colonnes protégées : un membre ne peut modifier que ses informations
-- ordinaires. Vérification d'identité, suspension, abonnement, statut des
-- accompagnateurs, comptes Stripe : uniquement par le serveur (service_role).
-- =====================================================================
revoke update on profiles from authenticated, anon;
grant update (first_name, last_name, phone, city, trusted_contact, biometric_unlock) on profiles to authenticated;
revoke update on companions from authenticated, anon;
grant update (bio, hourly_rate, languages, categories, included, excluded, work_days, hour_from, hour_to, area) on companions to authenticated;
revoke all on settings, ledger, audit_log, invoices, gift_cards, referrals, booking_events from anon;
revoke insert, update, delete on bookings, booking_events, booking_changes, ledger, invoices, gift_cards, referrals, audit_log, settings from authenticated;
revoke all on all tables in schema public from anon;

-- Utilisation d'une carte cadeau sans double dépense possible (appelée par le serveur)
create or replace function use_gift(p_code text, p_amount numeric) returns boolean
language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  update gift_cards set balance = balance - p_amount
  where code = p_code and balance >= p_amount and expires_at > now()
  returning true into ok;
  return coalesce(ok, false);
end $$;
revoke execute on function use_gift(text, numeric) from public, anon, authenticated;

-- Stockage : créer deux buckets privés dans Supabase > Storage : « photos » et « documents »
