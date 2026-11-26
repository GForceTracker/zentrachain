-- Multi-network automatic treasury withdrawals.
-- The actual amount credited to the member is stored in USD; the blockchain
-- deposit row preserves the real coin and network. Every send is tied to a
-- verified credited deposit and a source deposit wallet.

ALTER TABLE public.treasury_withdrawals
  ADD COLUMN IF NOT EXISTS crypto_amount numeric,
  ADD COLUMN IF NOT EXISTS network_fee_native numeric,
  ADD COLUMN IF NOT EXISTS network_fee_asset text;

CREATE TABLE IF NOT EXISTS public.treasury_withdrawal_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_code text NOT NULL,
  network_code text NOT NULL,
  wallet_address text NOT NULL,
  amount_usd numeric NOT NULL CHECK (amount_usd > 0),
  created_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','released','expired')),
  broadcast_attempted boolean NOT NULL DEFAULT false,
  tx_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  completed_at timestamptz
);

ALTER TABLE public.treasury_withdrawal_reservations
  ADD COLUMN IF NOT EXISTS broadcast_attempted boolean NOT NULL DEFAULT false;

ALTER TABLE public.treasury_withdrawal_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.treasury_withdrawal_reservations FROM public, anon, authenticated;

DROP INDEX IF EXISTS public.treasury_withdrawal_reservations_pending_wallet_uidx;
CREATE UNIQUE INDEX treasury_withdrawal_reservations_pending_wallet_uidx
  ON public.treasury_withdrawal_reservations (wallet_address)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS treasury_withdrawal_reservations_user_asset_network_idx
  ON public.treasury_withdrawal_reservations (user_id, asset_code, network_code, created_at DESC);

CREATE OR REPLACE FUNCTION public.admin_treasury_claim_onchain_withdrawal(
  p_user_id uuid,
  p_asset text,
  p_network text,
  p_amount numeric,
  p_deposit_address_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_asset text := upper(btrim(coalesce(p_asset, '')));
  v_network text := upper(btrim(coalesce(p_network, '')));
  v_wallet_address text;
  v_deposited numeric := 0;
  v_withdrawn numeric := 0;
  v_reserved numeric := 0;
  v_available numeric := 0;
  v_id uuid;
BEGIN
  IF NOT (SELECT private.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;
  IF p_user_id IS NULL OR p_deposit_address_id IS NULL THEN
    RAISE EXCEPTION 'A member and matching deposit wallet are required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Withdrawal USD amount must be greater than zero';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.crypto_asset_networks n
    WHERE upper(n.asset_code)=v_asset
      AND upper(n.network_code)=v_network
      AND n.is_enabled=true
  ) THEN
    RAISE EXCEPTION 'This asset and network are not enabled';
  END IF;

  SELECT a.address INTO v_wallet_address
  FROM public.user_deposit_addresses a
  WHERE a.id=p_deposit_address_id
    AND a.user_id=p_user_id
    AND upper(a.asset_code)=v_asset
    AND upper(a.network_code)=v_network
    AND coalesce(a.address_status,'active')='active'
  LIMIT 1;

  IF nullif(v_wallet_address,'') IS NULL THEN
    RAISE EXCEPTION 'The selected source deposit wallet is not active or does not match this asset and network';
  END IF;

  -- One source address can be shared by several assets/tokens. Serialize by
  -- exact address to prevent concurrent spends from that key.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('treasury-wallet:' || v_wallet_address, 0)
  );
  -- Serialize the member's exact asset/network balance as well.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || v_asset || ':' || v_network, 0)
  );

  UPDATE public.treasury_withdrawal_reservations
    SET status='expired'
  WHERE wallet_address=v_wallet_address
    AND status='pending'
    AND broadcast_attempted=false
    AND expires_at <= now();

  IF EXISTS (
    SELECT 1 FROM public.treasury_withdrawal_reservations r
    WHERE r.wallet_address=v_wallet_address
      AND r.status='pending'
      AND (r.expires_at > now() OR r.broadcast_attempted)
  ) THEN
    RAISE EXCEPTION 'A withdrawal from this deposit wallet is already processing. Wait for it to finish before sending another.';
  END IF;

  -- deposit_requests.amount is the USD amount actually credited; the joined
  -- blockchain_deposits row proves its native asset and precise chain.
  SELECT coalesce(sum(dr.amount),0) INTO v_deposited
  FROM public.deposit_requests dr
  JOIN public.blockchain_deposits bd ON bd.id=dr.blockchain_deposit_id
  WHERE dr.user_id=p_user_id
    AND dr.status='credited'
    AND dr.blockchain_deposit_id IS NOT NULL
    AND upper(dr.asset)='USDT'
    AND upper(dr.network)=v_network
    AND bd.user_id=p_user_id
    AND bd.deposit_status='credited'
    AND upper(bd.asset_code)=v_asset
    AND upper(bd.network_code)=v_network;

  SELECT coalesce(sum(tw.amount),0) INTO v_withdrawn
  FROM public.treasury_withdrawals tw
  WHERE tw.user_id=p_user_id
    AND upper(tw.asset_code)=v_asset
    AND upper(tw.network_code)=v_network
    AND lower(coalesce(tw.status,''))='sent'
    AND nullif(btrim(coalesce(tw.tx_hash,'')),'') IS NOT NULL;

  SELECT coalesce(sum(r.amount_usd),0) INTO v_reserved
  FROM public.treasury_withdrawal_reservations r
  WHERE r.user_id=p_user_id
    AND upper(r.asset_code)=v_asset
    AND upper(r.network_code)=v_network
    AND r.status='pending'
    AND (r.expires_at > now() OR r.broadcast_attempted);

  v_available := greatest(0,v_deposited-v_withdrawn-v_reserved);
  IF round(p_amount,2) > v_available + 0.000001 THEN
    RAISE EXCEPTION 'Insufficient verified on-chain deposit funds. Remaining after pending reservations: % USD', round(v_available,2);
  END IF;

  INSERT INTO public.treasury_withdrawal_reservations
    (user_id,asset_code,network_code,wallet_address,amount_usd,created_by,status)
  VALUES
    (p_user_id,v_asset,v_network,v_wallet_address,round(p_amount,2),v_admin,'pending')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_treasury_release_onchain_withdrawal(p_reservation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_admin uuid := auth.uid();
BEGIN
  IF NOT (SELECT private.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;
  UPDATE public.treasury_withdrawal_reservations
    SET status='released'
  WHERE id=p_reservation_id
    AND created_by=v_admin
    AND status='pending'
    AND broadcast_attempted=false;
  RETURN found;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_treasury_mark_onchain_broadcast_attempt(p_reservation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_admin uuid := auth.uid();
BEGIN
  IF NOT (SELECT private.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;
  UPDATE public.treasury_withdrawal_reservations
    SET broadcast_attempted=true,
        expires_at='9999-12-31 23:59:59+00'::timestamptz
  WHERE id=p_reservation_id
    AND created_by=v_admin
    AND status='pending'
    AND broadcast_attempted=false;
  IF NOT found THEN
    RAISE EXCEPTION 'The treasury reservation is no longer available for a broadcast attempt';
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_treasury_record_onchain_withdrawal(
  p_user_id uuid,
  p_asset text,
  p_network text,
  p_amount numeric,
  p_crypto_amount numeric,
  p_gas_fee numeric,
  p_network_fee_native numeric,
  p_network_fee_asset text,
  p_destination text,
  p_note text,
  p_tx_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
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
BEGIN
  IF NOT (SELECT private.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Choose the member to withdraw from';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.crypto_asset_networks n
    WHERE upper(n.asset_code)=v_asset
      AND upper(n.network_code)=v_network
      AND n.is_enabled=true
  ) THEN
    RAISE EXCEPTION 'This asset and network are not enabled for deposits';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Withdrawal USD amount must be greater than zero';
  END IF;
  IF p_crypto_amount IS NULL OR p_crypto_amount <= 0 THEN
    RAISE EXCEPTION 'Broadcast coin amount must be greater than zero';
  END IF;
  IF coalesce(p_gas_fee,0) <> 0 THEN
    RAISE EXCEPTION 'Network gas must be paid from the sending wallet native balance';
  END IF;
  IF p_network_fee_native IS NULL OR p_network_fee_native < 0 THEN
    RAISE EXCEPTION 'A valid network fee is required';
  END IF;
  IF nullif(btrim(coalesce(p_network_fee_asset,'')), '') IS NULL THEN
    RAISE EXCEPTION 'Network fee asset is required';
  END IF;

  IF v_network IN ('ERC20','BEP20','ETHEREUM') THEN
    IF v_destination !~ '^0x[0-9a-fA-F]{40}$' THEN
      RAISE EXCEPTION 'Enter a valid EVM destination address';
    END IF;
  ELSIF v_network IN ('TRC20','TRON') THEN
    IF v_destination !~ '^T[1-9A-HJ-NP-Za-km-z]{33}$' THEN
      RAISE EXCEPTION 'Enter a valid TRON destination address';
    END IF;
  ELSIF v_network='BITCOIN' THEN
    IF v_destination !~ '^(bc1[a-z0-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$' THEN
      RAISE EXCEPTION 'Enter a valid Bitcoin destination address';
    END IF;
  ELSIF v_network='DOGECOIN' THEN
    IF v_destination !~ '^D[a-km-zA-HJ-NP-Z1-9]{25,34}$' THEN
      RAISE EXCEPTION 'Enter a valid Dogecoin destination address';
    END IF;
  ELSIF v_network='SOLANA' THEN
    IF v_destination !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN
      RAISE EXCEPTION 'Enter a valid Solana destination address';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported destination network';
  END IF;

  IF v_network='SOLANA' THEN
    IF v_tx_hash !~ '^[1-9A-HJ-NP-Za-km-z]{80,90}$' THEN
      RAISE EXCEPTION 'A valid Solana transaction signature is required';
    END IF;
  ELSIF v_network IN ('ERC20','BEP20','ETHEREUM') THEN
    IF v_tx_hash !~ '^0x[0-9a-fA-F]{64}$' THEN
      RAISE EXCEPTION 'A valid EVM transaction hash is required';
    END IF;
  ELSE
    IF v_tx_hash !~ '^[0-9a-fA-F]{64}$' THEN
      RAISE EXCEPTION 'A valid transaction hash is required';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'treasury-tx:' || v_network || ':' ||
      CASE WHEN v_network='SOLANA' THEN v_tx_hash ELSE lower(v_tx_hash) END, 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || v_asset || ':' || v_network, 0)
  );

  SELECT user_id,destination_address,id
    INTO v_existing_user,v_existing_destination,v_id
  FROM public.treasury_withdrawals
  WHERE network_code=v_network
    AND CASE WHEN v_network='SOLANA' THEN tx_hash=v_tx_hash ELSE lower(tx_hash)=lower(v_tx_hash) END
  LIMIT 1;

  IF found THEN
    IF v_existing_user IS DISTINCT FROM p_user_id OR
      (CASE
        WHEN v_network IN ('ERC20','BEP20','ETHEREUM')
          THEN lower(btrim(coalesce(v_existing_destination,'')))<>lower(v_destination)
        ELSE btrim(coalesce(v_existing_destination,''))<>v_destination
      END)
    THEN
      RAISE EXCEPTION 'This transaction hash is already recorded against another withdrawal';
    END IF;
    RETURN v_id;
  END IF;

  SELECT coalesce(sum(dr.amount),0) INTO v_deposited
  FROM public.deposit_requests dr
  JOIN public.blockchain_deposits bd ON bd.id=dr.blockchain_deposit_id
  WHERE dr.user_id=p_user_id
    AND dr.status='credited'
    AND dr.blockchain_deposit_id IS NOT NULL
    AND upper(dr.asset)='USDT'
    AND upper(dr.network)=v_network
    AND bd.user_id=p_user_id
    AND bd.deposit_status='credited'
    AND upper(bd.asset_code)=v_asset
    AND upper(bd.network_code)=v_network;

  SELECT coalesce(sum(tw.amount),0) INTO v_withdrawn
  FROM public.treasury_withdrawals tw
  WHERE tw.user_id=p_user_id
    AND upper(tw.asset_code)=v_asset
    AND upper(tw.network_code)=v_network
    AND lower(coalesce(tw.status,''))='sent'
    AND nullif(btrim(coalesce(tw.tx_hash,'')),'') IS NOT NULL;

  v_available := greatest(0,v_deposited-v_withdrawn);
  IF round(p_amount,2)>v_available+0.000001 THEN
    RAISE EXCEPTION 'Insufficient verified on-chain deposit funds. Remaining: % USD',round(v_available,2);
  END IF;

  INSERT INTO public.treasury_withdrawals
    (asset_code,network_code,amount,crypto_amount,gas_fee,network_fee_native,network_fee_asset,
     destination_address,tx_hash,note,user_id,created_by,status)
  VALUES
    (v_asset,v_network,round(p_amount,2),p_crypto_amount,0,p_network_fee_native,
     upper(btrim(p_network_fee_asset)),v_destination,v_tx_hash,
     nullif(btrim(coalesce(p_note,'')),''),p_user_id,v_admin,'sent')
  RETURNING id INTO v_id;

  INSERT INTO public.ledger_entries(user_id,amount,entry_type,description,reference_type,reference_id)
  VALUES(p_user_id,-round(p_amount,2),'withdrawal',
    'Treasury on-chain withdrawal '||v_asset||' · '||v_network||' · tx '||v_tx_hash,
    'treasury_withdrawal',v_id);

  INSERT INTO public.audit_logs(actor_id,action,entity_type,entity_id,details)
  VALUES(v_admin,'onchain_broadcast','treasury_withdrawal',v_id::text,
    jsonb_build_object(
      'user_id',p_user_id,'asset',v_asset,'network',v_network,
      'amount_usd',round(p_amount,2),'crypto_amount',p_crypto_amount,
      'member_fee_usd',0,'network_fee_native',p_network_fee_native,
      'network_fee_asset',upper(btrim(p_network_fee_asset)),
      'destination',v_destination,'tx_hash',v_tx_hash,
      'verified_onchain_deposits_usd',round(v_deposited,6),
      'prior_onchain_withdrawals_usd',round(v_withdrawn,6),
      'network_gas_paid_from_native_balance',true
    )
  );
  RETURN v_id;
END;
$function$;

-- This overload is retained only for internal backwards compatibility. It is
-- not executable by authenticated clients and can never be used by the UI.
CREATE OR REPLACE FUNCTION public.admin_treasury_record_onchain_withdrawal(
  p_user_id uuid,
  p_asset text,
  p_network text,
  p_amount numeric,
  p_gas_fee numeric,
  p_destination text,
  p_note text,
  p_tx_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF upper(btrim(coalesce(p_asset,''))) <> 'USDT'
     OR upper(btrim(coalesce(p_network,''))) NOT IN ('TRC20','ERC20','BEP20') THEN
    RAISE EXCEPTION 'This legacy withdrawal method only supports USDT TRC20, ERC20 and BEP20';
  END IF;
  RETURN public.admin_treasury_record_onchain_withdrawal(
    p_user_id,p_asset,p_network,p_amount,p_amount,p_gas_fee,0,
    CASE upper(btrim(coalesce(p_network,'')))
      WHEN 'TRC20' THEN 'TRX'
      WHEN 'ERC20' THEN 'ETH'
      WHEN 'BEP20' THEN 'BNB'
      ELSE 'USDT'
    END,
    p_destination,p_note,p_tx_hash
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_treasury_record_onchain_withdrawal(
  p_user_id uuid,
  p_asset text,
  p_network text,
  p_amount numeric,
  p_crypto_amount numeric,
  p_gas_fee numeric,
  p_network_fee_native numeric,
  p_network_fee_asset text,
  p_destination text,
  p_note text,
  p_tx_hash text,
  p_reservation_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_res public.treasury_withdrawal_reservations%rowtype;
  v_id uuid;
BEGIN
  IF NOT (SELECT private.is_admin()) THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;

  SELECT * INTO v_res
  FROM public.treasury_withdrawal_reservations
  WHERE id=p_reservation_id
  FOR UPDATE;

  IF NOT found OR v_res.status<>'pending' THEN
    RAISE EXCEPTION 'Treasury withdrawal reservation is missing or no longer active';
  END IF;
  IF v_res.created_by IS DISTINCT FROM v_admin
    OR v_res.user_id IS DISTINCT FROM p_user_id
    OR upper(v_res.asset_code)<>upper(p_asset)
    OR upper(v_res.network_code)<>upper(p_network)
    OR round(v_res.amount_usd,2)<>round(p_amount,2)
  THEN
    RAISE EXCEPTION 'Treasury withdrawal does not match its reserved member, network or USD amount';
  END IF;
  IF NOT v_res.broadcast_attempted AND v_res.expires_at<=now() THEN
    RAISE EXCEPTION 'Treasury withdrawal reservation expired before accounting was completed';
  END IF;

  v_id:=public.admin_treasury_record_onchain_withdrawal(
    p_user_id,p_asset,p_network,p_amount,p_crypto_amount,p_gas_fee,
    p_network_fee_native,p_network_fee_asset,p_destination,p_note,p_tx_hash
  );

  UPDATE public.treasury_withdrawal_reservations
    SET status='completed',tx_hash=p_tx_hash,completed_at=now()
  WHERE id=p_reservation_id;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_treasury_claim_onchain_withdrawal(uuid,text,text,numeric,uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_treasury_claim_onchain_withdrawal(uuid,text,text,numeric,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_treasury_release_onchain_withdrawal(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_treasury_release_onchain_withdrawal(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_treasury_mark_onchain_broadcast_attempt(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_treasury_mark_onchain_broadcast_attempt(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_treasury_record_onchain_withdrawal(uuid,text,text,numeric,numeric,numeric,numeric,text,text,text,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_treasury_record_onchain_withdrawal(uuid,text,text,numeric,numeric,text,text,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_treasury_record_onchain_withdrawal(uuid,text,text,numeric,numeric,numeric,numeric,text,text,text,text,uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_treasury_record_onchain_withdrawal(uuid,text,text,numeric,numeric,numeric,numeric,text,text,text,text,uuid) TO authenticated;
