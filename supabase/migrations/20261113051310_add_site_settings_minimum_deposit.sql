create table if not exists public.site_settings (
  setting_key text primary key,
  numeric_value numeric(20,8) not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
alter table public.site_settings enable row level security;
grant select on public.site_settings to authenticated;
grant insert, update on public.site_settings to authenticated;
drop policy if exists "Authenticated users can read site settings" on public.site_settings;
create policy "Authenticated users can read site settings"
on public.site_settings for select to authenticated using (true);
drop policy if exists "Admins can insert site settings" on public.site_settings;
create policy "Admins can insert site settings"
on public.site_settings for insert to authenticated
with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin'));
drop policy if exists "Admins can update site settings" on public.site_settings;
create policy "Admins can update site settings"
on public.site_settings for update to authenticated
using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin'))
with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin'));
insert into public.site_settings(setting_key,numeric_value)
values ('minimum_deposit_usd',10)
on conflict(setting_key) do nothing;
