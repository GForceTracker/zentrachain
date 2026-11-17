-- Add editable withdrawal limits and enforce them in both withdrawal request RPCs.
-- Defaults preserve the existing $10,000,000 upper bound and allow small withdrawals.
insert into public.site_settings(setting_key,numeric_value,updated_at,updated_by)
values
 ('minimum_withdrawal_usd',0.01,now(),null),
 ('maximum_withdrawal_usd',10000000,now(),null)
on conflict (setting_key) do nothing;

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
  v_id uuid;
  v_min_withdrawal numeric;
  v_max_withdrawal numeric;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  select numeric_value into v_min_withdrawal
  from public.site_settings where setting_key='minimum_withdrawal_usd';
  select numeric_value into v_max_withdrawal
  from public.site_settings where setting_key='maximum_withdrawal_usd';

  v_min_withdrawal := coalesce(v_min_withdrawal,0.01);
  v_max_withdrawal := coalesce(v_max_withdrawal,10000000);

  if p_amount is null or p_amount < v_min_withdrawal or p_amount > v_max_withdrawal
    then raise exception 'Withdrawal amount must be between % and % USD', v_min_withdrawal, v_max_withdrawal;
  end if;
  if p_network not in ('TRC20','ERC20','BEP20') then raise exception 'Unsupported network'; end if;
  if length(p_destination) < 20 or length(p_destination) > 150 then raise exception 'Invalid destination address'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  select coalesce(sum(amount),0) into v_balance from public.ledger_entries where user_id = v_uid;
  select coalesce(sum(amount),0) into v_reserved from public.withdrawal_requests
    where user_id = v_uid and status in ('pending','under_review','approved');
  if p_amount > v_balance - v_reserved then raise exception 'Insufficient available balance'; end if;

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
  v_id uuid;
  v_min_withdrawal numeric;
  v_max_withdrawal numeric;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  select numeric_value into v_min_withdrawal
  from public.site_settings where setting_key='minimum_withdrawal_usd';
  select numeric_value into v_max_withdrawal
  from public.site_settings where setting_key='maximum_withdrawal_usd';

  v_min_withdrawal := coalesce(v_min_withdrawal,0.01);
  v_max_withdrawal := coalesce(v_max_withdrawal,10000000);

  if p_amount is null or p_amount < v_min_withdrawal or p_amount > v_max_withdrawal
    then raise exception 'Withdrawal amount must be between % and % USD', v_min_withdrawal, v_max_withdrawal;
  end if;
  if upper(p_asset) not in ('USDT','BTC','ETH','TRX','SOL','DOGE') then raise exception 'Unsupported asset'; end if;
  if upper(p_network) not in ('TRC20','ERC20','BEP20','BITCOIN','ETHEREUM','TRON','SOLANA','DOGECOIN') then raise exception 'Unsupported network'; end if;
  if p_crypto_amount is null or p_crypto_amount <= 0 or p_usd_price is null or p_usd_price <= 0 then raise exception 'Invalid conversion quote'; end if;
  if abs((p_crypto_amount * p_usd_price) - p_amount) > greatest(0.02, p_amount * 0.002) then raise exception 'Conversion quote does not match the USD amount'; end if;
  if length(p_destination) < 20 or length(p_destination) > 150 then raise exception 'Invalid destination address'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  select coalesce(sum(amount),0) into v_balance from public.ledger_entries where user_id = v_uid;
  select coalesce(sum(amount),0) into v_reserved from public.withdrawal_requests
    where user_id = v_uid and status in ('pending','under_review','approved');
  if p_amount > v_balance - v_reserved then raise exception 'Insufficient available balance'; end if;

  insert into public.withdrawal_requests(user_id,amount,asset,network,destination_address,crypto_amount,usd_price)
  values(v_uid,round(p_amount,8),upper(p_asset),upper(p_network),p_destination,p_crypto_amount,p_usd_price)
  returning id into v_id;
  return v_id;
end;
$function$;
