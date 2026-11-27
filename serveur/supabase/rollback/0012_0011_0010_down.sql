-- Side by Side — RESTAURATION : annule les migrations 0012, 0011 et 0010 (dans cet ordre) (retour à l'état précédent du schéma)
-- À n'utiliser qu'en cas de problème, APRÈS sauvegarde des données (voir PROCEDURE-MIGRATIONS.md).
-- Les données ajoutées par cette migration dans ses propres tables sont perdues ; les données antérieures sont conservées.
begin;
drop trigger if exists trg_offer_guard on request_offers;
drop trigger if exists trg_open_request_guard on open_requests;
drop function if exists public.my_request_offers();
drop function if exists public.search_open_requests(text, text);
drop function if exists private.offer_guard();
drop function if exists private.open_request_guard();
drop table if exists request_offers;
drop table if exists open_requests;
drop function if exists public.companions_directory();
create or replace function public.companions_directory()
returns table (id uuid, first_name text, city text, area text, bio text, hourly_rate numeric, tier text,
               languages text[], categories text[], included text[], excluded text[],
               work_days int[], hour_from int, hour_to int, rating numeric, reviews int)
language sql stable security definer set search_path = public as $$
  select c.id, p.first_name, p.city, c.area, c.bio, c.hourly_rate, c.tier, c.languages, c.categories,
         c.included, c.excluded, c.work_days, c.hour_from, c.hour_to,
         round(avg(r.stars)::numeric, 1), count(r.id)::int
  from companions c
  join profiles p on p.id = c.id
  left join reviews r on r.target_id = c.id and r.status = 'publie'
  where auth.uid() is not null
    and ((c.verified and c.video_interview_ok and not p.suspended) or c.id = auth.uid())
  group by c.id, p.first_name, p.city
$$;
revoke execute on function public.companions_directory() from public, anon;
grant execute on function public.companions_directory() to authenticated;

create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
        r user_role := case when m->>'role' in ('companion','business') then (m->>'role')::user_role else 'client' end;
        sponsor uuid;
begin
  select id into sponsor from profiles where referral_code = upper(nullif(trim(m->>'referral_code'), '')) and not suspended;
  insert into profiles (id, role, first_name, last_name, phone, city, birth_date, referred_by)
  values (new.id, r,
          left(coalesce(nullif(trim(m->>'first_name'),''), 'Membre'), 40),
          left(coalesce(nullif(trim(m->>'last_name'),''), '-'), 60),
          nullif(trim(m->>'phone'),''),
          left(nullif(trim(m->>'city'),''), 60),
          (m->>'birth_date')::date,
          sponsor);
  if sponsor is not null and sponsor <> new.id then
    insert into referrals (sponsor_id, referee_id) values (sponsor, new.id) on conflict do nothing;
  end if;
  if r = 'companion' then
    insert into companions (id, hourly_rate, non_circumvention_accepted_at)
    values (new.id, 35, case when (m->>'non_circumvention')::boolean then now() end);
  end if;
  return new;
end $$;
revoke execute on function private.handle_new_user() from public, anon, authenticated;

drop index if exists profiles_city_key_idx;
revoke update (country, lang, email_prefs, avatar_path, interests, activities) on profiles from authenticated;
revoke update (time_zone) on companions from authenticated;
alter table companions drop column if exists time_zone;
alter table profiles drop column if exists city_key;
alter table profiles drop column if exists country, drop column if exists lang, drop column if exists email_prefs, drop column if exists avatar_path,
  drop column if exists interests, drop column if exists activities, drop column if exists terms_accepted_at,
  drop column if exists privacy_accepted_at, drop column if exists charter_accepted_at;
-- La date de naissance redevient obligatoire : échoue volontairement si un profil n'en a pas (à compléter avant)
alter table profiles alter column birth_date set not null;
drop function if exists private.norm_city(text);

-- ---------- 0011 : assurance RC et compléments fiscaux ----------
drop trigger if exists trg_booking_insurance on bookings;
drop trigger if exists trg_ins_after on companion_insurances;
drop trigger if exists trg_ins_submit on companion_insurances;
drop trigger if exists trg_receipts_keep on tax_receipts;
drop policy if exists "ins_files_insert" on storage.objects;
drop policy if exists "ins_files_read" on storage.objects;
drop function if exists public.insurance_affected_bookings();
drop function if exists private.booking_requires_insurance();
drop function if exists public.companion_insured;
drop function if exists private.insurance_ok;
drop function if exists private.insurance_after_insert();
drop function if exists private.insurance_submitted();
drop table if exists insurance_reminders;
drop table if exists insurance_reviews;
drop table if exists companion_insurances;
drop table if exists tax_receipts;
drop function if exists private.no_delete();
drop function if exists public.my_tax_breakdown;
drop function if exists public.tax_breakdown;
drop function if exists private.tax_breakdown_rows;
drop function if exists public.tax_profile_issues;
drop function if exists private.luhn_ok;
delete from storage.buckets b where b.id = 'insurance' and not exists (select 1 from storage.objects o where o.bucket_id = 'insurance');
revoke update (business_name, vat_number) on companions from authenticated;
alter table companions drop column if exists business_name, drop column if exists vat_number;
alter table settings drop column if exists insurance_required;
-- ---------- 0010 : déclaration fiscale DAC7 ----------
drop trigger if exists trg_protect_tax_decl on tax_declarations;
drop function if exists private.protect_tax_declaration();
drop function if exists public.my_tax_year;
drop function if exists public.tax_year_summary;
drop function if exists private.tax_lines;
drop table if exists tax_certificates;
drop table if exists tax_seller_records;
drop table if exists tax_declarations;
delete from storage.buckets b where b.id = 'fiscal' and not exists (select 1 from storage.objects o where o.bucket_id = 'fiscal');
revoke update (nif, tax_country, birth_city, birth_country) on companions from authenticated;
alter table companions drop column if exists nif, drop column if exists tax_country, drop column if exists birth_city, drop column if exists birth_country;
alter table settings drop column if exists operator_legal_name, drop column if exists operator_trade_name, drop column if exists operator_siren,
  drop column if exists operator_vat, drop column if exists operator_street, drop column if exists operator_postcode, drop column if exists operator_city;
commit;
