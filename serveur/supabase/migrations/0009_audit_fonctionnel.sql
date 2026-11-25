-- =====================================================================
-- Side by Side — 0009 : corrections de l'audit fonctionnel (espaces client et accompagnateur)
-- Aucun tarif, aucune commission ni aucune règle commerciale existante n'est modifié.
-- =====================================================================

-- 1. Délai de déplacement entre deux prestations (choisi par l'accompagnateur, 0 par défaut)
alter table companions add column if not exists travel_buffer_min int not null default 0 check (travel_buffer_min between 0 and 120);
alter table bookings add column if not exists buffer_min int not null default 0 check (buffer_min between 0 and 120);
alter table bookings add column if not exists block_until timestamptz;
create or replace function private.booking_ends() returns trigger
language plpgsql set search_path = public as $$
begin
  new.ends_at := new.starts_at + make_interval(hours => new.hours, mins => coalesce(new.extra_minutes, 0));
  new.block_until := new.ends_at + make_interval(mins => coalesce(new.buffer_min, 0));
  return new;
end $$;
drop trigger if exists trg_booking_ends on bookings;
create trigger trg_booking_ends before insert or update of starts_at, hours, extra_minutes, buffer_min on bookings
  for each row execute function private.booking_ends();
update bookings set block_until = ends_at + make_interval(mins => buffer_min) where block_until is null;
alter table bookings alter column block_until set not null;
alter table bookings drop constraint if exists bookings_no_overlap;
alter table bookings add constraint bookings_no_overlap exclude using gist
  (companion_id with =, tstzrange(starts_at, block_until) with &&)
  where (status in ('en_attente','acceptee','paiement_confirme','confirmee','controle','verifie','en_cours','fin_declaree','double_attente'));

-- 2. Délai de paiement après acceptation : passé ce délai, le créneau est libéré (réglable par l'équipe)
alter table settings add column if not exists payment_hold_hours int not null default 24 check (payment_hold_hours between 1 and 168);

-- 3. Données du proche (téléphone, besoins, informations de santé) effacées dès la clôture de la mission
create or replace function private.minimize_beneficiary() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status in ('cloturee','annulee','refusee','expiree') and (new.beneficiary_phone is not null or new.beneficiary_info is not null or cardinality(new.beneficiary_needs) > 0) then
    new.beneficiary_phone := null; new.beneficiary_info := null; new.beneficiary_needs := '{}';
  end if;
  return new;
end $$;
drop trigger if exists trg_minimize_beneficiary on bookings;
create trigger trg_minimize_beneficiary before update of status on bookings for each row execute function private.minimize_beneficiary();

-- 4. Informations administratives de l'accompagnateur
alter table companions add column if not exists legal_status text check (legal_status in ('particulier','micro','societe'));
alter table companions add column if not exists admin_doc_path text;
alter table companions add column if not exists admin_status text not null default 'a_completer' check (admin_status in ('a_completer','en_cours','valide','refuse'));
alter table companions add constraint companions_tax_id_len check (tax_id is null or char_length(tax_id) <= 20);
alter table companions add constraint companions_admin_doc_own check (admin_doc_path is null or split_part(admin_doc_path, '/', 1) = id::text);
grant update (travel_buffer_min, legal_status, admin_doc_path) on companions to authenticated;
create or replace function private.admin_info_changed() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.legal_status is distinct from old.legal_status or new.tax_id is distinct from old.tax_id or new.admin_doc_path is distinct from old.admin_doc_path)
     and current_user = 'authenticated' then
    new.admin_status := 'en_cours';
  end if;
  return new;
end $$;
drop trigger if exists trg_admin_info on companions;
create trigger trg_admin_info before update on companions for each row execute function private.admin_info_changed();

-- 5. Parrainage : code saisi à l'inscription, récompense uniquement après une première mission réelle
--    (payée puis clôturée), parrain et filleul vérifiés, 5 récompenses au plus par mois et par parrain.
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

create or replace function private.referral_reward() returns trigger
language plpgsql security definer set search_path = public as $$
declare rf referrals; s settings; code text; sponsor_ok boolean; referee_ok boolean; recent int;
begin
  if new.status <> 'cloturee' or old.status = 'cloturee' then return new; end if;
  select * into rf from referrals where referee_id = new.client_id and first_booking_done_at is null for update;
  if not found then return new; end if;
  update referrals set first_booking_done_at = now() where id = rf.id;
  select identity_verified and not suspended into sponsor_ok from profiles where id = rf.sponsor_id;
  select identity_verified and not suspended into referee_ok from profiles where id = rf.referee_id;
  select count(*) into recent from gift_cards where owner_id = rf.sponsor_id and is_referral_credit and created_at > now() - interval '30 days';
  if not coalesce(sponsor_ok, false) or not coalesce(referee_ok, false) or recent >= 5 then
    insert into audit_log (actor_id, action, ref) values (rf.sponsor_id, 'Parrainage sans récompense (vérification ou plafond mensuel)', new.ref);
    return new;
  end if;
  select * into s from settings where id = 1;
  code := 'PAR-' || upper(substr(encode(extensions.gen_random_bytes(6), 'hex'), 1, 10));
  insert into gift_cards (code, amount, balance, owner_id, is_referral_credit, recipient_name)
  values (code, s.referral_eur, s.referral_eur, rf.sponsor_id, true, 'Crédit de parrainage');
  insert into notifications (user_id, kind, body)
  values (rf.sponsor_id, 'parrainage', 'Votre filleul a réalisé sa première prestation : ' || s.referral_eur || ' € de crédit ajoutés à votre compte.');
  return new;
end $$;
revoke execute on function private.referral_reward() from public, anon, authenticated;
drop trigger if exists trg_referral_reward on bookings;
create trigger trg_referral_reward after update of status on bookings for each row execute function private.referral_reward();

-- 6. Messagerie : notification du destinataire (au plus une toutes les 10 minutes par conversation)
create or replace function private.notify_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare b bookings; dest uuid; nm text;
begin
  select * into b from bookings where id = new.booking_id;
  dest := case when new.sender_id = b.client_id then b.companion_id else b.client_id end;
  select first_name into nm from profiles where id = new.sender_id;
  if not exists (select 1 from notifications where user_id = dest and booking_id = b.id and kind = 'message' and read_at is null and created_at > now() - interval '10 minutes') then
    insert into notifications (user_id, booking_id, kind, body) values (dest, b.id, 'message', 'Nouveau message de ' || coalesce(nm, 'votre interlocuteur') || ' (' || b.ref || ').');
  end if;
  return new;
end $$;
revoke execute on function private.notify_message() from public, anon, authenticated;
drop trigger if exists trg_notify_message on messages;
create trigger trg_notify_message after insert on messages for each row execute function private.notify_message();

-- 7. Pièces jointes : lisibles uniquement par les deux parties de la réservation
drop policy if exists "msg_attach_read" on storage.objects;
create policy "msg_attach_read" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and exists (
    select 1 from public.messages m join public.bookings b on b.id = m.booking_id
    where m.attachment_path = storage.objects.name and (b.client_id = auth.uid() or b.companion_id = auth.uid())));

-- 8. Nouvelle photo de référence ou photo publique : l'équipe est prévenue pour vérification
create or replace function private.photo_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, kind, body)
  select p.id, 'admin', case when new.is_reference then 'Nouvelle photo de référence à vérifier (nouvelle vérification obligatoire).' else 'Nouvelle photo publique à vérifier avant publication.' end
  from profiles p where p.role = 'admin' and not p.suspended;
  return new;
end $$;
revoke execute on function private.photo_review() from public, anon, authenticated;
drop trigger if exists trg_photo_review on companion_photos;
create trigger trg_photo_review after insert on companion_photos for each row execute function private.photo_review();

-- 9. Mes réservations : « versement effectué » seulement si Stripe a confirmé le virement
drop function if exists public.my_bookings();
create or replace function public.my_bookings()
returns table (booking jsonb, client_first_name text, companion_first_name text)
language sql stable security definer set search_path = public as $$
  select (to_jsonb(b) - 'stripe_payment_intent_id' - 'stripe_transfer_id' - 'payment_lock_at' - 'payout_error' - 'payout_attempts'
           - (case when b.companion_id = auth.uid() then 'gift_code' else '' end)
           - (case when b.client_id = auth.uid() then 'amount_commission' else '' end)
           - (case when b.client_id = auth.uid() then 'amount_payout' else '' end))
         || jsonb_build_object('payout_done', b.stripe_transfer_id is not null,
                               'payment_deadline', case when b.status = 'acceptee' then least(b.mission_signed_companion + make_interval(hours => (select payment_hold_hours from settings where id = 1)), b.starts_at - interval '2 hours') end),
         pc.first_name, pp.first_name
  from bookings b
  join profiles pc on pc.id = b.client_id
  join profiles pp on pp.id = b.companion_id
  where b.client_id = auth.uid() or b.companion_id = auth.uid()
  order by b.starts_at desc
$$;
revoke execute on function public.my_bookings() from public, anon;
grant execute on function public.my_bookings() to authenticated;

-- 10. Justificatifs : un numéro de facture unique par réservation et par destinataire
create unique index if not exists invoices_booking_kind on invoices(booking_id, kind) where booking_id is not null;
