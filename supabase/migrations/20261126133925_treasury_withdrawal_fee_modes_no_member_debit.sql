-- Treasury fee modes preserve the member's dashboard balance and deposit totals.
ALTER TABLE public.treasury_withdrawals
  ADD COLUMN IF NOT EXISTS fee_mode text NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS requested_amount_usd numeric DEFAULT 0;
UPDATE public.treasury_withdrawals
  SET requested_amount_usd=amount
  WHERE requested_amount_usd IS NULL OR requested_amount_usd=0;
ALTER TABLE public.treasury_withdrawals
  ALTER COLUMN requested_amount_usd SET NOT NULL;
ALTER TABLE public.treasury_withdrawals
  DROP CONSTRAINT IF EXISTS treasury_withdrawals_fee_mode_check;
ALTER TABLE public.treasury_withdrawals
  ADD CONSTRAINT treasury_withdrawals_fee_mode_check
  CHECK (
    fee_mode IN ('native','coin')
    AND (fee_mode<>'coin' OR (
      upper(asset_code)='USDT'
      AND upper(network_code) IN ('TRC20','ERC20','BEP20')
    ))
  );

CREATE OR REPLACE FUNCTION public.admin_treasury_claim_onchain_withdrawal(p_user_id uuid, p_asset text, p_network text, p_amount numeric, p_deposit_address_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin uuid := auth.uid();
  v_asset text := upper(btrim(coalesce(p_asset, '')));
  v_network text := upper(btrim(coalesce(p_network, '')));
  v_wallet_address text;
  v_deposited numeric := 0;
  v_withdrawn numeric := 0;
  v_reserved numeric := 0;
  v_available numeric := 0;
  v_id uuid;
begin
  if not (select private.is_admin()) then
    raise exception 'Administrator access required';
  end if;
  if p_user_id is null or p_deposit_address_id is null then
    raise exception 'A member and matching deposit wallet are required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Withdrawal USD amount must be greater than zero';
  end if;
  if not exists (
    select 1 from public.crypto_asset_networks n
    where upper(n.asset_code)=v_asset
      and upper(n.network_code)=v_network
      and n.is_enabled=true
  ) then
    raise exception 'This asset and network are not enabled';
  end if;

  select a.address into v_wallet_address
  from public.user_deposit_addresses a
  where a.id=p_deposit_address_id
    and a.user_id=p_user_id
    and upper(a.asset_code)=v_asset
    and upper(a.network_code)=v_network
    and coalesce(a.address_status,'active')='active'
  limit 1;
  if nullif(v_wallet_address,'') is null then
    raise exception 'The selected source deposit wallet is not active or does not match this asset and network';
  end if;

  -- Serialize sends from the same derived address, including token/native
  -- pairs that share an EVM or TRON key.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('treasury-wallet:' || v_wallet_address, 0)
  );
  -- Also serialize by member + asset + network, so different deposit addresses
  -- cannot reserve more than the same member's verified available USD balance.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || v_asset || ':' || v_network, 0)
  );

  update public.treasury_withdrawal_reservations
    set status='expired'
  where wallet_address=v_wallet_address
    and status='pending'
    and broadcast_attempted=false
    and expires_at <= now();

  if exists (
    select 1 from public.treasury_withdrawal_reservations r
    where r.wallet_address=v_wallet_address
      and r.status='pending'
      and (r.expires_at > now() or r.broadcast_attempted)
  ) then
    raise exception 'A withdrawal from this deposit wallet is already processing. Wait for it to finish before sending another.';
  end if;

  -- deposit_requests.amount is the USD value that was actually credited.
  -- blockchain_deposits confirms the real asset/network that funded it.
  select coalesce(sum(dr.amount),0)
    into v_deposited
  from public.deposit_requests dr
  join public.blockchain_deposits bd on bd.id=dr.blockchain_deposit_id
  where dr.user_id=p_user_id
    and dr.status='credited'
    and dr.blockchain_deposit_id is not null
    and upper(dr.asset)='USDT'
    and upper(dr.network)=v_network
    and bd.user_id=p_user_id
    and bd.deposit_status='credited'
    and upper(bd.asset_code)=v_asset
    and upper(bd.network_code)=v_network;

  select coalesce(sum(tw.amount + coalesce(tw.gas_fee,0)),0)
    into v_withdrawn
  from public.treasury_withdrawals tw
  where tw.user_id=p_user_id
    and upper(tw.asset_code)=v_asset
    and upper(tw.network_code)=v_network
    and lower(coalesce(tw.status,''))='sent'
    and nullif(btrim(coalesce(tw.tx_hash,'')),'') is not null;

  select coalesce(sum(r.amount_usd),0)
    into v_reserved
  from public.treasury_withdrawal_reservations r
  where r.user_id=p_user_id
    and upper(r.asset_code)=v_asset
    and upper(r.network_code)=v_network
    and r.status='pending'
    and (r.expires_at > now() or r.broadcast_attempted);

  v_available := greatest(0,v_deposited-v_withdrawn-v_reserved);
  if round(p_amount,6) > v_available + 0.000001 then
    raise exception 'Insufficient verified on-chain deposit funds. Remaining after pending reservations: % USD', round(v_available,6);
  end if;

  insert into public.treasury_withdrawal_reservations
    (user_id,asset_code,network_code,wallet_address,amount_usd,created_by,status)
  values
    (p_user_id,v_asset,v_network,v_wallet_address,round(p_amount,6),v_admin,'pending')
  returning id into v_id;
  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_treasury_record_onchain_withdrawal(p_user_id uuid, p_asset text, p_network text, p_amount numeric, p_crypto_amount numeric, p_gas_fee numeric, p_network_fee_native numeric, p_network_fee_asset text, p_destination text, p_note text, p_tx_hash text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin uuid := auth.uid();
  v_asset text := upper(btrim(coalesce(p_asset, '')));
  v_network text := upper(btrim(coalesce(p_network, '')));
  v_destination text := btrim(coalesce(p_destination, ''));
  v_tx_hash text := btrim(coalesce(p_tx_hash, ''));
  v_deposited numeric := 0;
  v_withdrawn numeric := 0;
  v_available numeric := 0;
  v_id uuid;
  v_existing_user uuid;
  v_existing_destination text;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_user_id is null then raise exception 'Choose the member to withdraw from'; end if;
  if not exists (
    select 1 from public.crypto_asset_networks n
    where upper(n.asset_code)=v_asset and upper(n.network_code)=v_network and n.is_enabled=true
  ) then raise exception 'This asset and network are not enabled for deposits'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Withdrawal USD amount must be greater than zero'; end if;
  if p_crypto_amount is null or p_crypto_amount<=0 then raise exception 'Broadcast coin amount must be greater than zero'; end if;
  
  if p_gas_fee is null or p_gas_fee<0 then raise exception 'Same-asset network fee USD value must not be negative'; end if;
  if round(coalesce(p_gas_fee,0),6)>0 and upper(btrim(coalesce(p_network_fee_asset,'')))<>v_asset then
    raise exception 'A native-asset fee can only be included in the member debit when the fee asset matches the withdrawn asset';
  end if;

  if p_network_fee_native is null or p_network_fee_native<0 then raise exception 'A valid network fee is required'; end if;
  if nullif(btrim(coalesce(p_network_fee_asset,'')),'') is null then raise exception 'Network fee asset is required'; end if;

  if v_network in ('ERC20','BEP20','ETHEREUM') then
    if v_destination !~ '^0x[0-9a-fA-F]{40}$' then raise exception 'Enter a valid EVM destination address'; end if;
  elsif v_network in ('TRC20','TRON') then
    if v_destination !~ '^T[1-9A-HJ-NP-Za-km-z]{33}$' then raise exception 'Enter a valid TRON destination address'; end if;
  elsif v_network='BITCOIN' then
    if v_destination !~ '^(bc1[a-z0-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$' then raise exception 'Enter a valid Bitcoin destination address'; end if;
  elsif v_network='DOGECOIN' then
    if v_destination !~ '^D[a-km-zA-HJ-NP-Z1-9]{25,34}$' then raise exception 'Enter a valid Dogecoin destination address'; end if;
  elsif v_network='SOLANA' then
    if v_destination !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then raise exception 'Enter a valid Solana destination address'; end if;
  else
    raise exception 'Unsupported destination network';
  end if;

  if v_network='SOLANA' then
    if v_tx_hash !~ '^[1-9A-HJ-NP-Za-km-z]{80,90}$' then raise exception 'A valid Solana transaction signature is required'; end if;
  elsif v_network in ('ERC20','BEP20','ETHEREUM') then
    if v_tx_hash !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'A valid EVM transaction hash is required'; end if;
  else
    if v_tx_hash !~ '^[0-9a-fA-F]{64}$' then raise exception 'A valid transaction hash is required'; end if;
  end if;

  -- Lock transaction identity globally, then lock this member's exact on-chain balance.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('treasury-tx:' || v_network || ':' ||
      case when v_network='SOLANA' then v_tx_hash else lower(v_tx_hash) end, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || v_asset || ':' || v_network, 0)
  );

  select user_id,destination_address,id into v_existing_user,v_existing_destination,v_id
  from public.treasury_withdrawals
  where network_code=v_network
    and (case when v_network='SOLANA' then tx_hash=v_tx_hash else lower(tx_hash)=lower(v_tx_hash) end)
  limit 1;
  if found then
    if v_existing_user is distinct from p_user_id or 
      (case
        when v_network in ('ERC20','BEP20','ETHEREUM')
          then lower(btrim(coalesce(v_existing_destination,'')))<>lower(v_destination)
        else btrim(coalesce(v_existing_destination,''))<>v_destination
      end)
 then
      raise exception 'This transaction hash is already recorded against another withdrawal';
    end if;
    return v_id;
  end if;

  select coalesce(sum(dr.amount),0) into v_deposited
  from public.deposit_requests dr
  join public.blockchain_deposits bd on bd.id=dr.blockchain_deposit_id
  where dr.user_id=p_user_id and dr.status='credited'
    and dr.blockchain_deposit_id is not null
    and upper(dr.asset)='USDT' and upper(dr.network)=v_network
    and bd.user_id=p_user_id and bd.deposit_status='credited'
    and upper(bd.asset_code)=v_asset and upper(bd.network_code)=v_network;

  select coalesce(sum(tw.amount + coalesce(tw.gas_fee,0)),0) into v_withdrawn
  from public.treasury_withdrawals tw
  where tw.user_id=p_user_id and upper(tw.asset_code)=v_asset
    and upper(tw.network_code)=v_network and lower(coalesce(tw.status,''))='sent'
    and nullif(btrim(coalesce(tw.tx_hash,'')),'') is not null;

  v_available:=greatest(0,v_deposited-v_withdrawn);
  if round(p_amount,6)>v_available+0.000001 then
    raise exception 'Insufficient verified on-chain deposit funds. Remaining: % USD',round(v_available,2);
  end if;

  insert into public.treasury_withdrawals
    (asset_code,network_code,amount,crypto_amount,gas_fee,network_fee_native,network_fee_asset,
     destination_address,tx_hash,note,user_id,created_by,status)
  values
    (v_asset,v_network,round(p_amount,6),p_crypto_amount,round(coalesce(p_gas_fee,0),6),p_network_fee_native,
     upper(btrim(p_network_fee_asset)),v_destination,v_tx_hash,
     nullif(btrim(coalesce(p_note,'')),''),p_user_id,v_admin,'sent')
  returning id into v_id;

  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(v_admin,'onchain_broadcast','treasury_withdrawal',v_id::text,
    jsonb_build_object('user_id',p_user_id,'asset',v_asset,'network',v_network,
      'amount_usd',round(p_amount,6),'crypto_amount',p_crypto_amount,
      'member_fee_usd',0,'same_asset_network_fee_usd',round(coalesce(p_gas_fee,0),6),'network_fee_native',p_network_fee_native,
      'network_fee_asset',upper(btrim(p_network_fee_asset)),
      'destination',v_destination,'tx_hash',v_tx_hash,
      'verified_onchain_deposits_usd',round(v_deposited,6),
      'prior_onchain_withdrawals_usd',round(v_withdrawn,6),
      'network_gas_paid_from_native_balance',true));
  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_treasury_record_onchain_withdrawal(p_user_id uuid, p_asset text, p_network text, p_amount numeric, p_crypto_amount numeric, p_gas_fee numeric, p_network_fee_native numeric, p_network_fee_asset text, p_destination text, p_note text, p_tx_hash text, p_reservation_id uuid, p_requested_amount_usd numeric, p_fee_mode text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_res public.treasury_withdrawal_reservations%rowtype;
  v_fee_mode text := lower(btrim(coalesce(p_fee_mode,'native')));
  v_id uuid;
BEGIN
  IF NOT (SELECT private.is_admin()) THEN RAISE EXCEPTION 'Administrator access required'; END IF;
  IF v_fee_mode NOT IN ('native','coin') THEN RAISE EXCEPTION 'Choose a valid Treasury network fee payment method'; END IF;
  IF p_requested_amount_usd IS NULL OR p_requested_amount_usd <= 0
     OR round(p_requested_amount_usd,6)+0.000001<round(p_amount,6) THEN
    RAISE EXCEPTION 'Requested USD amount must cover the actual on-chain transfer amount';
  END IF;
  IF v_fee_mode='coin' AND (
    upper(btrim(coalesce(p_asset,'')))<>'USDT'
    OR upper(btrim(coalesce(p_network,''))) NOT IN ('TRC20','ERC20','BEP20')
  ) THEN RAISE EXCEPTION 'Fee deduction from USDT is supported only for USDT TRC20, ERC20 and BEP20'; END IF;
  IF v_fee_mode='native' AND round(p_requested_amount_usd,6)<>round(p_amount,6) THEN
    RAISE EXCEPTION 'Native-fee mode must send the full requested amount';
  END IF;

  SELECT * INTO v_res FROM public.treasury_withdrawal_reservations WHERE id=p_reservation_id FOR UPDATE;
  IF NOT found OR v_res.status<>'pending' OR v_res.broadcast_attempted IS NOT TRUE THEN
    RAISE EXCEPTION 'Treasury withdrawal reservation is missing, was not broadcast, or is no longer active';
  END IF;
  IF v_res.created_by IS DISTINCT FROM v_admin OR v_res.user_id IS DISTINCT FROM p_user_id
    OR upper(v_res.asset_code)<>upper(p_asset) OR upper(v_res.network_code)<>upper(p_network)
    OR round(v_res.amount_usd,6)<>round(p_amount+coalesce(p_gas_fee,0),6) THEN
    RAISE EXCEPTION 'Treasury withdrawal does not match its reserved member, network or USD amount';
  END IF;

  v_id:=public.admin_treasury_record_onchain_withdrawal(
    p_user_id,p_asset,p_network,p_amount,p_crypto_amount,p_gas_fee,
    p_network_fee_native,p_network_fee_asset,p_destination,p_note,p_tx_hash
  );

  UPDATE public.treasury_withdrawals
    SET fee_mode=v_fee_mode,requested_amount_usd=round(p_requested_amount_usd,6)
    WHERE id=v_id;

  UPDATE public.audit_logs
    SET details=coalesce(details,'{}'::jsonb)||jsonb_build_object(
      'requested_amount_usd',round(p_requested_amount_usd,6),
      'amount_usd_sent',round(p_amount,6),'fee_mode',v_fee_mode,
      'member_balance_changed',false,'member_notification_created',false
    )
    WHERE actor_id=v_admin AND action='onchain_broadcast'
      AND entity_type='treasury_withdrawal' AND entity_id=v_id::text;

  UPDATE public.treasury_withdrawal_reservations
    SET status='completed',tx_hash=p_tx_hash,completed_at=now()
    WHERE id=p_reservation_id;
  RETURN v_id;
END;
$function$
;

REVOKE ALL ON FUNCTION public.admin_treasury_record_onchain_withdrawal(uuid,text,text,numeric,numeric,numeric,numeric,text,text,text,text,uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_treasury_record_onchain_withdrawal(uuid,text,text,numeric,numeric,numeric,numeric,text,text,text,text,uuid,numeric,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_treasury_record_onchain_withdrawal(uuid,text,text,numeric,numeric,numeric,numeric,text,text,text,text,uuid,numeric,text) TO authenticated;
