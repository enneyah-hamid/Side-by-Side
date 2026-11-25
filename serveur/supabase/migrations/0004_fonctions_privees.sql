-- Side by Side — 0004 : fonctions internes hors de l'API publique (recommandation Supabase)
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
alter function public.is_admin() set schema private;
alter function public.my_role() set schema private;
alter function public.my_companion_verified() set schema private;
revoke execute on function private.is_admin(), private.my_role(), private.my_companion_verified() from public, anon;
grant execute on function private.is_admin(), private.my_role(), private.my_companion_verified() to authenticated;
revoke execute on function public.reveal_reviews() from public, anon, authenticated;
create or replace function public.admin_find_by_phone(q text)
returns table (profile_id uuid, name text, role user_role, phone text, last_booking uuid, last_ref text, last_status booking_status)
language sql stable security definer set search_path = public as $$
  select p.id, p.first_name || ' ' || p.last_name, p.role, p.phone, b.id, b.ref, b.status
  from profiles p
  left join lateral (select id, ref, status from bookings where client_id = p.id or companion_id = p.id order by starts_at desc limit 1) b on true
  where private.is_admin() and regexp_replace(p.phone, '\D', '', 'g') like '%' || regexp_replace(q, '\D', '', 'g') || '%'
$$;
revoke execute on function public.admin_find_by_phone(text) from public, anon;
grant execute on function public.admin_find_by_phone(text) to authenticated;
