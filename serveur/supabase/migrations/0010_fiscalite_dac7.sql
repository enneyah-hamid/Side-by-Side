-- =====================================================================
-- Side by Side — 0010 : gestion fiscale annuelle (DAC7 / DPI, CGI art. 1649 ter A)
-- Données fiscales réservées aux administrateurs (double authentification) ;
-- chaque accompagnateur ne voit que ses propres revenus et attestations.
-- =====================================================================

-- 1. Informations fiscales individuelles de l'accompagnateur
alter table companions add column if not exists nif text check (nif is null or nif ~ '^[A-Za-z0-9 .-]{5,20}$');   -- numéro d'identification fiscale
alter table companions add column if not exists tax_country text not null default 'FR' check (tax_country ~ '^[A-Z]{2}$');  -- pays de résidence fiscale
alter table companions add column if not exists birth_city text check (char_length(birth_city) <= 100);
alter table companions add column if not exists birth_country text not null default 'FR' check (birth_country ~ '^[A-Z]{2}$');
grant update (nif, tax_country, birth_city, birth_country, tax_id, postal_address) on companions to authenticated;

-- 2. Identification de l'opérateur de plateforme (Zyntell) : renseignée par la direction, jamais fictive
alter table settings add column if not exists operator_siren text check (operator_siren is null or operator_siren ~ '^[0-9]{9}$');
alter table settings add column if not exists operator_legal_name text not null default 'Zyntell SASU';
alter table settings add column if not exists operator_trade_name text not null default 'Side by Side';
alter table settings add column if not exists operator_street text not null default '14 rue de Binche';
alter table settings add column if not exists operator_postcode text not null default '76150';
alter table settings add column if not exists operator_city text not null default 'Maromme';
alter table settings add column if not exists operator_vat text;

-- 3. Revenus déclarables : missions dont le virement à l'accompagnateur est confirmé par Stripe,
--    rattachées au trimestre du versement (heure de Paris)
create or replace function private.tax_lines(p_year int)
returns table (companion_id uuid, booking_id uuid, paid_at timestamptz, gross numeric, fees numeric, annex numeric, tips numeric)
language sql stable security definer set search_path = public as $$
  select b.companion_id, b.id, x.paid_at, b.amount_service, b.amount_commission, b.amount_annex, b.tip
  from bookings b
  cross join lateral (select coalesce((select max(e.created_at) from booking_events e where e.booking_id = b.id and e.status = 'cloturee'), b.ends_at) as paid_at) x
  where b.status = 'cloturee' and b.stripe_transfer_id is not null
    and extract(year from (x.paid_at at time zone 'Europe/Paris')) = p_year
$$;
revoke execute on function private.tax_lines(int) from public, anon, authenticated;

-- Synthèse par accompagnateur et par trimestre (service serveur et administrateurs uniquement)
create or replace function public.tax_year_summary(p_year int)
returns table (companion_id uuid, first_name text, last_name text, birth_date date, postal_address text, nif text, siret text,
               tax_country text, birth_city text, birth_country text, legal_status text,
               n1 int, n2 int, n3 int, n4 int, g1 numeric, g2 numeric, g3 numeric, g4 numeric,
               f1 numeric, f2 numeric, f3 numeric, f4 numeric, t1 numeric, t2 numeric, t3 numeric, t4 numeric, annex numeric)
language sql stable security definer set search_path = public as $$
  with l as (select *, extract(quarter from (paid_at at time zone 'Europe/Paris'))::int q from private.tax_lines(p_year))
  select c.id, p.first_name, p.last_name, p.birth_date, c.postal_address, c.nif, c.tax_id, c.tax_country, c.birth_city, c.birth_country, c.legal_status,
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

-- Mes revenus (accompagnateur) : détail mensuel de l'année, uniquement les miens
create or replace function public.my_tax_year(p_year int)
returns table (month int, quarter int, missions int, gross numeric, fees numeric, tips numeric, annex numeric)
language sql stable security definer set search_path = public as $$
  select extract(month from (paid_at at time zone 'Europe/Paris'))::int, extract(quarter from (paid_at at time zone 'Europe/Paris'))::int,
         count(*)::int, sum(gross), sum(fees), sum(tips), sum(annex)
  from private.tax_lines(p_year) where companion_id = auth.uid()
  group by 1, 2 order by 1
$$;
revoke execute on function public.my_tax_year(int) from public, anon;
grant execute on function public.my_tax_year(int) to authenticated;

-- 4. Déclarations DAC7 (une déclaration initiale active par année, corrections versionnées)
create table if not exists tax_declarations (
  id uuid primary key default gen_random_uuid(),
  year int not null check (year between 2023 and 2100),
  version int not null default 1,
  kind text not null check (kind in ('initiale','corrective','neant')),
  status text not null default 'brouillon' check (status in ('brouillon','validee','transmise','acceptee','rejetee','annulee')),
  message_ref_id text not null unique,
  message_type_indic text not null check (message_type_indic in ('DPI401','DPI402','DPI403')),
  corrects uuid references tax_declarations(id),
  xml_path text,
  xml_sha256 text,
  sellers int not null default 0,
  total_consideration numeric not null default 0,
  total_fees numeric not null default 0,
  created_by uuid references profiles(id),
  validated_by uuid references profiles(id),
  validated_at timestamptz,
  transmitted_at timestamptz,
  receipt_ref text,
  receipt_at timestamptz,
  created_at timestamptz not null default now(),
  unique (year, version)
);
create unique index if not exists tax_decl_one_initial on tax_declarations(year) where kind in ('initiale','neant') and status in ('validee','transmise','acceptee');
create unique index if not exists tax_decl_one_draft on tax_declarations(year) where status = 'brouillon';
create index if not exists tax_decl_corrects_idx on tax_declarations(corrects);
create index if not exists tax_decl_users_idx on tax_declarations(created_by, validated_by);

create table if not exists tax_seller_records (
  declaration_id uuid not null references tax_declarations(id) on delete cascade,
  companion_id uuid not null references companions(id),
  doc_ref_id text not null unique,
  doc_type_indic text not null check (doc_type_indic in ('OECD1','OECD2','OECD3')),
  corr_doc_ref_id text,
  data jsonb not null,
  primary key (declaration_id, companion_id)
);
create index if not exists tax_records_companion_idx on tax_seller_records(companion_id);

-- 5. Attestations annuelles remises aux accompagnateurs (avant le 31 janvier)
create table if not exists tax_certificates (
  id uuid primary key default gen_random_uuid(),
  companion_id uuid not null references companions(id) on delete cascade,
  year int not null,
  version int not null default 1,
  declaration_id uuid references tax_declarations(id),
  data jsonb not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (companion_id, year, version)
);
create index if not exists tax_cert_decl_idx on tax_certificates(declaration_id);

alter table tax_declarations enable row level security;
alter table tax_seller_records enable row level security;
alter table tax_certificates enable row level security;
revoke all on tax_declarations, tax_seller_records, tax_certificates from anon, authenticated;
grant select on tax_declarations, tax_seller_records, tax_certificates to authenticated;
create policy "taxdecl_admin" on tax_declarations for select to authenticated using (private.is_admin());
create policy "taxrec_admin" on tax_seller_records for select to authenticated using (private.is_admin());
create policy "taxcert_own" on tax_certificates for select to authenticated
  using ((companion_id = auth.uid() and published_at is not null) or private.is_admin());

-- 6. Conservation légale : une déclaration transmise ne peut jamais être supprimée ni modifiée sur le fond
create or replace function private.protect_tax_declaration() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' and old.status in ('validee','transmise','acceptee','rejetee') then
    raise exception 'Déclaration fiscale archivée : suppression interdite (conservation légale)';
  end if;
  if tg_op = 'UPDATE' and old.status in ('transmise','acceptee') and
     (new.xml_sha256 is distinct from old.xml_sha256 or new.message_ref_id is distinct from old.message_ref_id or new.year <> old.year) then
    raise exception 'Déclaration transmise : contenu non modifiable, utilisez une déclaration corrective';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists trg_protect_tax_decl on tax_declarations;
create trigger trg_protect_tax_decl before update or delete on tax_declarations for each row execute function private.protect_tax_declaration();
