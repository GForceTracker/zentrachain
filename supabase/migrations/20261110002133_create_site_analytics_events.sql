create table if not exists public.site_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('page_view','telegram_click')),
  country text,
  device text,
  referrer text,
  source text,
  created_at timestamptz not null default now()
);
create index if not exists site_events_created_at_idx on public.site_events (created_at desc);
create index if not exists site_events_event_type_idx on public.site_events (event_type);
alter table public.site_events enable row level security;
revoke all on public.site_events from anon, authenticated;
