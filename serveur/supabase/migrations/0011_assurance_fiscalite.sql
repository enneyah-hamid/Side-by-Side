-- =====================================================================
-- Side by Side — 0011 : assurance responsabilité civile des accompagnateurs
-- et compléments au module fiscal DAC7 (statut du prestataire, ventilation
-- précise des montants, statuts des déclarations, accusés de réception).
-- Side by Side n'est pas un assureur : la plateforme vérifie l'attestation
-- du contrat personnel souscrit par l'accompagnateur, à ses frais.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Informations fiscales selon le statut (particulier, micro-entrepreneur, société)
-- ---------------------------------------------------------------------
alter table companions add column if not exists business_name text check (business_name is null or char_length(business_name) between 2 and 120);  -- raison sociale (société)
alter table companions add column if not exists vat_number text check (vat_number is null or vat_number ~ '^[A-Z]{2}[0-9A-Z]{2,13}$');           -- n° de TVA intracommunautaire
grant update (business_name, vat_number) on companions to authenticated;

-- Contrôle de clé (algorithme de Luhn) du SIRET
create or replace function private.luhn_ok(p text) returns boolean
language plpgsql immutable as $$
declare s int := 0; d int; i int; n int := length(p);
begin
  if p !~ '^[0-9]+$' then return false; end if;
  for i in 1..n loop
    d := substr(p, n - i + 1, 1)::int;
    if i % 2 = 0 then d := d * 2; if d > 9 then d := d - 9; end if; end if;
    s := s + d;
  end loop;
  return s % 10 = 0;
end $$;

-- Informations manquantes ou incorrectes d'un accompagnateur (mêmes règles que la déclaration DAC7)
create or replace function public.tax_profile_issues(p_companion uuid)
returns table (field text, message text, blocking boolean)
language plpgsql stable security definer set search_path = public as $$
declare c companions; p profiles; nif text; siret text; eu text[] := array['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
begin
  if not (p_companion = auth.uid() or private.is_admin() or current_user = 'service_role' or auth.role() = 'service_role') then return; end if;
  select * into c from companions where id = p_companion;
  if not found then return; end if;
  select * into p from profiles where id = p_companion;
  nif := replace(coalesce(c.nif, ''), ' ', ''); siret := regexp_replace(coalesce(c.tax_id, ''), '\s', '', 'g');
  if c.legal_status is null then
    field := 'statut'; message := 'Statut à indiquer : particulier, micro-entrepreneur ou société'; blocking := true; return next; end if;
  if coalesce(c.postal_address, '') !~ '\d{5}' then
    field := 'adresse'; message := 'Adresse postale manquante ou incomplète (rue, code postal, ville)'; blocking := true; return next; end if;
  if coalesce(c.legal_status, 'particulier') in ('particulier', 'micro') then
    if p.birth_date is null then field := 'naissance'; message := 'Date de naissance manquante'; blocking := true; return next; end if;
    if coalesce(trim(c.birth_city), '') = '' then field := 'lieu de naissance'; message := 'Ville de naissance manquante (exigée par l''administration fiscale)'; blocking := true; return next; end if;
    if nif = '' then field := 'NIF'; message := 'Numéro fiscal manquant (il figure sur votre avis d''impôt)'; blocking := false; return next;
    elsif c.tax_country = 'FR' and nif !~ '^[0-3][0-9]{12}$' then field := 'NIF'; message := 'Numéro fiscal incorrect : 13 chiffres commençant par 0, 1, 2 ou 3'; blocking := true; return next; end if;
  end if;
  if c.legal_status in ('micro', 'societe') then
    if siret !~ '^[0-9]{14}$' then field := 'SIRET'; message := 'Numéro SIRET manquant ou incorrect (14 chiffres)'; blocking := true; return next;
    elsif not private.luhn_ok(siret) then field := 'SIRET'; message := 'Numéro SIRET à vérifier (clé de contrôle invalide)'; blocking := false; return next; end if;
  end if;
  if c.legal_status = 'societe' and coalesce(trim(c.business_name), '') = '' then
    field := 'raison sociale'; message := 'Raison sociale de la société manquante'; blocking := true; return next; end if;
  if c.vat_number is not null and c.vat_number like 'FR%' then
    if c.vat_number !~ '^FR[0-9A-Z]{2}[0-9]{9}$' then field := 'TVA'; message := 'Numéro de TVA intracommunautaire incorrect (FR + 2 caractères + SIREN)'; blocking := true; return next;
    elsif siret ~ '^[0-9]{14}$' and substr(c.vat_number, 5, 9) <> substr(siret, 1, 9) then field := 'TVA'; message := 'Le numéro de TVA ne correspond pas au SIRET'; blocking := false; return next; end if;
  end if;
  if not (c.tax_country = any(eu)) then
    field := 'résidence'; message := 'Résidence fiscale hors Union européenne : situation à vérifier'; blocking := false; return next; end if;
end $$;
revoke execute on function public.tax_profile_issues(uuid) from public, anon;
grant execute on function public.tax_profile_issues(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Montants réels : ventilation précise par réservation
--    Contrepartie déclarable = montant réellement versé pour la prestation
--    (après commission, après remboursement partiel décidé sur un litige) + pourboires.
--    Frais annexes remboursés exclus. Rattachement à la date du versement (heure de Paris).
-- ---------------------------------------------------------------------
drop function if exists private.tax_lines(int);
create function private.tax_lines(p_year int)
returns table (companion_id uuid, booking_id uuid, paid_at timestamptz, gross numeric, fees numeric, annex numeric, tips numeric,
               client_paid numeric, client_fee numeric, client_vat numeric, payout numeric, refunds numeric)
language sql stable security definer set search_path = public as $$
  select b.companion_id, b.id, x.paid_at,
         round(b.amount_service * f.k, 2), round(b.amount_commission * f.k, 2), round(b.amount_annex * f.k, 2), b.tip,
         b.amount_total + b.tip, b.amount_client_fee, b.amount_vat, b.amount_payout + b.tip,
         coalesce((select -sum(l.amount) from ledger l where l.booking_id = b.id and l.kind like 'Remboursement%'), 0)
  from bookings b
  cross join lateral (select coalesce((select max(e.created_at) from booking_events e where e.booking_id = b.id and e.status = 'cloturee'), b.ends_at) as paid_at) x
  cross join lateral (select case when b.amount_service - b.amount_commission + b.amount_annex > 0
                                  then least(1, b.amount_payout / (b.amount_service - b.amount_commission + b.amount_annex)) else 1 end as k) f
  where b.status = 'cloturee' and b.stripe_transfer_id is not null
    and extract(year from (x.paid_at at time zone 'Europe/Paris')) = p_year
$$;
revoke execute on function private.tax_lines(int) from public, anon, authenticated;

-- Synthèse par accompagnateur et par trimestre : ajoute raison sociale et TVA (vendeur « entité »)
drop function if exists public.tax_year_summary(int);
create function public.tax_year_summary(p_year int)
returns table (companion_id uuid, first_name text, last_name text, birth_date date, postal_address text, nif text, siret text,
               tax_country text, birth_city text, birth_country text, legal_status text, business_name text, vat_number text,
               n1 int, n2 int, n3 int, n4 int, g1 numeric, g2 numeric, g3 numeric, g4 numeric,
               f1 numeric, f2 numeric, f3 numeric, f4 numeric, t1 numeric, t2 numeric, t3 numeric, t4 numeric, annex numeric)
language sql stable security definer set search_path = public as $$
  with l as (select *, extract(quarter from (paid_at at time zone 'Europe/Paris'))::int q from private.tax_lines(p_year))
  select c.id, p.first_name, p.last_name, p.birth_date, c.postal_address, c.nif, c.tax_id, c.tax_country, c.birth_city, c.birth_country, c.legal_status,
    c.business_name, c.vat_number,
    count(*) filter (where q = 1)::int, count(*) filter (where q = 2)::int, count(*) filter (where q = 3)::int, count(*) filter (where q = 4)::int,
    coalesce(sum(gross) filter (where q = 1), 0), coalesce(sum(gross) filter (where q = 2), 0), coalesce(sum(gross) filter (where q = 3), 0), coalesce(sum(gross) filter (where q = 4), 0),
    coalesce(sum(fees) filter (where q = 1), 0), coalesce(sum(fees) filter (where q = 2), 0), coalesce(sum(fees) filter (where q = 3), 0), coalesce(sum(fees) filter (where q = 4), 0),
    coalesce(sum(tips) filter (where q = 1), 0), coalesce(sum(tips) filter (where q = 2), 0), coalesce(sum(tips) filter (where q = 3), 0), coalesce(sum(tips) filter (where q = 4), 0),
    coalesce(sum(annex), 0)
  from l join companions c on c.id = l.companion_id join profiles p on p.id = c.id
  where private.is_admin() or current_user = 'service_role' or auth.role() = 'service_role'
  group by c.id, p.first_name, p.last_name, p.birth_date
$$;
revoke execute on function public.tax_year_summary(int) from public, anon;
grant execute on function public.tax_year_summary(int) to authenticated, service_role;

-- Ventilation détaillée de l'année : payé par le client, frais client, commission, net, remboursements, annulations, taxes
create or replace function private.tax_breakdown_rows(p_year int)
returns table (companion_id uuid, name text, missions int, client_paid numeric, client_fees numeric, client_vat numeric, gross numeric,
               commission numeric, annex numeric, tips numeric, net_paid numeric, declarable numeric, cancelled int, refunds numeric, taxes numeric)
language sql stable security definer set search_path = public as $$
  with l as (select * from private.tax_lines(p_year)),
  k as (                                   -- annulations et remboursements comptabilisés dans l'année (heure de Paris)
    select b.companion_id, count(distinct b.id) filter (where b.status = 'annulee')::int as cancelled, -sum(g.amount) as refunds
    from ledger g join bookings b on b.id = g.booking_id
    where g.kind like 'Remboursement%' and extract(year from (g.created_at at time zone 'Europe/Paris')) = p_year
    group by b.companion_id),
  a as (select l.companion_id, count(*)::int missions, sum(client_paid) cp, sum(client_fee) cf, sum(client_vat) cv, sum(gross) g,
               sum(fees) f, sum(l.annex) an, sum(tips) t, sum(payout) np
        from l group by l.companion_id)
  select c.id, coalesce(c.business_name, p.first_name || ' ' || p.last_name), coalesce(a.missions, 0),
         coalesce(a.cp, 0), coalesce(a.cf, 0), coalesce(a.cv, 0), coalesce(a.g, 0), coalesce(a.f, 0), coalesce(a.an, 0), coalesce(a.t, 0),
         coalesce(a.np, 0), coalesce(a.g - a.f + a.t, 0), coalesce(k.cancelled, 0), coalesce(k.refunds, 0), 0::numeric
  from companions c join profiles p on p.id = c.id
  left join a on a.companion_id = c.id left join k on k.companion_id = c.id
  where a.companion_id is not null or k.companion_id is not null
$$;
revoke execute on function private.tax_breakdown_rows(int) from public, anon, authenticated;

create function public.tax_breakdown(p_year int)
returns table (companion_id uuid, name text, missions int, client_paid numeric, client_fees numeric, client_vat numeric, gross numeric,
               commission numeric, annex numeric, tips numeric, net_paid numeric, declarable numeric, cancelled int, refunds numeric, taxes numeric)
language sql stable security definer set search_path = public as $$
  select * from private.tax_breakdown_rows(p_year)
  where private.is_admin() or current_user = 'service_role' or auth.role() = 'service_role'
$$;
revoke execute on function public.tax_breakdown(int) from public, anon;
grant execute on function public.tax_breakdown(int) to authenticated, service_role;

-- L'accompagnateur : sa propre ventilation (sans les frais facturés au client, qui ne le concernent pas)
create or replace function public.my_tax_breakdown(p_year int)
returns table (missions int, gross numeric, commission numeric, annex numeric, tips numeric, net_paid numeric, declarable numeric, cancelled int, taxes numeric)
language sql stable security definer set search_path = public as $$
  select missions, gross, commission, annex, tips, net_paid, declarable, cancelled, taxes
  from private.tax_breakdown_rows(p_year) where companion_id = auth.uid()
$$;
revoke execute on function public.my_tax_breakdown(int) from public, anon;
grant execute on function public.my_tax_breakdown(int) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Déclarations : statut « à corriger » et import des accusés / comptes rendus officiels
-- ---------------------------------------------------------------------
alter table tax_declarations drop constraint if exists tax_declarations_status_check;
alter table tax_declarations add constraint tax_declarations_status_check
  check (status in ('brouillon','validee','transmise','acceptee','rejetee','a_corriger','annulee'));
drop index if exists tax_decl_one_initial;
create unique index tax_decl_one_initial on tax_declarations(year) where kind in ('initiale','neant') and status in ('validee','transmise','acceptee','a_corriger');
-- « Acceptée » uniquement sur la foi d'un document officiel importé
alter table tax_declarations add column if not exists errors jsonb not null default '[]';

create table if not exists tax_receipts (
  id uuid primary key default gen_random_uuid(),
  declaration_id uuid not null references tax_declarations(id),
  official_status text not null check (official_status in ('recu','accepte','accepte_avec_erreurs','rejete')),
  reference text not null check (char_length(reference) between 3 and 120),
  file_path text not null,
  file_sha256 text not null,
  file_name text,
  errors jsonb not null default '[]',
  imported_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists tax_receipts_decl_idx on tax_receipts(declaration_id);
create index if not exists tax_receipts_user_idx on tax_receipts(imported_by);
alter table tax_receipts enable row level security;
revoke all on tax_receipts from anon, authenticated;
grant select on tax_receipts to authenticated;
create policy "taxrcpt_admin" on tax_receipts for select to authenticated using (private.is_admin());
-- Historique fiscal : jamais supprimé
create or replace function private.no_delete() returns trigger language plpgsql as $$
begin raise exception 'Archive conservée pendant la durée légale : suppression interdite'; end $$;
drop trigger if exists trg_receipts_keep on tax_receipts;
create trigger trg_receipts_keep before delete or update on tax_receipts for each row execute function private.no_delete();
-- L'espace fiscal accepte aussi les accusés au format PDF
update storage.buckets set allowed_mime_types = array['application/xml','text/xml','application/pdf'] where id = 'fiscal';

-- ---------------------------------------------------------------------
-- 4. Assurance responsabilité civile individuelle des accompagnateurs
-- ---------------------------------------------------------------------
alter table settings add column if not exists insurance_required boolean not null default true;

create table if not exists companion_insurances (
  id uuid primary key default gen_random_uuid(),
  companion_id uuid not null references companions(id) on delete cascade,
  insurer text not null check (char_length(trim(insurer)) between 2 and 100),
  policy_number text not null check (char_length(trim(policy_number)) between 3 and 50),
  starts_on date not null,
  ends_on date not null,
  doc_path text not null,
  covers_paid_activity boolean not null check (covers_paid_activity),   -- confirmation obligatoire
  status text not null default 'en_attente' check (status in ('en_attente','validee','refusee','expiree')),
  refusal_reason text check (refusal_reason is null or char_length(refusal_reason) <= 500),
  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (ends_on > starts_on),
  check (split_part(doc_path, '/', 1) = companion_id::text)
);
create index if not exists ins_companion_idx on companion_insurances(companion_id, status, ends_on);
create index if not exists ins_reviewer_idx on companion_insurances(reviewed_by);

create table if not exists insurance_reviews (                    -- historique des vérifications
  id bigserial primary key,
  insurance_id uuid not null references companion_insurances(id) on delete cascade,
  actor_id uuid references profiles(id),
  decision text not null check (decision in ('depot','validee','refusee','expiree','consultation')),
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists ins_rev_idx on insurance_reviews(insurance_id);
create index if not exists ins_rev_actor_idx on insurance_reviews(actor_id);

create table if not exists insurance_reminders (                  -- rappels J-30, J-15, J-7, J-1 envoyés une seule fois
  insurance_id uuid not null references companion_insurances(id) on delete cascade,
  days int not null,
  sent_at timestamptz not null default now(),
  primary key (insurance_id, days)
);

alter table companion_insurances enable row level security;
alter table insurance_reviews enable row level security;
alter table insurance_reminders enable row level security;
revoke all on companion_insurances, insurance_reviews, insurance_reminders from anon, authenticated;
grant select on companion_insurances, insurance_reviews to authenticated;
grant insert (companion_id, insurer, policy_number, starts_on, ends_on, doc_path, covers_paid_activity) on companion_insurances to authenticated;
create policy "ins_own_read" on companion_insurances for select to authenticated using (companion_id = auth.uid() or private.is_admin());
create policy "ins_own_insert" on companion_insurances for insert to authenticated
  with check (companion_id = auth.uid() and exists (select 1 from companions where id = auth.uid()));
create policy "ins_rev_read" on insurance_reviews for select to authenticated
  using (private.is_admin() or exists (select 1 from companion_insurances i where i.id = insurance_id and i.companion_id = auth.uid()));

-- Dépôt : toujours « en attente », jamais auto-validé ; dates cohérentes ; l'équipe est prévenue
create or replace function private.insurance_submitted() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' then                     -- dépôt par l'accompagnateur (jamais par le serveur)
    new.status := 'en_attente'; new.reviewed_by := null; new.reviewed_at := null; new.refusal_reason := null;
    if new.ends_on < (now() at time zone 'Europe/Paris')::date then raise exception 'Cette attestation est déjà expirée'; end if;
    if (select count(*) from companion_insurances where companion_id = new.companion_id and created_at > now() - interval '1 day') >= 5 then
      raise exception 'Trop de dépôts aujourd''hui, réessayez demain'; end if;
  end if;
  new.insurer := trim(new.insurer); new.policy_number := trim(new.policy_number);
  return new;
end $$;
drop trigger if exists trg_ins_submit on companion_insurances;
create trigger trg_ins_submit before insert on companion_insurances for each row execute function private.insurance_submitted();

create or replace function private.insurance_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare nm text;
begin
  insert into insurance_reviews (insurance_id, actor_id, decision) values (new.id, new.companion_id, 'depot');
  select first_name || ' ' || last_name into nm from profiles where id = new.companion_id;
  insert into notifications (user_id, kind, body)
  select p.id, 'admin', 'Nouvelle attestation d''assurance à vérifier (' || coalesce(nm, 'accompagnateur') || ').' from profiles p where p.role = 'admin' and not p.suspended;
  return new;
end $$;
drop trigger if exists trg_ins_after on companion_insurances;
create trigger trg_ins_after after insert on companion_insurances for each row execute function private.insurance_after_insert();

-- Assurance valide pour une période (validée, en cours de validité pendant toute la prestation)
create or replace function private.insurance_ok(p_companion uuid, p_from timestamptz, p_to timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select not coalesce((select insurance_required from settings where id = 1), true)
      or exists (select 1 from companion_insurances i where i.companion_id = p_companion and i.status = 'validee'
                 and i.starts_on <= (p_from at time zone 'Europe/Paris')::date and i.ends_on >= (p_to at time zone 'Europe/Paris')::date)
$$;
revoke execute on function private.insurance_ok(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- Réservable aujourd'hui ? (affichage dans l'application ; aucun détail du contrat n'est exposé)
create or replace function public.companion_insured(p_companion uuid, p_at timestamptz default now(), p_hours int default 1) returns boolean
language sql stable security definer set search_path = public as $$
  select private.insurance_ok(p_companion, p_at, p_at + make_interval(hours => greatest(p_hours, 1)))
$$;
revoke execute on function public.companion_insured(uuid, timestamptz, int) from public, anon;
grant execute on function public.companion_insured(uuid, timestamptz, int) to authenticated, service_role;

-- Garde-fou en base : aucune nouvelle réservation sans assurance valide sur toute la durée de la prestation
create or replace function private.booking_requires_insurance() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not private.insurance_ok(new.companion_id, new.starts_at, new.starts_at + make_interval(hours => new.hours, mins => coalesce(new.extra_minutes, 0))) then
    raise exception 'Réservation impossible : assurance responsabilité civile de l''accompagnateur absente, expirée ou non validée'
      using errcode = 'P0010';
  end if;
  return new;
end $$;
revoke execute on function private.booking_requires_insurance() from public, anon, authenticated;
drop trigger if exists trg_booking_insurance on bookings;
create trigger trg_booking_insurance before insert on bookings for each row execute function private.booking_requires_insurance();

-- Réservations existantes susceptibles d'être affectées (prestation à venir non couverte)
create or replace function public.insurance_affected_bookings()
returns table (booking_id uuid, ref text, companion_id uuid, companion_name text, starts_at timestamptz, status booking_status)
language sql stable security definer set search_path = public as $$
  select b.id, b.ref, b.companion_id, p.first_name || ' ' || p.last_name, b.starts_at, b.status
  from bookings b join profiles p on p.id = b.companion_id
  where (private.is_admin() or current_user = 'service_role' or auth.role() = 'service_role')
    and b.status in ('en_attente','acceptee','paiement_confirme','confirmee','controle')
    and b.starts_at > now()
    and not private.insurance_ok(b.companion_id, b.starts_at, b.starts_at + make_interval(hours => b.hours))
  order by b.starts_at
$$;
revoke execute on function public.insurance_affected_bookings() from public, anon;
grant execute on function public.insurance_affected_bookings() to authenticated, service_role;

-- Espace de stockage privé des attestations (PDF, JPG, PNG — 10 Mo) : dépôt et lecture par le titulaire,
-- lecture par les administrateurs (double authentification) ; aucune modification ni suppression par les membres
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('insurance', 'insurance', false, 10485760, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do nothing;
drop policy if exists "ins_files_insert" on storage.objects;
drop policy if exists "ins_files_read" on storage.objects;
create policy "ins_files_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'insurance' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "ins_files_read" on storage.objects for select to authenticated
  using (bucket_id = 'insurance' and ((storage.foldername(name))[1] = auth.uid()::text or private.is_admin()));
