-- =====================================================================
-- Side by Side — 0006 : branchement de l'application (lot 1)
-- Inscription automatique du profil, annuaire des accompagnateurs,
-- liste de mes réservations, messages en temps réel.
-- =====================================================================

-- 1. À l'inscription (Supabase Auth), le profil est créé à partir des informations saisies.
--    Le rôle admin ne peut jamais être choisi ; un mineur est refusé par la base.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
        r user_role := case when m->>'role' in ('companion','business') then (m->>'role')::user_role else 'client' end;
begin
  insert into profiles (id, role, first_name, last_name, phone, city, birth_date)
  values (new.id, r,
          left(coalesce(nullif(trim(m->>'first_name'),''), 'Membre'), 40),
          left(coalesce(nullif(trim(m->>'last_name'),''), '-'), 60),
          nullif(trim(m->>'phone'),''),
          left(nullif(trim(m->>'city'),''), 60),
          (m->>'birth_date')::date);
  if r = 'companion' then
    insert into companions (id, hourly_rate, non_circumvention_accepted_at)
    values (new.id, 35, case when (m->>'non_circumvention')::boolean then now() end);
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();
revoke execute on function private.handle_new_user() from public, anon, authenticated;

-- 2. Annuaire : uniquement les informations publiques des accompagnateurs vérifiés
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

-- 3. Mes réservations, avec le prénom de l'autre partie (jamais son téléphone ni son adresse)
create or replace function public.my_bookings()
returns table (booking jsonb, client_first_name text, companion_first_name text)
language sql stable security definer set search_path = public as $$
  select to_jsonb(b) - 'meeting_code_hash' - 'stripe_payment_intent_id' - 'stripe_transfer_id'
           - (case when b.companion_id = auth.uid() then 'gift_code' else '' end),
         pc.first_name, pp.first_name
  from bookings b
  join profiles pc on pc.id = b.client_id
  join profiles pp on pp.id = b.companion_id
  where b.client_id = auth.uid() or b.companion_id = auth.uid()
  order by b.starts_at desc
$$;
revoke execute on function public.my_bookings() from public, anon;
grant execute on function public.my_bookings() to authenticated;

-- 4. Temps réel : nouveaux messages et changements de statut
do $$ begin
  begin alter publication supabase_realtime add table public.messages; exception when others then null; end;
  begin alter publication supabase_realtime add table public.bookings; exception when others then null; end;
end $$;
