create policy "Public can read deposit limits" on public.site_settings for select to anon using (setting_key in ('minimum_deposit_usd','maximum_deposit_usd'));
