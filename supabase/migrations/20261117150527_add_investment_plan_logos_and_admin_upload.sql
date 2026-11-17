alter table public.gforce_investment_plans
  add column if not exists tagline text not null default '',
  add column if not exists badge_label text not null default '',
  add column if not exists logo_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plan-logos', 'plan-logos', true, 2097152, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can read G-Force plan logos" on storage.objects;
create policy "Public can read G-Force plan logos"
on storage.objects for select to anon, authenticated
using (bucket_id = 'plan-logos');

drop policy if exists "Admins can upload G-Force plan logos" on storage.objects;
create policy "Admins can upload G-Force plan logos"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'plan-logos'
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin')
);

drop policy if exists "Admins can replace G-Force plan logos" on storage.objects;
create policy "Admins can replace G-Force plan logos"
on storage.objects for update to authenticated
using (
  bucket_id = 'plan-logos'
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin')
)
with check (
  bucket_id = 'plan-logos'
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin')
);

drop policy if exists "Admins can delete G-Force plan logos" on storage.objects;
create policy "Admins can delete G-Force plan logos"
on storage.objects for delete to authenticated
using (
  bucket_id = 'plan-logos'
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin')
);
