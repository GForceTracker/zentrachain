-- Live typing indicators for the community chat.
-- Personas: rows upserted by the community-bot edge function (service role).
-- Humans: presence comes through a realtime broadcast channel, not this table.
create table if not exists public.community_typing (
  name text primary key,
  until timestamptz not null default now() + interval '8 seconds'
);
alter table public.community_typing enable row level security;
drop policy if exists "Members read community typing" on public.community_typing;
create policy "Members read community typing"
  on public.community_typing for select to authenticated
  using (exists (select 1 from public.community_members m where m.user_id = (select auth.uid()) and m.status in ('active','muted')));
grant select, insert, update, delete on public.community_typing to service_role;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_typing') then
    alter publication supabase_realtime add table public.community_typing;
  end if;
end $$;
