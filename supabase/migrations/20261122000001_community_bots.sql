-- Community group chat: autonomous DeepSeek-powered members + on-chain activity heading.
-- Bot messages are posted with the service role, so sender_id is nullable for them.
alter table public.community_messages alter column sender_id drop not null;

-- Author trigger: bots (sender_id null) must supply author_name themselves.
create or replace function public.community_set_message_author() returns trigger language plpgsql set search_path='' as $$
begin
  if new.sender_id is null then
    if new.author_name is null or btrim(new.author_name) = '' then
      raise exception 'Bot messages require an author_name';
    end if;
    return new;
  end if;
  select coalesce(nullif(btrim(p.full_name),''),nullif(split_part(p.email,'@',1),''),'Member') into new.author_name from public.profiles p where p.id = new.sender_id;
  if new.author_name is null then raise exception 'A ZentraChain account profile is required to post'; end if;
  return new;
end; $$;

-- Atomic rate-limit gate so overlapping client polls cannot double-post bot messages.
create table if not exists public.community_bot_state (
  id boolean primary key default true,
  last_run timestamptz not null default '1970-01-01'
);
insert into public.community_bot_state(id) values (true) on conflict (id) do nothing;
alter table public.community_bot_state enable row level security;
grant select, update on public.community_bot_state to service_role;
