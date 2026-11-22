-- Make showcase seeding idempotent: identical entries are skipped on re-seed.
alter table public.activity_showcase
  add constraint activity_showcase_unique_entry
  unique (display_name, direction, asset, network, amount);
