-- =====================================================================
-- Side by Side — 0002 : réserver pour un proche, compte rendu, déclaration annuelle (DAC7)
-- =====================================================================

-- Réservation pour un proche (le client réserve et paie, le proche vit la sortie)
alter table bookings add column if not exists beneficiary_name text;
alter table bookings add column if not exists beneficiary_relation text;
alter table bookings add column if not exists beneficiary_phone text;
alter table bookings add column if not exists beneficiary_needs text[] not null default '{}';
alter table bookings add column if not exists beneficiary_info text check (char_length(beneficiary_info) <= 400);
alter table bookings add column if not exists beneficiary_consent_at timestamptz;

-- Compte rendu de l'accompagnateur à la famille
create table if not exists booking_reports (
  booking_id uuid primary key references bookings(id) on delete cascade,
  companion_id uuid not null references companions(id),
  mood text not null check (mood in ('Très bonne sortie','Bonne sortie','Sortie difficile')),
  body text not null check (char_length(body) between 20 and 800),
  created_at timestamptz not null default now()
);
alter table booking_reports enable row level security;
create policy "reports_parties" on booking_reports for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and (b.client_id = auth.uid() or b.companion_id = auth.uid())) or is_admin());
create policy "reports_write" on booking_reports for insert to authenticated
  with check (companion_id = auth.uid() and exists (select 1 from bookings b where b.id = booking_id and b.companion_id = auth.uid()
    and b.beneficiary_name is not null and b.status in ('terminee','versement','cloturee')));
revoke update, delete on booking_reports from authenticated;
revoke all on booking_reports from anon;

-- Informations fiscales des accompagnateurs (obligatoires pour la déclaration annuelle)
alter table companions add column if not exists tax_id text;              -- SIRET, SIREN ou numéro fiscal
alter table companions add column if not exists postal_address text;
grant update (tax_id, postal_address) on companions to authenticated;

-- Préférence d'affichage « grand confort »
alter table profiles add column if not exists comfort_mode boolean not null default false;
grant update (comfort_mode) on profiles to authenticated;

-- Déclaration annuelle des revenus (art. 242 bis CGI / directive DAC7) : lecture admin uniquement
create or replace view companion_annual_income with (security_invoker = true) as
select c.id as companion_id,
       p.first_name, p.last_name, p.birth_date, c.postal_address, c.tax_id,
       extract(year from b.starts_at)::int as year,
       count(*) as missions,
       sum(b.amount_service) filter (where extract(quarter from b.starts_at) = 1) as gross_q1,
       sum(b.amount_service) filter (where extract(quarter from b.starts_at) = 2) as gross_q2,
       sum(b.amount_service) filter (where extract(quarter from b.starts_at) = 3) as gross_q3,
       sum(b.amount_service) filter (where extract(quarter from b.starts_at) = 4) as gross_q4,
       sum(b.amount_service) as gross_total,
       sum(b.amount_commission) as commissions,
       sum(b.amount_payout) as net_paid,
       (c.tax_id is not null and c.postal_address is not null) as complete
from bookings b
join companions c on c.id = b.companion_id
join profiles p on p.id = c.id
where b.status in ('terminee','versement','cloturee')
group by c.id, p.first_name, p.last_name, p.birth_date, c.postal_address, c.tax_id, extract(year from b.starts_at);
revoke all on companion_annual_income from anon;
