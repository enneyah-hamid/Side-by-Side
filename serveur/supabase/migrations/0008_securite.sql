-- =====================================================================
-- Side by Side — 0008 : mission de correction technique (sécurité, argent, concurrence)
-- Toutes les règles ci-dessous sont appliquées PAR LA BASE : même un appel
-- malveillant ou deux appels simultanés ne peuvent pas les contourner.
-- =====================================================================
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Double réservation impossible (même accompagnateur, créneaux qui se chevauchent)
-- ---------------------------------------------------------------------
alter table bookings add column if not exists ends_at timestamptz;
create or replace function private.booking_ends() returns trigger
language plpgsql set search_path = public as $$
begin
  new.ends_at := new.starts_at + make_interval(hours => new.hours, mins => coalesce(new.extra_minutes, 0));
  return new;
end $$;
drop trigger if exists trg_booking_ends on bookings;
create trigger trg_booking_ends before insert or update of starts_at, hours, extra_minutes on bookings
  for each row execute function private.booking_ends();
update bookings set ends_at = starts_at + make_interval(hours => hours, mins => coalesce(extra_minutes, 0)) where ends_at is null;
alter table bookings alter column ends_at set not null;
alter table bookings drop constraint if exists bookings_no_overlap;
alter table bookings add constraint bookings_no_overlap exclude using gist
  (companion_id with =, tstzrange(starts_at, ends_at) with &&)
  where (status in ('en_attente','acceptee','paiement_confirme','confirmee','controle','verifie','en_cours','fin_declaree','double_attente'));
alter table bookings add constraint bookings_no_self check (client_id <> companion_id);
alter table bookings add constraint bookings_amounts_ok check (
  amount_service > 0 and amount_client_fee >= 0 and amount_vat >= 0 and amount_annex >= 0 and amount_annex <= 1000
  and amount_commission >= 0 and amount_payout >= 0 and amount_total >= amount_service
  and gift_used >= 0 and gift_used <= amount_total and tip >= 0 and tip <= 500 and hours between 1 and 12);
alter table bookings add column if not exists payment_lock_at timestamptz;
alter table bookings add column if not exists payout_error text;
alter table bookings add column if not exists payout_attempts int not null default 0;
alter table bookings add column if not exists presence_client timestamptz;
alter table bookings add column if not exists presence_companion timestamptz;

-- ---------------------------------------------------------------------
-- 2. Code de rencontre : rangé hors de la table lisible par les membres
--    (avant : l'empreinte du code était lisible par le client via l'API)
-- ---------------------------------------------------------------------
create table if not exists booking_secrets (
  booking_id uuid primary key references bookings(id) on delete cascade,
  code text not null check (code ~ '^[0-9]{6}$'),
  distress text not null check (distress ~ '^[0-9]{6}$' and distress <> code),
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz,
  locked boolean not null default false
);
alter table booking_secrets enable row level security;           -- aucune règle : serveur uniquement
revoke all on booking_secrets from anon, authenticated;

create table if not exists user_secrets (                         -- code de détresse personnel (empreinte)
  user_id uuid primary key references profiles(id) on delete cascade,
  distress_pin_hash text not null,
  updated_at timestamptz not null default now()
);
alter table user_secrets enable row level security;
revoke all on user_secrets from anon, authenticated;

drop function if exists public.my_bookings();
alter table bookings drop column if exists meeting_code_hash;
create or replace function public.my_bookings()
returns table (booking jsonb, client_first_name text, companion_first_name text)
language sql stable security definer set search_path = public as $$
  select to_jsonb(b) - 'stripe_payment_intent_id' - 'stripe_transfer_id' - 'payment_lock_at' - 'payout_error' - 'payout_attempts'
           - (case when b.companion_id = auth.uid() then 'gift_code' else '' end)
           - (case when b.client_id = auth.uid() then 'amount_commission' else '' end)
           - (case when b.client_id = auth.uid() then 'amount_payout' else '' end),
         pc.first_name, pp.first_name
  from bookings b
  join profiles pc on pc.id = b.client_id
  join profiles pp on pp.id = b.companion_id
  where b.client_id = auth.uid() or b.companion_id = auth.uid()
  order by b.starts_at desc
$$;
revoke execute on function public.my_bookings() from public, anon;
grant execute on function public.my_bookings() to authenticated;

-- ---------------------------------------------------------------------
-- 3. Stripe : chaque événement n'est traité qu'une fois, chaque écriture comptable est unique
-- ---------------------------------------------------------------------
create table if not exists stripe_events (
  id text primary key,
  type text not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table stripe_events enable row level security;
revoke all on stripe_events from anon, authenticated;
create unique index if not exists ledger_stripe_unique on ledger(kind, stripe_object_id) where stripe_object_id is not null;

-- ---------------------------------------------------------------------
-- 4. Cartes cadeaux : le solde est réservé au moment du paiement (jamais dépensé deux fois)
-- ---------------------------------------------------------------------
alter table gift_cards add constraint gift_balance_ok check (balance >= 0 and balance <= amount);
create table if not exists gift_holds (
  booking_id uuid primary key references bookings(id) on delete cascade,
  code text not null references gift_cards(code),
  amount numeric not null check (amount > 0),
  status text not null default 'held' check (status in ('held','consumed','released')),
  refunded numeric not null default 0,
  created_at timestamptz not null default now()
);
alter table gift_holds enable row level security;
revoke all on gift_holds from anon, authenticated;

-- Réserve le solde d'une carte pour une réservation (verrou sur la carte : appels simultanés sérialisés)
create or replace function public.hold_gift(p_booking uuid, p_code text, p_user uuid, p_max numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare g gift_cards; h gift_holds; amt numeric;
begin
  select * into h from gift_holds where booking_id = p_booking;
  if found then
    if h.status = 'held' and h.code = upper(p_code) then return h.amount; end if;
    if h.status = 'consumed' then raise exception 'Carte cadeau déjà utilisée pour cette réservation'; end if;
    delete from gift_holds where booking_id = p_booking;           -- ancienne réservation libérée
  end if;
  select * into g from gift_cards where code = upper(p_code) for update;
  if not found or g.expires_at <= now() or g.balance <= 0 or (g.owner_id is not null and g.owner_id <> p_user) then
    raise exception 'Code de carte cadeau invalide';
  end if;
  amt := least(g.balance, p_max);
  update gift_cards set balance = balance - amt, owner_id = coalesce(owner_id, p_user) where code = g.code;
  insert into gift_holds (booking_id, code, amount) values (p_booking, g.code, amt);
  return amt;
end $$;

-- Libère une réservation de solde non encaissée (paiement échoué, annulé, expiré)
create or replace function public.release_gift(p_booking uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare h gift_holds;
begin
  update gift_holds set status = 'released' where booking_id = p_booking and status = 'held' returning * into h;
  if not found then return 0; end if;
  update gift_cards set balance = balance + h.amount where code = h.code;
  return h.amount;
end $$;

-- Passe la réservation de solde en « encaissée » (paiement confirmé)
create or replace function public.consume_gift(p_booking uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare h gift_holds;
begin
  update gift_holds set status = 'consumed' where booking_id = p_booking and status = 'held' returning * into h;
  return coalesce(h.amount, 0);
end $$;

-- Rend tout ou partie du montant encaissé sur la carte (annulation remboursée), une seule fois au maximum
create or replace function public.refund_gift(p_booking uuid, p_pct numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare h gift_holds; back numeric;
begin
  select * into h from gift_holds where booking_id = p_booking and status = 'consumed' for update;
  if not found then return 0; end if;
  back := round(h.amount * greatest(0, least(p_pct, 100)) / 100, 2) - h.refunded;
  if back <= 0 then return 0; end if;
  update gift_holds set refunded = refunded + back where booking_id = p_booking;
  update gift_cards set balance = least(amount, balance + back) where code = h.code;
  return back;
end $$;
revoke execute on function public.hold_gift(uuid, text, uuid, numeric), public.release_gift(uuid),
  public.consume_gift(uuid), public.refund_gift(uuid, numeric), public.use_gift(text, numeric) from public, anon, authenticated;
grant execute on function public.hold_gift(uuid, text, uuid, numeric), public.release_gift(uuid),
  public.consume_gift(uuid), public.refund_gift(uuid, numeric) to service_role;

-- ---------------------------------------------------------------------
-- 5. Limitation des tentatives (codes cadeaux, codes de rencontre, demandes)
-- ---------------------------------------------------------------------
create table if not exists rate_events (
  id bigserial primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  kind text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_events_idx on rate_events(user_id, kind, created_at);
alter table rate_events enable row level security;
revoke all on rate_events from anon, authenticated;
create or replace function public.rate_hit(p_user uuid, p_kind text, p_max int, p_minutes int)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text || p_kind));
  select count(*) into n from rate_events where user_id = p_user and kind = p_kind and created_at > now() - make_interval(mins => p_minutes);
  if n >= p_max then return false; end if;
  insert into rate_events (user_id, kind) values (p_user, p_kind);
  return true;
end $$;
revoke execute on function public.rate_hit(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.rate_hit(uuid, text, int, int) to service_role;

-- ---------------------------------------------------------------------
-- 6. Espace administrateur : rôle admin ET double authentification (aal2) exigés partout
-- ---------------------------------------------------------------------
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin' and not suspended)
     and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
$$;

-- ---------------------------------------------------------------------
-- 7. Colonnes protégées supplémentaires
-- ---------------------------------------------------------------------
-- Litiges : un membre ne choisit ni le statut, ni la décision, ni le délai
alter table disputes alter column deadline set default now() + interval '3 days';
revoke insert, update, delete on disputes from authenticated;
grant insert (booking_id, opened_by, reason, description) on disputes to authenticated;
alter table disputes add constraint disputes_text_ok check (char_length(reason) between 3 and 80 and char_length(description) between 3 and 2000);
-- Comptes entreprise : ni carte, ni activation, ni plafond hors limites choisis par le membre
revoke insert, update, delete on business_accounts from authenticated;
grant insert (id, company_name, siret, vat_number, monthly_limit_eur, non_circumvention_accepted_at) on business_accounts to authenticated;
alter table business_accounts add constraint business_limit_ok check (monthly_limit_eur between 100 and 10000);
-- Profils et accompagnateurs : créés uniquement par l'inscription (déclencheur), jamais à la main
revoke insert on profiles, companions from authenticated;
-- Messages : taille raisonnable, pièces jointes uniquement dans son propre dossier
alter table messages add constraint messages_size_ok check (char_length(coalesce(body, '')) <= 2000);
alter table messages add constraint messages_attach_ok check (attachment_path is null or split_part(attachment_path, '/', 1) = sender_id::text);
revoke update, delete on messages from authenticated;
-- Alertes de sécurité : position plausible
alter table safety_alerts add constraint alerts_geo_ok check (
  (latitude is null or latitude between -90 and 90) and (longitude is null or longitude between -180 and 180));
revoke update, delete on safety_alerts, reviews, companion_photos, experiences from authenticated;

-- ---------------------------------------------------------------------
-- 8. Notifications (dans l'application, en temps réel) et jetons push
-- ---------------------------------------------------------------------
create table if not exists notifications (
  id bigserial primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  kind text not null default 'info',
  body text not null check (char_length(body) <= 400),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications(user_id, created_at desc);
create index if not exists notifications_booking_idx on notifications(booking_id);
alter table notifications enable row level security;
revoke all on notifications from anon, authenticated;
grant select on notifications to authenticated;
grant update (read_at) on notifications to authenticated;
create policy "notif_own_read" on notifications for select to authenticated using (user_id = auth.uid());
create policy "notif_own_mark" on notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists push_tokens (
  user_id uuid not null references profiles(id) on delete cascade,
  token text not null check (char_length(token) between 10 and 512),
  platform text not null check (platform in ('android','ios','web')),
  created_at timestamptz not null default now(),
  primary key (user_id, token)
);
alter table push_tokens enable row level security;
revoke all on push_tokens from anon, authenticated;
grant select, insert, delete on push_tokens to authenticated;
create policy "push_own" on push_tokens for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

do $$ begin
  begin alter publication supabase_realtime add table public.notifications; exception when others then null; end;
end $$;

-- ---------------------------------------------------------------------
-- 9. Vérification d'identité (pièce d'identité + selfie, examinés par l'équipe)
-- ---------------------------------------------------------------------
create table if not exists identity_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  doc_path text not null,
  selfie_path text,
  status text not null default 'pending' check (status in ('pending','approved','refused')),
  reason text,
  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (split_part(doc_path, '/', 1) = user_id::text and (selfie_path is null or split_part(selfie_path, '/', 1) = user_id::text))
);
create unique index if not exists identity_one_pending on identity_checks(user_id) where status = 'pending';
create index if not exists identity_reviewer_idx on identity_checks(reviewed_by);
alter table identity_checks enable row level security;
revoke all on identity_checks from anon, authenticated;
grant select on identity_checks to authenticated;
grant insert (user_id, doc_path, selfie_path) on identity_checks to authenticated;
create policy "idc_own_read" on identity_checks for select to authenticated using (user_id = auth.uid() or private.is_admin());
create policy "idc_own_insert" on identity_checks for insert to authenticated with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 10. Prolongations (payées avant d'être actives)
-- ---------------------------------------------------------------------
create table if not exists booking_extensions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  minutes int not null check (minutes in (30, 60, 120)),
  amount_service numeric not null, amount_client_fee numeric not null, amount_vat numeric not null,
  amount_total numeric not null, amount_commission numeric not null, amount_payout numeric not null,
  status text not null default 'pending' check (status in ('pending','accepted','refused','paid','expired')),
  stripe_payment_intent_id text,
  created_at timestamptz not null default now()
);
create unique index if not exists ext_one_open on booking_extensions(booking_id) where status in ('pending','accepted');
alter table booking_extensions enable row level security;
revoke all on booking_extensions from anon, authenticated;
grant select on booking_extensions to authenticated;
create policy "ext_parties" on booking_extensions for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and (b.client_id = auth.uid() or b.companion_id = auth.uid())) or private.is_admin());

-- ---------------------------------------------------------------------
-- 11. Les règles existantes qui appelaient l'ancien is_admin() continuent de fonctionner
--     (même fonction, désormais avec double authentification obligatoire).
--     Les nouvelles tables sont aussi soumises au journal d'audit côté serveur.
-- ---------------------------------------------------------------------
create index if not exists audit_log_created_idx on audit_log(created_at desc);

-- ---------------------------------------------------------------------
-- 12. Alertes immédiates à l'équipe : SOS / code de détresse et nouvelles pièces d'identité
--     (déclencheurs : l'alerte part même si l'application insère directement la ligne)
-- ---------------------------------------------------------------------
create or replace function private.alert_admins() returns trigger
language plpgsql security definer set search_path = public as $$
declare msg text; ref text;
begin
  if tg_table_name = 'safety_alerts' then
    select b.ref into ref from bookings b where b.id = new.booking_id;
    msg := 'ALERTE ' || upper(new.kind) || coalesce(' sur ' || ref, '') ||
           coalesce(' · position ' || round(new.latitude::numeric, 5) || ', ' || round(new.longitude::numeric, 5), '') || ' : intervenir en priorité.';
    insert into audit_log (actor_id, action, ref) values (new.user_id, 'Alerte de sécurité : ' || new.kind, ref);
  else
    msg := 'Nouvelle pièce d''identité à vérifier.';
  end if;
  insert into notifications (user_id, booking_id, kind, body)
  select p.id, case when tg_table_name = 'safety_alerts' then new.booking_id end,
         case when tg_table_name = 'safety_alerts' then 'sos' else 'admin' end, msg
  from profiles p where p.role = 'admin' and not p.suspended;
  return new;
end $$;
revoke execute on function private.alert_admins() from public, anon, authenticated;
drop trigger if exists trg_alert_sos on safety_alerts;
create trigger trg_alert_sos after insert on safety_alerts for each row execute function private.alert_admins();
drop trigger if exists trg_alert_identity on identity_checks;
create trigger trg_alert_identity after insert on identity_checks for each row execute function private.alert_admins();
