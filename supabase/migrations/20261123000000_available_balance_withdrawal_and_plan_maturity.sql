-- Available-Funds-only withdrawals and plan maturity settlement.
-- Deposit Balance remains selectable for plan purchases, but is never withdrawable.
-- On expiry, plan principal and profit are credited to Available Funds.

create or replace function private.zc_available_funds(p_user_id uuid)
returns numeric
language sql
stable
set search_path = ''
as $function$
  with ledger_totals as (
    select
      coalesce(sum(le.amount), 0)::numeric(20,8) as ledger_balance,
      coalesce(sum(le.amount) filter (
        where le.entry_type in ('deposit','deposit_credit')
      ), 0)::numeric(20,8) as deposit_gross,
      coalesce(sum(le.amount) filter (
        where le.reference_type = 'admin_deposit_debit'
      ), 0)::numeric(20,8) as deposit_debits
    from public.ledger_entries le
    where le.user_id = p_user_id
  ),
  reserved_totals as (
    select coalesce(sum(w.amount), 0)::numeric(20,8) as reserved
    from public.withdrawal_requests w
    where w.user_id = p_user_id
      and w.status in ('pending','under_review','approved')
  ),
  legacy_locked as (
    select coalesce(sum(ui.amount), 0)::numeric(20,8) as locked
    from public.user_investments ui
    left join public.ledger_entries le
      on le.id = ui.ledger_entry_id
     and le.user_id = p_user_id
    where ui.user_id = p_user_id
      and ui.status = 'active'
      and (ui.ends_at is null or ui.ends_at > now())
      and not coalesce(le.amount < 0, false)
  ),
  legacy_deposit_locked as (
    select coalesce(sum(ui.amount), 0)::numeric(20,8) as locked
    from public.user_investments ui
    join public.ledger_entries le
      on le.id = ui.ledger_entry_id
     and le.user_id = p_user_id
    where ui.user_id = p_user_id
      and ui.status = 'active'
      and (ui.ends_at is null or ui.ends_at > now())
      and le.entry_type in ('deposit','deposit_credit')
      and le.amount > 0
  ),
  deposit_plan_spent as (
    select coalesce(sum(ui.amount), 0)::numeric(20,8) as spent
    from public.user_investments ui
    join public.ledger_entries le
      on le.id = ui.ledger_entry_id
     and le.user_id = p_user_id
    where ui.user_id = p_user_id
      and ui.status <> 'cancelled'
      and le.amount < 0
      and le.reference_type in ('plan_purchase_deposit','plan_purchase')
  ),
  calculated as (
    select
      greatest(0, l.ledger_balance - r.reserved - k.locked)::numeric(20,8) as spendable,
      greatest(
        0,
        l.deposit_gross + l.deposit_debits - dl.locked - ds.spent
      )::numeric(20,8) as raw_deposit_balance
    from ledger_totals l
    cross join reserved_totals r
    cross join legacy_locked k
    cross join legacy_deposit_locked dl
    cross join deposit_plan_spent ds
  )
  select greatest(0, spendable - least(spendable, raw_deposit_balance))::numeric(20,8)
  from calculated;
$function$;

revoke all on function private.zc_available_funds(uuid) from public, anon, authenticated;

create or replace function public.zc_settle_gforce_investments()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.user_investments%rowtype;
  v_source_type text;
  v_source_amount numeric(20,8);
  v_principal numeric(20,8);
  v_profit numeric(20,8);
  v_total_payout numeric(20,8);
  v_count integer := 0;
begin
  if v_uid is null then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  for v_row in
    update public.user_investments
      set status = 'completed'
      where user_id = v_uid
        and status = 'active'
        and ends_at is not null
        and ends_at <= now()
      returning *
  loop
    v_source_type := null;
    v_source_amount := null;

    select le.entry_type, le.amount
      into v_source_type, v_source_amount
      from public.ledger_entries le
      where le.id = v_row.ledger_entry_id
        and le.user_id = v_uid;

    v_principal := round(greatest(0, coalesce(v_row.amount, 0)), 8);
    v_profit := round(v_principal * greatest(0, coalesce(v_row.rate, 0)) / 100.0, 8);
    v_total_payout := round(v_principal + v_profit, 8);

    if v_total_payout > 0 then
      insert into public.ledger_entries
        (user_id, amount, entry_type, description, reference_type, reference_id, created_by)
      values
        (v_uid, v_total_payout, 'plan_maturity',
         'Plan completed — principal and profit moved to Available Funds',
         'plan_maturity', v_row.id, v_uid);
    end if;

    if v_principal > 0
       and coalesce(v_source_amount, 0) > 0
       and v_source_type in ('deposit','deposit_credit') then
      insert into public.ledger_entries
        (user_id, amount, entry_type, description, reference_type, reference_id, created_by)
      values
        (v_uid, -v_principal, 'adjustment',
         'Matured plan principal moved from Deposit Balance to Available Funds',
         'admin_deposit_debit', v_row.id, v_uid);
    end if;

    insert into public.audit_logs
      (actor_id, action, entity_type, entity_id, details)
    values
      (v_uid, 'plan_matured', 'user_investment', v_row.id,
       jsonb_build_object(
         'principal', v_principal,
         'profit', v_profit,
         'total_credited', v_total_payout,
         'source_entry_type', v_source_type
       ));

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

create or replace function public.request_gforce_withdrawal(
  p_amount numeric,
  p_network text,
  p_destination text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_min_withdrawal numeric;
  v_max_withdrawal numeric;
  v_available numeric(20,8);
  v_amount numeric(20,8);
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  if exists (
    select 1 from public.profiles
    where id = v_uid and payout_frozen = true
  ) then
    raise exception 'Withdrawals are paused on this account. Please contact support.';
  end if;

  select numeric_value into v_min_withdrawal
    from public.site_settings where setting_key = 'minimum_withdrawal_usd';
  select numeric_value into v_max_withdrawal
    from public.site_settings where setting_key = 'maximum_withdrawal_usd';

  v_min_withdrawal := coalesce(v_min_withdrawal, 0.01);
  v_max_withdrawal := coalesce(v_max_withdrawal, 10000000);
  v_amount := round(p_amount, 8);

  if v_amount is null
     or v_amount < v_min_withdrawal
     or v_amount > v_max_withdrawal then
    raise exception 'Withdrawal amount must be between % and % USD',
      v_min_withdrawal, v_max_withdrawal;
  end if;

  if p_network is null or p_network not in ('TRC20','ERC20','BEP20') then
    raise exception 'Unsupported network';
  end if;

  if p_destination is null
     or length(p_destination) < 20
     or length(p_destination) > 150 then
    raise exception 'Invalid destination address';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  perform public.zc_settle_gforce_investments();

  v_available := private.zc_available_funds(v_uid);
  if v_amount > v_available then
    raise exception 'Insufficient Available Funds. Available: % USD',
      round(v_available, 2);
  end if;

  insert into public.withdrawal_requests
    (user_id, amount, network, destination_address)
  values
    (v_uid, v_amount, p_network, p_destination)
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function public.request_gforce_withdrawal_v2(
  p_amount numeric,
  p_asset text,
  p_network text,
  p_destination text,
  p_crypto_amount numeric,
  p_usd_price numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_min_withdrawal numeric;
  v_max_withdrawal numeric;
  v_available numeric(20,8);
  v_amount numeric(20,8);
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  if exists (
    select 1 from public.profiles
    where id = v_uid and payout_frozen = true
  ) then
    raise exception 'Withdrawals are paused on this account. Please contact support.';
  end if;

  select numeric_value into v_min_withdrawal
    from public.site_settings where setting_key = 'minimum_withdrawal_usd';
  select numeric_value into v_max_withdrawal
    from public.site_settings where setting_key = 'maximum_withdrawal_usd';

  v_min_withdrawal := coalesce(v_min_withdrawal, 0.01);
  v_max_withdrawal := coalesce(v_max_withdrawal, 10000000);
  v_amount := round(p_amount, 8);

  if v_amount is null
     or v_amount < v_min_withdrawal
     or v_amount > v_max_withdrawal then
    raise exception 'Withdrawal amount must be between % and % USD',
      v_min_withdrawal, v_max_withdrawal;
  end if;

  if p_asset is null or upper(p_asset) not in ('USDT','BTC','ETH','TRX','SOL','DOGE') then
    raise exception 'Unsupported asset';
  end if;

  if p_network is null
     or upper(p_network) not in ('TRC20','ERC20','BEP20','BITCOIN','ETHEREUM','TRON','SOLANA','DOGECOIN') then
    raise exception 'Unsupported network';
  end if;

  if p_crypto_amount is null or p_crypto_amount <= 0
     or p_usd_price is null or p_usd_price <= 0 then
    raise exception 'Invalid conversion quote';
  end if;

  if abs((p_crypto_amount * p_usd_price) - v_amount) > greatest(0.02, v_amount * 0.002) then
    raise exception 'Conversion quote does not match the USD amount';
  end if;

  if p_destination is null
     or length(p_destination) < 20
     or length(p_destination) > 150 then
    raise exception 'Invalid destination address';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  perform public.zc_settle_gforce_investments();

  v_available := private.zc_available_funds(v_uid);
  if v_amount > v_available then
    raise exception 'Insufficient Available Funds. Available: % USD',
      round(v_available, 2);
  end if;

  insert into public.withdrawal_requests
    (user_id, amount, asset, network, destination_address, crypto_amount, usd_price)
  values
    (v_uid, v_amount, upper(p_asset), upper(p_network), p_destination, p_crypto_amount, p_usd_price)
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.request_gforce_withdrawal(numeric,text,text) from public, anon;
grant execute on function public.request_gforce_withdrawal(numeric,text,text) to authenticated;

revoke all on function public.request_gforce_withdrawal_v2(numeric,text,text,text,numeric,numeric) from public, anon;
grant execute on function public.request_gforce_withdrawal_v2(numeric,text,text,text,numeric,numeric) to authenticated;
