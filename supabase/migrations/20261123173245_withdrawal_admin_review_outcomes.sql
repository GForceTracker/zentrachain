-- Keep withdrawals reserved against Available Funds until the administrator makes a final decision.
-- Approve records a verified payment, Decline releases the reservation, and Ignore voids
-- the request while permanently consuming the reserved amount.

alter table public.withdrawal_requests
  add column if not exists paid_by uuid references auth.users(id) on delete set null,
  add column if not exists paid_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.withdrawal_requests
  drop constraint if exists withdrawal_requests_status_check;

alter table public.withdrawal_requests
  add constraint withdrawal_requests_status_check
  check (status = any (array[
    'pending'::text,
    'under_review'::text,
    'approved'::text,
    'rejected'::text,
    'declined'::text,
    'voided'::text,
    'paid'::text
  ]));

create index if not exists withdrawal_requests_status_created_at_idx
  on public.withdrawal_requests (status, created_at desc);

create unique index if not exists ledger_entries_one_debit_per_withdrawal_idx
  on public.ledger_entries (reference_type, reference_id)
  where reference_type in ('withdrawal_request', 'withdrawal_ignored')
    and reference_id is not null;

create or replace function public.admin_pay_gforce_withdrawal(
  p_request_id uuid,
  p_tx_hash text,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_user_id uuid;
  v_req public.withdrawal_requests%rowtype;
begin
  if v_uid is null or not (select private.is_admin()) then
    raise exception 'Administrator access required';
  end if;
  if p_request_id is null then
    raise exception 'Choose a withdrawal request';
  end if;
  if p_tx_hash is null or btrim(p_tx_hash) = '' then
    raise exception 'A transaction hash is required';
  end if;

  select user_id into v_user_id
  from public.withdrawal_requests
  where id = p_request_id;
  if not found then
    raise exception 'Withdrawal request not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  select * into v_req
  from public.withdrawal_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception 'Withdrawal request not found';
  end if;
  if v_req.status not in ('pending', 'under_review', 'approved') then
    raise exception 'Withdrawal request is already completed';
  end if;

  update public.withdrawal_requests
  set status = 'paid',
      tx_hash = btrim(p_tx_hash),
      admin_note = nullif(btrim(coalesce(p_note, '')), ''),
      crypto_amount = coalesce(
        crypto_amount,
        case when upper(asset) = 'USDT' then amount else null end
      ),
      usd_price = coalesce(
        usd_price,
        case when upper(asset) = 'USDT' then 1 else null end
      ),
      paid_by = v_uid,
      paid_at = now(),
      reviewed_at = now(),
      updated_at = now()
  where id = p_request_id;

  insert into public.ledger_entries (
    user_id, amount, entry_type, description,
    reference_type, reference_id, created_by
  )
  values (
    v_req.user_id,
    -v_req.amount,
    'withdrawal',
    'Withdrawal paid: ' || coalesce(nullif(btrim(p_note), ''), 'payout verified on-chain'),
    'withdrawal_request',
    p_request_id,
    v_uid
  );

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (
    v_uid,
    'withdrawal_paid',
    'withdrawal_request',
    p_request_id,
    jsonb_build_object(
      'amount', v_req.amount,
      'tx_hash', btrim(p_tx_hash),
      'user_id', v_req.user_id,
      'status', 'paid'
    )
  );

  return p_request_id;
end;
$function$;

create or replace function public.admin_decline_gforce_withdrawal(
  p_request_id uuid,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_user_id uuid;
  v_req public.withdrawal_requests%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_uid is null or not (select private.is_admin()) then
    raise exception 'Administrator access required';
  end if;
  if p_request_id is null then
    raise exception 'Choose a withdrawal request';
  end if;

  select user_id into v_user_id
  from public.withdrawal_requests
  where id = p_request_id;
  if not found then
    raise exception 'Withdrawal request not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  select * into v_req
  from public.withdrawal_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception 'Withdrawal request not found';
  end if;
  if v_req.status not in ('pending', 'under_review', 'approved') then
    raise exception 'Withdrawal request is already completed';
  end if;

  if exists (
    select 1 from public.ledger_entries
    where reference_id = p_request_id
      and reference_type in ('withdrawal_request', 'withdrawal_ignored')
  ) then
    raise exception 'This withdrawal has already been debited and cannot be declined';
  end if;

  update public.withdrawal_requests
  set status = 'declined',
      admin_note = coalesce(v_note, 'Withdrawal declined by administrator'),
      reviewed_at = now(),
      updated_at = now()
  where id = p_request_id;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (
    v_uid,
    'withdrawal_declined',
    'withdrawal_request',
    p_request_id,
    jsonb_build_object(
      'amount', v_req.amount,
      'user_id', v_req.user_id,
      'reservation_released', true,
      'note', v_note
    )
  );

  return p_request_id;
end;
$function$;

create or replace function public.admin_ignore_gforce_withdrawal(
  p_request_id uuid,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_user_id uuid;
  v_req public.withdrawal_requests%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_uid is null or not (select private.is_admin()) then
    raise exception 'Administrator access required';
  end if;
  if p_request_id is null then
    raise exception 'Choose a withdrawal request';
  end if;

  select user_id into v_user_id
  from public.withdrawal_requests
  where id = p_request_id;
  if not found then
    raise exception 'Withdrawal request not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  select * into v_req
  from public.withdrawal_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception 'Withdrawal request not found';
  end if;
  if v_req.status not in ('pending', 'under_review', 'approved') then
    raise exception 'Withdrawal request is already completed';
  end if;

  if exists (
    select 1 from public.ledger_entries
    where reference_id = p_request_id
      and reference_type in ('withdrawal_request', 'withdrawal_ignored')
  ) then
    raise exception 'This withdrawal has already been debited';
  end if;

  update public.withdrawal_requests
  set status = 'voided',
      admin_note = coalesce(v_note, 'Withdrawal ignored and voided; funds are not returned'),
      reviewed_at = now(),
      updated_at = now()
  where id = p_request_id;

  insert into public.ledger_entries (
    user_id, amount, entry_type, description,
    reference_type, reference_id, created_by
  )
  values (
    v_req.user_id,
    -v_req.amount,
    'withdrawal',
    'Withdrawal request voided; funds were not returned',
    'withdrawal_ignored',
    p_request_id,
    v_uid
  );

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (
    v_uid,
    'withdrawal_voided',
    'withdrawal_request',
    p_request_id,
    jsonb_build_object(
      'amount', v_req.amount,
      'user_id', v_req.user_id,
      'funds_returned', false,
      'note', v_note
    )
  );

  return p_request_id;
end;
$function$;

revoke all on function public.admin_pay_gforce_withdrawal(uuid, text, text) from public, anon;
revoke all on function public.admin_decline_gforce_withdrawal(uuid, text) from public, anon;
revoke all on function public.admin_ignore_gforce_withdrawal(uuid, text) from public, anon;
grant execute on function public.admin_pay_gforce_withdrawal(uuid, text, text) to authenticated, service_role;
grant execute on function public.admin_decline_gforce_withdrawal(uuid, text) to authenticated, service_role;
grant execute on function public.admin_ignore_gforce_withdrawal(uuid, text) to authenticated, service_role;

revoke all on function public.request_gforce_withdrawal(numeric, text, text) from public, anon;
grant execute on function public.request_gforce_withdrawal(numeric, text, text) to authenticated, service_role;
