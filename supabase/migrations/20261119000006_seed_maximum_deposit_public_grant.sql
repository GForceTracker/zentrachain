-- Seed the missing maximum deposit limit and enable the public read grant.
-- loadLimits() in index.html requires BOTH minimum_deposit_usd and
-- maximum_deposit_usd; only the minimum was seeded previously, so every
-- deposit attempt failed with "Deposit limits could not be verified".
-- Also grants SELECT to anon so the "Public can read deposit limits" RLS
-- policy (20261113065435) can actually take effect for logged-out visitors.

insert into public.site_settings(setting_key, numeric_value)
values ('maximum_deposit_usd', 10000000)
on conflict (setting_key) do nothing;

grant select on public.site_settings to anon;
