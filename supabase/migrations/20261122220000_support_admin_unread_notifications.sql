-- Persistent admin read receipts and live customer support message updates.
alter table public.support_conversations
  add column if not exists admin_last_read_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'support_messages'
  ) then
    alter publication supabase_realtime add table public.support_messages;
  end if;
end
$$;
