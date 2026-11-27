-- Side by Side — RESTAURATION : annule la migration 0013 (retour à l'état précédent du schéma)
-- À n'utiliser qu'en cas de problème, APRÈS sauvegarde des données (voir PROCEDURE-MIGRATIONS.md).
-- Les données ajoutées par cette migration dans ses propres tables sont perdues ; les données antérieures sont conservées.
begin;
drop trigger if exists trg_avatar_review on profiles;
drop function if exists private.avatar_to_review();
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

drop trigger if exists trg_audit_append_only on audit_log;
drop trigger if exists trg_auth_events_append_only on admin_auth_events;
drop function if exists private.append_only();
alter table audit_log drop column if exists details;
alter table audit_log drop column if exists ip;
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin' and not suspended)
     and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
$$;

drop function if exists private.is_super_admin();
drop function if exists private.bootstrap_super_admin(text);
drop function if exists public.support_open(text, text, text, text);
drop function if exists public.support_reply(uuid, text);
drop function if exists public.support_resolve(uuid);
drop function if exists public.adm_finance(timestamptz, timestamptz);
drop function if exists public.adm_counts();
drop function if exists public.adm_users(text, text, text, int, int);
drop function if exists public.adm_admins();
drop function if exists public.adm_email(uuid);
drop function if exists public.adm_user_by_email(text);
drop function if exists private.admin_finance(timestamptz, timestamptz);
drop function if exists private.admin_counts();
drop function if exists private.admin_users(text, text, text, int, int);
drop function if exists private.admin_list();
drop table if exists support_messages;
drop table if exists support_tickets;
drop sequence if exists support_ref_seq;
drop table if exists announcements;
drop table if exists admin_auth_events;
drop table if exists admin_lockouts;
drop table if exists admin_sessions;
drop table if exists admin_accounts;
commit;
