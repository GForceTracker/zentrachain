-- Persistent, administrator-only unread deposit alerts for the Treasury bubble.
create table if not exists public.admin_deposit_alerts (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id) on delete cascade,
  deposit_request_id uuid not null references public.deposit_requests(id) on delete cascade,
  created_at timestamptz not null default now(),
  treasury_seen_at timestamptz,
  constraint admin_deposit_alerts_admin_request_key unique (admin_id, deposit_request_id)
);

create index if not exists admin_deposit_alerts_unseen_idx
  on public.admin_deposit_alerts (admin_id, created_at desc)
  where treasury_seen_at is null;

alter table public.admin_deposit_alerts enable row level security;
revoke all on table public.admin_deposit_alerts from public, anon, authenticated;
grant select, update on table public.admin_deposit_alerts to authenticated;

drop policy if exists "Admins read own Treasury deposit alerts" on public.admin_deposit_alerts;
create policy "Admins read own Treasury deposit alerts"
  on public.admin_deposit_alerts
  for select to authenticated
  using (admin_id = (select auth.uid()) and (select private.is_admin()));

drop policy if exists "Admins mark own Treasury deposit alerts seen" on public.admin_deposit_alerts;
create policy "Admins mark own Treasury deposit alerts seen"
  on public.admin_deposit_alerts
  for update to authenticated
  using (admin_id = (select auth.uid()) and (select private.is_admin()))
  with check (admin_id = (select auth.uid()) and (select private.is_admin()));

-- reference_id is reserved for referrals by an existing foreign key; store the
-- deposit_request_id in metadata instead.
alter table public.user_notifications
  drop constraint if exists user_notifications_notification_type_check;
alter table public.user_notifications
  add constraint user_notifications_notification_type_check
  check (notification_type = any (array[
    'welcome','referral_joined','referred_by','group_chat_message',
    'admin_deposit_detected'
  ]::text[]));

create unique index if not exists zc_admin_deposit_notification_once_idx
  on public.user_notifications (user_id, (metadata ->> 'deposit_request_id'))
  where notification_type = 'admin_deposit_detected'
    and metadata ? 'deposit_request_id';

create or replace function private.zc_notify_admin_deposit_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_admin_id uuid;
  v_member_name text;
  v_status text;
  v_rows integer;
  v_message text;
begin
  -- Both user-submitted pending requests and new verified on-chain credits are
  -- inserted into deposit_requests. Updates do not generate duplicate alerts.
  if lower(coalesce(new.status, '')) not in ('pending', 'credited') then
    return new;
  end if;

  select coalesce(
    nullif(pg_catalog.btrim(p.full_name), ''),
    nullif(pg_catalog.btrim(p.email), ''),
    'Member'
  )
  into v_member_name
  from public.profiles p
  where p.id = new.user_id;

  v_member_name := coalesce(v_member_name, 'Member');
  v_status := lower(coalesce(new.status, 'pending'));
  v_message := 'A new deposit from ' || v_member_name ||
    ' was detected: ' || new.amount::text || ' ' ||
    upper(coalesce(new.asset, 'USDT')) || ' on ' ||
    upper(coalesce(new.network, 'network')) ||
    '. Status: ' || v_status || '.';

  for v_admin_id in
    select p.id from public.profiles p where p.role = 'admin'
  loop
    insert into public.admin_deposit_alerts (admin_id, deposit_request_id)
    values (v_admin_id, new.id)
    on conflict (admin_id, deposit_request_id) do nothing;

    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      insert into public.user_notifications
        (user_id, notification_type, title, message, metadata, reference_id)
      values (
        v_admin_id,
        'admin_deposit_detected',
        'New user deposit',
        v_message,
        pg_catalog.jsonb_build_object(
          'deposit_request_id', new.id,
          'member_id', new.user_id,
          'amount', new.amount,
          'asset', upper(coalesce(new.asset, 'USDT')),
          'network', upper(coalesce(new.network, '')),
          'status', v_status,
          'tx_hash', new.tx_hash
        ),
        null
      )
      on conflict do nothing;
    end if;
  end loop;

  return new;
end;
$function$;

revoke all on function private.zc_notify_admin_deposit_request() from public, anon, authenticated;

drop trigger if exists zc_admin_deposit_request_alert on public.deposit_requests;
create trigger zc_admin_deposit_request_alert
  after insert on public.deposit_requests
  for each row
  execute function private.zc_notify_admin_deposit_request();

do $publication$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'admin_deposit_alerts'
     ) then
    alter publication supabase_realtime add table public.admin_deposit_alerts;
  end if;
end;
$publication$;
