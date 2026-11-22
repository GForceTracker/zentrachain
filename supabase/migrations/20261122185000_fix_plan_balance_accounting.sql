-- Keep plan principal in exactly one balance source and reserve legacy deposit-backed plans.
-- A user_investments row linked to a negative investment ledger entry has already
-- been deducted from the user's ledger balance. Only positive deposit-backed
-- investments need to be subtracted as locked principal.

create or replace function public.purchase_gforce_plan(p_plan_id uuid, p_amount numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plan public.gforce_investment_plans%rowtype;
  v_balance numeric;
  v_reserved numeric;
  v_locked numeric;
  v_led uuid;
  v_inv uuid;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select * into v_plan from public.gforce_investment_plans where id = p_plan_id for update;
  if not found or v_plan.is_active = false then raise exception 'This plan is not available'; end if;
  if p_amount is null or p_amount < v_plan.min_amount or p_amount > v_plan.max_amount then
    raise exception 'Amount must be between % and % USD', v_plan.min_amount, v_plan.max_amount;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  -- Release matured plans before checking the balance available for a new purchase.
  perform public.zc_settle_gforce_investments();

  select coalesce(sum(amount),0) into v_balance
    from public.ledger_entries where user_id = v_uid;
  select coalesce(sum(amount),0) into v_reserved
    from public.withdrawal_requests
    where user_id = v_uid and status in ('pending','under_review','approved');
  select coalesce(sum(ui.amount), 0)
    into v_locked
    from public.user_investments ui
    left join public.ledger_entries le
      on le.id = ui.ledger_entry_id
     and le.user_id = v_uid
    where ui.user_id = v_uid
      and ui.status = 'active'
      and (ui.ends_at is null or ui.ends_at > now())
      and not coalesce(le.amount < 0, false);

  if p_amount > v_balance - v_reserved - v_locked then
    raise exception 'Not enough balance. Fund your account to continue.';
  end if;

  insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type)
  values (v_uid, -round(p_amount, 8), 'investment', 'Plan purchase: ' || v_plan.name, 'plan_purchase')
  returning id into v_led;

  insert into public.user_investments (user_id, ledger_entry_id, plan_id, amount, rate, status, starts_at, ends_at, note)
  values (
    v_uid, v_led, v_plan.id, round(p_amount, 8), v_plan.percentage, 'active', now(),
    case
      when lower(v_plan.duration_unit) = 'hours' then now() + (v_plan.duration_value || ' hours')::interval
      else now() + (v_plan.duration_value || ' days')::interval
    end,
    'Plan purchase: ' || v_plan.name
  )
  returning id into v_inv;

  update public.ledger_entries set reference_id = v_inv where id = v_led;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (v_uid, 'plan_purchased', 'user_investment', v_inv,
          jsonb_build_object('plan_id', p_plan_id, 'plan_name', v_plan.name, 'amount', p_amount, 'rate', v_plan.percentage));

  return v_inv;
end;
$$;

revoke all on function public.purchase_gforce_plan(uuid, numeric) from public, anon;
grant execute on function public.purchase_gforce_plan(uuid, numeric) to authenticated;

-- Legacy deposit-backed investments retain principal in their original positive
-- deposit ledger row, so maturity must credit profit only. Direct plan purchases
-- already have a negative investment ledger entry, so maturity returns principal
-- plus profit.
create or replace function public.zc_settle_gforce_investments()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.user_investments%rowtype;
  v_source_type text;
  v_source_amount numeric;
  v_payout numeric;
  v_count integer := 0;
begin
  if v_uid is null then
    return 0;
  end if;

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

    if coalesce(v_source_amount, 0) > 0 then
      v_payout := round(v_row.amount * coalesce(v_row.rate, 0) / 100.0, 8);
    else
      v_payout := round(v_row.amount + v_row.amount * coalesce(v_row.rate, 0) / 100.0, 8);
    end if;

    if v_payout > 0 then
      insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type, reference_id)
      values (v_uid, v_payout, 'plan_maturity',
              'Plan completed — principal and profit credited to available balance',
              'plan_maturity', v_row.id);
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.zc_settle_gforce_investments() from public, anon;
grant execute on function public.zc_settle_gforce_investments() to authenticated;

-- Withdrawal RPCs apply the same legacy lock rule. Manually purchased plan
-- principal is already absent from ledger balance and is not deducted twice.

create or replace function public.request_gforce_withdrawal(
  p_amount numeric,
  p_network text,
  p_destination text
) returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_balance numeric(20,8);
  v_reserved numeric(20,8);
  v_locked numeric(20,8);
  v_id uuid;
  v_min_withdrawal numeric;
  v_max_withdrawal numeric;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if exists (select 1 from public.profiles where id = v_uid and payout_frozen = true) then
    raise exception 'Withdrawals are paused on this account. Please contact support.';
  end if;

  select numeric_value into v_min_withdrawal
    from public.site_settings where setting_key='minimum_withdrawal_usd';
  select numeric_value into v_max_withdrawal
    from public.site_settings where setting_key='maximum_withdrawal_usd';
  v_min_withdrawal := coalesce(v_min_withdrawal,0.01);
  v_max_withdrawal := coalesce(v_max_withdrawal,10000000);

  if p_amount is null or p_amount < v_min_withdrawal or p_amount > v_max_withdrawal then
    raise exception 'Withdrawal amount must be between % and % USD', v_min_withdrawal, v_max_withdrawal;
  end if;
  if p_network not in ('TRC20','ERC20','BEP20') then raise exception 'Unsupported network'; end if;
  if length(p_destination) < 20 or length(p_destination) > 150 then raise exception 'Invalid destination address'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  perform public.zc_settle_gforce_investments();
  select coalesce(sum(amount),0) into v_balance from public.ledger_entries where user_id = v_uid;
  select coalesce(sum(amount),0) into v_reserved from public.withdrawal_requests
    where user_id = v_uid and status in ('pending','under_review','approved');
  select coalesce(sum(ui.amount), 0)
    into v_locked
    from public.user_investments ui
    left join public.ledger_entries le
      on le.id = ui.ledger_entry_id
     and le.user_id = v_uid
    where ui.user_id = v_uid
      and ui.status = 'active'
      and (ui.ends_at is null or ui.ends_at > now())
      and not coalesce(le.amount < 0, false);

  if p_amount > v_balance - v_reserved - v_locked then
    raise exception 'Insufficient available balance';
  end if;

  insert into public.withdrawal_requests(user_id, amount, network, destination_address)
  values (v_uid, p_amount, p_network, p_destination)
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
) returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_balance numeric(20,8);
  v_reserved numeric(20,8);
  v_locked numeric(20,8);
  v_id uuid;
  v_min_withdrawal numeric;
  v_max_withdrawal numeric;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if exists (select 1 from public.profiles where id = v_uid and payout_frozen = true) then
    raise exception 'Withdrawals are paused on this account. Please contact support.';
  end if;

  select numeric_value into v_min_withdrawal
    from public.site_settings where setting_key='minimum_withdrawal_usd';
  select numeric_value into v_max_withdrawal
    from public.site_settings where setting_key='maximum_withdrawal_usd';
  v_min_withdrawal := coalesce(v_min_withdrawal,0.01);
  v_max_withdrawal := coalesce(v_max_withdrawal,10000000);

  if p_amount is null or p_amount < v_min_withdrawal or p_amount > v_max_withdrawal then
    raise exception 'Withdrawal amount must be between % and % USD', v_min_withdrawal, v_max_withdrawal;
  end if;
  if upper(p_asset) not in ('USDT','BTC','ETH','TRX','SOL','DOGE') then raise exception 'Unsupported asset'; end if;
  if upper(p_network) not in ('TRC20','ERC20','BEP20','BITCOIN','ETHEREUM','TRON','SOLANA','DOGECOIN') then raise exception 'Unsupported network'; end if;
  if p_crypto_amount is null or p_crypto_amount <= 0 or p_usd_price is null or p_usd_price <= 0 then
    raise exception 'Invalid conversion quote';
  end if;
  if abs((p_crypto_amount * p_usd_price) - p_amount) > greatest(0.02, p_amount * 0.002) then
    raise exception 'Conversion quote does not match the USD amount';
  end if;
  if length(p_destination) < 20 or length(p_destination) > 150 then raise exception 'Invalid destination address'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  perform public.zc_settle_gforce_investments();
  select coalesce(sum(amount),0) into v_balance from public.ledger_entries where user_id = v_uid;
  select coalesce(sum(amount),0) into v_reserved from public.withdrawal_requests
    where user_id = v_uid and status in ('pending','under_review','approved');
  select coalesce(sum(ui.amount), 0)
    into v_locked
    from public.user_investments ui
    left join public.ledger_entries le
      on le.id = ui.ledger_entry_id
     and le.user_id = v_uid
    where ui.user_id = v_uid
      and ui.status = 'active'
      and (ui.ends_at is null or ui.ends_at > now())
      and not coalesce(le.amount < 0, false);

  if p_amount > v_balance - v_reserved - v_locked then
    raise exception 'Insufficient available balance';
  end if;

  insert into public.withdrawal_requests(user_id,amount,asset,network,destination_address,crypto_amount,usd_price)
  values(v_uid,round(p_amount,8),upper(p_asset),upper(p_network),p_destination,p_crypto_amount,p_usd_price)
  returning id into v_id;
  return v_id;
end;
$function$;

revoke all on function public.request_gforce_withdrawal(numeric,text,text) from public, anon;
grant execute on function public.request_gforce_withdrawal(numeric,text,text) to authenticated;
revoke all on function public.request_gforce_withdrawal_v2(numeric,text,text,text,numeric,numeric) from public, anon;
grant execute on function public.request_gforce_withdrawal_v2(numeric,text,text,text,numeric,numeric) to authenticated;
