-- =====================================================================
-- Side by Side — 0012 : villes internationales, fuseaux horaires, langue,
-- préférences d'e-mails, connexion Google / Apple, demandes de sortie ouvertes.
-- Migration non destructive : uniquement des ajouts (colonnes, tables,
-- fonctions) ; aucune donnée existante n'est supprimée.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Normalisation des noms de villes (majuscules, accents, tirets, espaces)
--    « Saint-Étienne », « saint etienne » et « SAINT  ETIENNE » → « saint etienne »
-- ---------------------------------------------------------------------
create or replace function private.norm_city(p text) returns text
language sql immutable parallel safe as $$
  select nullif(trim(regexp_replace(
    translate(lower(coalesce(p, '')),
      'àáâãäåāăąçćčďèéêëēėęěìíîïīįłñńňòóôõöøōőœŕřśšşťùúûüūůűųýÿžźżß''’-_.,',
      'aaaaaaaaacccdeeeeeeeeiiiiiilnnnooooooooorrssstuuuuuuuuyyzzzs      '),
    '\s+', ' ', 'g')), '')
$$;
grant execute on function private.norm_city(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Profils : pays, ville normalisée, langue, préférences d'e-mails, consentements
--    La date de naissance devient facultative à la création du compte (connexion
--    Google / Apple) ; elle reste obligatoire pour réserver ou être réservé
--    (contrôlé par le serveur) et l'âge minimum de 18 ans reste imposé par la base.
-- ---------------------------------------------------------------------
alter table profiles add column if not exists country text not null default 'FR' check (country ~ '^[A-Z]{2}$');
alter table profiles add column if not exists city_key text generated always as (private.norm_city(city)) stored;
alter table profiles add column if not exists lang text not null default 'fr' check (lang in ('fr','en','es','it','de','pt','ar'));
alter table profiles add column if not exists email_prefs jsonb not null default '{"resa": true, "msg": true, "rappel": true, "news": false}';
alter table profiles add column if not exists terms_accepted_at timestamptz;
alter table profiles add column if not exists privacy_accepted_at timestamptz;
alter table profiles add column if not exists charter_accepted_at timestamptz;
alter table profiles add column if not exists avatar_path text check (avatar_path is null or split_part(avatar_path, '/', 1) = id::text);
alter table profiles add column if not exists interests text[] not null default '{}' check (cardinality(interests) <= 20);
alter table profiles add column if not exists activities text[] not null default '{}' check (cardinality(activities) <= 20);
alter table profiles alter column birth_date drop not null;
create index if not exists profiles_city_key_idx on profiles(country, city_key);
grant update (country, lang, email_prefs, avatar_path, interests, activities) on profiles to authenticated;

-- Fuseau horaire de l'accompagnateur : ses disponibilités s'entendent à son heure locale
alter table companions add column if not exists time_zone text not null default 'Europe/Paris'
  check (time_zone ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}$');
grant update (time_zone) on companions to authenticated;

-- ---------------------------------------------------------------------
-- 3. Création de compte : pays, langue, fuseau, consentements ; comptes Google / Apple
-- ---------------------------------------------------------------------
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
        r user_role := case when m->>'role' in ('companion','business') then (m->>'role')::user_role else 'client' end;
        sponsor uuid;
        fn text := coalesce(nullif(trim(m->>'first_name'),''), nullif(trim(m->>'given_name'),''), nullif(split_part(trim(coalesce(m->>'full_name', m->>'name', '')), ' ', 1), ''));
        ln text := coalesce(nullif(trim(m->>'last_name'),''), nullif(trim(m->>'family_name'),''),
                            nullif(trim(substr(trim(coalesce(m->>'full_name', m->>'name', '')), length(split_part(trim(coalesce(m->>'full_name', m->>'name', '')), ' ', 1)) + 1)), ''));
        signed boolean := coalesce((m->>'terms')::boolean, false);
begin
  select id into sponsor from profiles where referral_code = upper(nullif(trim(m->>'referral_code'), '')) and not suspended;
  insert into profiles (id, role, first_name, last_name, phone, city, birth_date, referred_by, country, lang,
                        terms_accepted_at, privacy_accepted_at, charter_accepted_at)
  values (new.id, r,
          left(coalesce(fn, 'Membre'), 40),
          left(coalesce(ln, '-'), 60),
          nullif(trim(m->>'phone'),''),
          left(nullif(trim(m->>'city'),''), 60),
          case when m->>'birth_date' ~ '^\d{4}-\d{2}-\d{2}$' then (m->>'birth_date')::date end,
          sponsor,
          case when upper(m->>'country') ~ '^[A-Z]{2}$' then upper(m->>'country') else 'FR' end,
          case when m->>'lang' in ('fr','en','es','it','de','pt','ar') then m->>'lang' else 'fr' end,
          case when signed then now() end, case when signed then now() end, case when signed then now() end);
  if sponsor is not null and sponsor <> new.id then
    insert into referrals (sponsor_id, referee_id) values (sponsor, new.id) on conflict do nothing;
  end if;
  if r = 'companion' then
    insert into companions (id, hourly_rate, non_circumvention_accepted_at, time_zone)
    values (new.id, 35, case when (m->>'non_circumvention')::boolean then now() end,
            case when m->>'time_zone' ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}$' then m->>'time_zone' else 'Europe/Paris' end);
  end if;
  return new;
end $$;
revoke execute on function private.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Annuaire des accompagnateurs : pays, ville normalisée et fuseau horaire
-- ---------------------------------------------------------------------
drop function if exists public.companions_directory();
create function public.companions_directory()
returns table (id uuid, first_name text, city text, area text, bio text, hourly_rate numeric, tier text,
               languages text[], categories text[], included text[], excluded text[],
               work_days int[], hour_from int, hour_to int, rating numeric, reviews int,
               country text, city_key text, time_zone text, insured boolean)
language sql stable security definer set search_path = public as $$
  select c.id, p.first_name, p.city, c.area, c.bio, c.hourly_rate, c.tier, c.languages, c.categories,
         c.included, c.excluded, c.work_days, c.hour_from, c.hour_to,
         round(avg(r.stars)::numeric, 1), count(r.id)::int, p.country, p.city_key, c.time_zone,
         private.insurance_ok(c.id, now(), now() + interval '1 hour')
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
-- 5. Demandes de sortie ouvertes : le client publie sa sortie (ville, date, heure,
--    durée, activité) ; les accompagnateurs de cette ville — ou de passage — la
--    trouvent et proposent leurs services ; le client réserve ensuite normalement.
-- ---------------------------------------------------------------------
create table if not exists open_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id) on delete cascade,
  city text not null check (char_length(trim(city)) between 1 and 80),
  country text not null default 'FR' check (country ~ '^[A-Z]{2}$'),
  city_key text generated always as (private.norm_city(city)) stored,
  starts_at timestamptz not null,
  hours int not null check (hours between 1 and 8),
  category text not null check (char_length(category) between 2 and 40),
  note text check (note is null or char_length(note) <= 500),
  status text not null default 'ouverte' check (status in ('ouverte','pourvue','annulee','expiree')),
  created_at timestamptz not null default now(),
  check (starts_at >= created_at + interval '24 hours'),
  check (starts_at <= created_at + interval '366 days')
);
create index if not exists open_req_search_idx on open_requests(country, city_key, starts_at) where status = 'ouverte';
create index if not exists open_req_client_idx on open_requests(client_id);

create table if not exists request_offers (
  request_id uuid not null references open_requests(id) on delete cascade,
  companion_id uuid not null references companions(id) on delete cascade,
  message text check (message is null or char_length(message) <= 300),
  status text not null default 'proposee' check (status in ('proposee','retenue','retiree')),
  created_at timestamptz not null default now(),
  primary key (request_id, companion_id)
);
create index if not exists req_offer_comp_idx on request_offers(companion_id);

alter table open_requests enable row level security;
alter table request_offers enable row level security;
revoke all on open_requests, request_offers from anon, authenticated;
grant select on open_requests, request_offers to authenticated;
grant insert (client_id, city, country, starts_at, hours, category, note) on open_requests to authenticated;
grant update (status) on open_requests to authenticated;
grant insert (request_id, companion_id, message) on request_offers to authenticated;
grant update (status) on request_offers to authenticated;

-- Le client voit et annule ses demandes ; l'équipe voit tout
create policy "oreq_own" on open_requests for select to authenticated using (client_id = auth.uid() or private.is_admin());
create policy "oreq_insert" on open_requests for insert to authenticated with check (
  client_id = auth.uid() and exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('client','business')
                                     and p.identity_verified and not p.suspended and p.birth_date is not null));
create policy "oreq_cancel" on open_requests for update to authenticated using (client_id = auth.uid()) with check (status = 'annulee');
-- Propositions : l'accompagnateur voit les siennes, le client celles reçues sur ses demandes
create policy "offer_read" on request_offers for select to authenticated using (
  companion_id = auth.uid() or private.is_admin()
  or exists (select 1 from open_requests o where o.id = request_id and o.client_id = auth.uid()));
create policy "offer_insert" on request_offers for insert to authenticated with check (companion_id = auth.uid());
create policy "offer_withdraw" on request_offers for update to authenticated using (companion_id = auth.uid()) with check (status = 'retiree');

-- Garde-fous : 5 demandes par jour au plus ; une proposition seulement si l'accompagnateur
-- est vérifié, assuré, libre sur toute la durée (aucune réservation qui chevauche) et la demande ouverte
create or replace function private.open_request_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from open_requests where client_id = new.client_id and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Vous avez déjà publié 5 demandes aujourd''hui';
  end if;
  new.city := trim(regexp_replace(new.city, '\s+', ' ', 'g'));
  new.status := 'ouverte';
  return new;
end $$;
drop trigger if exists trg_open_request_guard on open_requests;
create trigger trg_open_request_guard before insert on open_requests for each row execute function private.open_request_guard();

create or replace function private.offer_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare o open_requests; c companions; p profiles;
begin
  select * into o from open_requests where id = new.request_id;
  select * into c from companions where id = new.companion_id;
  select * into p from profiles where id = new.companion_id;
  if o.id is null or o.status <> 'ouverte' or o.starts_at < now() + interval '2 hours' then raise exception 'Cette demande n''est plus disponible'; end if;
  if c.id is null or not c.verified or not c.video_interview_ok or p.suspended then raise exception 'Profil non vérifié : proposition impossible'; end if;
  if o.client_id = new.companion_id then raise exception 'Proposition impossible'; end if;
  if not private.insurance_ok(c.id, o.starts_at, o.starts_at + make_interval(hours => o.hours)) then
    raise exception 'Assurance responsabilité civile absente, expirée ou non validée';
  end if;
  if exists (select 1 from bookings b where b.companion_id = c.id
             and b.status in ('en_attente','acceptee','paiement_confirme','confirmee','controle','verifie','en_cours','fin_declaree','double_attente')
             and tstzrange(b.starts_at, coalesce(b.block_until, b.ends_at), '[)') && tstzrange(o.starts_at, o.starts_at + make_interval(hours => o.hours), '[)')) then
    raise exception 'Vous avez déjà une réservation sur ce créneau';
  end if;
  new.status := 'proposee';
  insert into notifications (user_id, kind, body)
  values (o.client_id, 'reservation', p.first_name || ' propose de vous accompagner pour votre sortie à ' || o.city || '. Consultez sa proposition dans Réservations.');
  return new;
end $$;
drop trigger if exists trg_offer_guard on request_offers;
create trigger trg_offer_guard before insert on request_offers for each row execute function private.offer_guard();

-- Recherche des demandes ouvertes par ville (prénom du client uniquement, jamais ses coordonnées)
create or replace function public.search_open_requests(p_city text default null, p_country text default null)
returns table (id uuid, city text, country text, starts_at timestamptz, hours int, category text, note text,
               client_first_name text, offers int, mine boolean)
language sql stable security definer set search_path = public as $$
  select o.id, o.city, o.country, o.starts_at, o.hours, o.category, o.note, pc.first_name,
         (select count(*)::int from request_offers x where x.request_id = o.id and x.status = 'proposee'),
         exists (select 1 from request_offers x where x.request_id = o.id and x.companion_id = auth.uid() and x.status <> 'retiree')
  from open_requests o join profiles pc on pc.id = o.client_id
  join profiles me on me.id = auth.uid() and me.role = 'companion'
  where o.status = 'ouverte' and o.starts_at > now() + interval '2 hours'
    and o.city_key = coalesce(private.norm_city(p_city), me.city_key)
    and (p_country is null or o.country = upper(p_country))
  order by o.starts_at
  limit 100
$$;
revoke execute on function public.search_open_requests(text, text) from public, anon;
grant execute on function public.search_open_requests(text, text) to authenticated;

-- Le client voit qui lui a proposé ses services (prénom, note, tarif)
create or replace function public.my_request_offers()
returns table (request_id uuid, companion_id uuid, first_name text, hourly_rate numeric, rating numeric, message text, status text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select x.request_id, x.companion_id, p.first_name, c.hourly_rate,
         (select round(avg(r.stars)::numeric, 1) from reviews r where r.target_id = c.id and r.status = 'publie'), x.message, x.status, x.created_at
  from request_offers x join open_requests o on o.id = x.request_id and o.client_id = auth.uid()
  join companions c on c.id = x.companion_id join profiles p on p.id = c.id
  where x.status <> 'retiree'
  order by x.created_at
$$;
revoke execute on function public.my_request_offers() from public, anon;
grant execute on function public.my_request_offers() to authenticated;
