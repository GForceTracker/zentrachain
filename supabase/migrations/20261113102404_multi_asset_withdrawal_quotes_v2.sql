alter table public.withdrawal_requests
  add column if not exists crypto_amount numeric(30,12),
  add column if not exists usd_price numeric(30,12);

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
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_balance numeric(20,8);
  v_reserved numeric(20,8);
  v_id uuid;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000 then raise exception 'Invalid USD value'; end if;
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

revoke all on function public.request_gforce_withdrawal_v2(numeric,text,text,text,numeric,numeric) from public;
grant execute on function public.request_gforce_withdrawal_v2(numeric,text,text,text,numeric,numeric) to authenticated;
