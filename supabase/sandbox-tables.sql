create table if not exists public.deposit_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(20,8) not null check (amount > 0),
  asset text not null default 'USDT',
  network text not null,
  tx_hash text,
  status text not null default 'pending'
    check (status in ('pending','under_review','approved','rejected','paid','credited','cancelled')),
  admin_note text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists deposit_requests_user_idx on public.deposit_requests(user_id, created_at desc);
create index if not exists deposit_requests_status_idx on public.deposit_requests(status, created_at desc);

create table if not exists public.withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(20,8) not null check (amount > 0),
  asset text not null default 'USDT',
  network text not null,
  destination_address text not null,
  tx_hash text,
  status text not null default 'pending'
    check (status in ('pending','under_review','approved','paid','rejected','cancelled')),
  admin_note text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  paid_by uuid references auth.users(id),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists withdrawal_requests_user_idx on public.withdrawal_requests(user_id, created_at desc);
create index if not exists withdrawal_requests_status_idx on public.withdrawal_requests(status, created_at desc);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(20,8) not null,
  entry_type text not null default 'adjustment',
  description text,
  reference_type text,
  reference_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists ledger_entries_user_idx on public.ledger_entries(user_id, created_at desc);

create table if not exists public.trade_reports (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  period_start date,
  period_end date,
  gross_pnl numeric(20,2),
  net_pnl numeric(20,2),
  max_drawdown numeric(8,2),
  trades_count integer,
  verified boolean not null default false,
  published boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists trade_reports_period_idx on public.trade_reports(period_end desc);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);

alter table public.deposit_requests enable row level security;
alter table public.withdrawal_requests enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.trade_reports enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "Users read own deposits or admins read all" on public.deposit_requests;
create policy "Users read own deposits or admins read all"
  on public.deposit_requests for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

drop policy if exists "Users submit own deposits" on public.deposit_requests;
create policy "Users submit own deposits"
  on public.deposit_requests for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'pending');

drop policy if exists "Admins manage deposit requests" on public.deposit_requests;
create policy "Admins manage deposit requests"
  on public.deposit_requests for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

drop policy if exists "Users read own withdrawals or admins read all" on public.withdrawal_requests;
create policy "Users read own withdrawals or admins read all"
  on public.withdrawal_requests for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

drop policy if exists "Admins manage withdrawal requests" on public.withdrawal_requests;
create policy "Admins manage withdrawal requests"
  on public.withdrawal_requests for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

drop policy if exists "Users read own ledger or admins read all" on public.ledger_entries;
create policy "Users read own ledger or admins read all"
  on public.ledger_entries for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

drop policy if exists "Admins manage trade reports" on public.trade_reports;
create policy "Admins manage trade reports"
  on public.trade_reports for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

drop policy if exists "Users read published trade reports" on public.trade_reports;
create policy "Users read published trade reports"
  on public.trade_reports for select to authenticated
  using (published = true or (select private.is_admin()));

drop policy if exists "Admins read audit logs" on public.audit_logs;
create policy "Admins read audit logs"
  on public.audit_logs for select to authenticated
  using ((select private.is_admin()));

drop policy if exists "Users record own audit actions" on public.audit_logs;
create policy "Users record own audit actions"
  on public.audit_logs for insert to authenticated
  with check (actor_id = (select auth.uid()));

grant select on public.deposit_requests, public.withdrawal_requests, public.ledger_entries, public.trade_reports, public.audit_logs to authenticated;
grant insert on public.deposit_requests, public.audit_logs to authenticated;
grant update on public.deposit_requests, public.withdrawal_requests to authenticated;
grant select, insert, update, delete on public.deposit_requests, public.withdrawal_requests, public.ledger_entries, public.trade_reports, public.audit_logs to service_role;

create or replace function public.request_gforce_withdrawal(
  p_amount numeric,
  p_network text,
  p_destination text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_balance numeric;
  v_reserved numeric;
  v_min numeric;
  v_max numeric;
  v_id uuid;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000 then raise exception 'Invalid USD value'; end if;
  if length(p_destination) < 20 or length(p_destination) > 150 then raise exception 'Invalid destination address'; end if;
  select numeric_value into v_min from public.site_settings where setting_key = 'minimum_withdrawal_usd';
  select numeric_value into v_max from public.site_settings where setting_key = 'maximum_withdrawal_usd';
  if v_min is not null and p_amount < v_min then raise exception 'Minimum withdrawal is USD %', v_min; end if;
  if v_max is not null and p_amount > v_max then raise exception 'Maximum withdrawal is USD %', v_max; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  select coalesce(sum(amount),0) into v_balance from public.ledger_entries where user_id = v_uid;
  select coalesce(sum(amount),0) into v_reserved from public.withdrawal_requests
    where user_id = v_uid and status in ('pending','under_review','approved');
  if p_amount > v_balance - v_reserved then raise exception 'Insufficient available balance'; end if;
  insert into public.withdrawal_requests(user_id, amount, asset, network, destination_address)
  values (v_uid, round(p_amount, 8), 'USDT', upper(p_network), p_destination)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.request_gforce_withdrawal(numeric,text,text) from public;
grant execute on function public.request_gforce_withdrawal(numeric,text,text) to authenticated;

create or replace function public.admin_review_gforce_deposit(
  p_request_id uuid,
  p_approve boolean,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.deposit_requests%rowtype;
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_note is null or btrim(p_note) = '' then raise exception 'A review note is required'; end if;
  select * into v_req from public.deposit_requests where id = p_request_id for update;
  if not found then raise exception 'Deposit request not found'; end if;
  if v_req.status not in ('pending','under_review') then raise exception 'Deposit request was already reviewed'; end if;
  if p_approve then
    update public.deposit_requests
      set status = 'approved', admin_note = p_note, reviewed_by = v_uid,
          reviewed_at = now(), updated_at = now()
      where id = p_request_id
      returning id into v_id;
    insert into public.ledger_entries(user_id, amount, entry_type, description, reference_type, reference_id)
    values (v_req.user_id, v_req.amount, 'deposit', 'Deposit credited: ' || btrim(p_note), 'deposit_request', p_request_id);
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (v_uid, 'deposit_approved', 'deposit_request', p_request_id::text,
            jsonb_build_object('amount', v_req.amount, 'note', p_note, 'user_id', v_req.user_id));
  else
    update public.deposit_requests
      set status = 'rejected', admin_note = p_note, reviewed_by = v_uid,
          reviewed_at = now(), updated_at = now()
      where id = p_request_id
      returning id into v_id;
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (v_uid, 'deposit_rejected', 'deposit_request', p_request_id::text,
            jsonb_build_object('note', p_note, 'user_id', v_req.user_id));
  end if;
  return v_id;
end;
$$;
revoke all on function public.admin_review_gforce_deposit(uuid,boolean,text) from public;
grant execute on function public.admin_review_gforce_deposit(uuid,boolean,text) to authenticated;

create or replace function public.admin_pay_gforce_withdrawal(
  p_request_id uuid,
  p_tx_hash text,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.withdrawal_requests%rowtype;
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_tx_hash is null or btrim(p_tx_hash) = '' then raise exception 'A transaction hash is required'; end if;
  select * into v_req from public.withdrawal_requests where id = p_request_id for update;
  if not found then raise exception 'Withdrawal request not found'; end if;
  if v_req.status not in ('pending','under_review','approved') then raise exception 'Withdrawal request was already completed'; end if;
  update public.withdrawal_requests
    set status = 'paid', tx_hash = btrim(p_tx_hash), admin_note = p_note,
        paid_by = v_uid, paid_at = now(), updated_at = now()
    where id = p_request_id
    returning id into v_id;
  insert into public.ledger_entries(user_id, amount, entry_type, description, reference_type, reference_id)
  values (v_req.user_id, -v_req.amount, 'withdrawal',
          'Withdrawal paid: ' || coalesce(nullif(btrim(p_note), ''), 'payout recorded'),
          'withdrawal_request', p_request_id);
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (v_uid, 'withdrawal_paid', 'withdrawal_request', p_request_id::text,
          jsonb_build_object('amount', v_req.amount, 'tx_hash', p_tx_hash, 'user_id', v_req.user_id));
  return v_id;
end;
$$;
revoke all on function public.admin_pay_gforce_withdrawal(uuid,text,text) from public;
grant execute on function public.admin_pay_gforce_withdrawal(uuid,text,text) to authenticated;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='deposit_requests') then alter publication supabase_realtime add table public.deposit_requests; end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='withdrawal_requests') then alter publication supabase_realtime add table public.withdrawal_requests; end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='ledger_entries') then alter publication supabase_realtime add table public.ledger_entries; end if;
end $$;
