create policy "Public can read shared plan artwork setting"
on public.site_settings
for select
to anon
using (setting_key = 'shared_plan_artwork');
