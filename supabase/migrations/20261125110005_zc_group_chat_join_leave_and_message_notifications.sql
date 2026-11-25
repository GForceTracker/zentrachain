-- Group chat membership controls and member message notifications.
drop policy if exists "Users can leave community" on public.community_members;
create policy "Users can leave community"
on public.community_members
for delete
to authenticated
using (
  user_id = (select auth.uid())
  and status in ('active', 'muted')
);

alter table public.user_notifications
  drop constraint if exists user_notifications_notification_type_check;

alter table public.user_notifications
  add constraint user_notifications_notification_type_check
  check (notification_type = any (
    array['welcome', 'referral_joined', 'referred_by', 'group_chat_message']::text[]
  ));

create or replace function private.zc_notify_community_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  sender_name text := coalesce(nullif(btrim(new.author_name), ''), 'A member');
  preview text;
begin
  if new.deleted_at is not null then
    return new;
  end if;

  if nullif(btrim(coalesce(new.body, '')), '') is null then
    preview := 'Shared a photo in the group chat.';
  else
    preview := left(regexp_replace(btrim(new.body), '\s+', ' ', 'g'), 180);
  end if;

  insert into public.user_notifications (
    user_id,
    notification_type,
    title,
    message,
    metadata
  )
  select
    m.user_id,
    'group_chat_message',
    sender_name || ' sent a message in Group Chat',
    preview,
    jsonb_build_object(
      'room', 'community',
      'message_id', new.id,
      'sender_id', new.sender_id,
      'sender_name', sender_name
    )
  from public.community_members as m
  where m.user_id <> new.sender_id
    and m.status in ('active', 'muted');

  return new;
end;
$function$;

revoke all on function private.zc_notify_community_message() from public, anon, authenticated;

drop trigger if exists zc_notify_community_message_members on public.community_messages;
create trigger zc_notify_community_message_members
after insert on public.community_messages
for each row
execute function private.zc_notify_community_message();
