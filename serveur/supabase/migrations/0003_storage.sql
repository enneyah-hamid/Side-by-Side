-- =====================================================================
-- Side by Side — 0003 : stockage privé des photos et documents (Supabase Storage)
-- Chaque utilisateur range ses fichiers dans un dossier à son identifiant : <id>/fichier.jpg
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg','image/png']),
       ('documents', 'documents', false, 5242880, array['image/jpeg','image/png','application/pdf'])
on conflict (id) do nothing;

-- Chacun dépose et lit ses propres fichiers
create policy "own_files_insert" on storage.objects for insert to authenticated
  with check (bucket_id in ('photos','documents') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own_files_read" on storage.objects for select to authenticated
  using (bucket_id in ('photos','documents') and (storage.foldername(name))[1] = auth.uid()::text);

-- Photos validées des accompagnateurs : visibles par les membres connectés (jamais la photo de référence)
create policy "validated_photos_read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and exists (
    select 1 from public.companion_photos ph where ph.storage_path = storage.objects.name and ph.status = 'ok' and not ph.is_reference));

-- L'équipe admin voit tout
create policy "admin_files_read" on storage.objects for select to authenticated
  using (bucket_id in ('photos','documents') and public.is_admin());
