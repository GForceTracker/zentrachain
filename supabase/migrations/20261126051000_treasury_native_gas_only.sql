
-- The user's USDT balance is reduced by USDT principal only. Network gas is
-- paid from the deposit wallet's native token (BNB / ETH / TRX).
CREATE OR REPLACE FUNCTION public.admin_treasury_record_onchain_withdrawal(
  p_user_id uuid, p_asset text, p_network text, p_amount numeric,
  p_gas_fee numeric, p_destination text, p_note text, p_tx_hash text
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
  v_tx_hash text := lower(btrim(coalesce(p_tx_hash, '')));
  v_deposited numeric := 0;
  v_withdrawn numeric := 0;
  v_available numeric := 0;
  v_id uuid;
  v_existing_user uuid;
  v_existing_destination text;
BEGIN
  IF NOT (SELECT private.is_admin()) THEN RAISE EXCEPTION 'Administrator access required'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'Choose the member to withdraw from'; END IF;
  IF v_asset <> 'USDT' OR v_network NOT IN ('TRC20', 'ERC20', 'BEP20') THEN
    RAISE EXCEPTION 'On-chain treasury withdrawals are currently enabled for USDT on TRC20, ERC20 and BEP20 only';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Withdrawal amount must be greater than zero'; END IF;
  IF p_gas_fee IS NULL OR p_gas_fee <> 0 THEN
    RAISE EXCEPTION 'Network gas is paid from the wallet native balance and must not be deducted from the member USDT balance';
  END IF;
  IF v_tx_hash !~ '^(0x)?[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A valid broadcast transaction hash is required'; END IF;
  IF v_network IN ('ERC20', 'BEP20') AND v_destination !~ '^0x[0-9a-fA-F]{40}$' THEN
    RAISE EXCEPTION 'Enter a valid EVM destination address';
  END IF;
  IF v_network = 'TRC20' AND v_destination !~ '^T[1-9A-HJ-NP-Za-km-z]{33}$' THEN
    RAISE EXCEPTION 'Enter a valid TRON destination address';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || v_asset || ':' || v_network, 0)
  );

  SELECT user_id, destination_address, id INTO v_existing_user, v_existing_destination, v_id
  FROM public.treasury_withdrawals
  WHERE network_code = v_network AND lower(tx_hash) = v_tx_hash LIMIT 1;
  IF FOUND THEN
    IF v_existing_user IS DISTINCT FROM p_user_id
       OR lower(btrim(coalesce(v_existing_destination, ''))) <> lower(v_destination) THEN
      RAISE EXCEPTION 'This transaction hash is already recorded against another withdrawal';
    END IF;
    RETURN v_id;
  END IF;

  SELECT coalesce(sum(dr.amount), 0) INTO v_deposited
  FROM public.deposit_requests AS dr
  JOIN public.blockchain_deposits AS bd ON bd.id = dr.blockchain_deposit_id
  WHERE dr.user_id = p_user_id AND dr.status = 'credited'
    AND bd.user_id = p_user_id AND bd.deposit_status = 'credited'
    AND upper(bd.asset_code) = v_asset AND upper(bd.network_code) = v_network;

  SELECT coalesce(sum(tw.amount), 0) INTO v_withdrawn
  FROM public.treasury_withdrawals AS tw
  WHERE tw.user_id = p_user_id AND upper(tw.asset_code) = v_asset
    AND upper(tw.network_code) = v_network AND lower(coalesce(tw.status, '')) = 'sent'
    AND nullif(btrim(coalesce(tw.tx_hash, '')), '') IS NOT NULL;

  v_available := greatest(0, v_deposited - v_withdrawn);
  IF round(p_amount, 2) > v_available + 0.000001 THEN
    RAISE EXCEPTION 'Insufficient verified on-chain deposit funds. Remaining: % USD', round(v_available, 2);
  END IF;

  INSERT INTO public.treasury_withdrawals
    (asset_code, network_code, amount, gas_fee, destination_address, tx_hash, note, user_id, created_by, status)
  VALUES
    (v_asset, v_network, round(p_amount, 2), 0, v_destination,
     v_tx_hash, nullif(btrim(coalesce(p_note, '')), ''), p_user_id, v_admin, 'sent')
  RETURNING id INTO v_id;

  INSERT INTO public.ledger_entries
    (user_id, amount, entry_type, description, reference_type, reference_id)
  VALUES
    (p_user_id, -round(p_amount, 2), 'withdrawal',
     'Treasury on-chain withdrawal ' || v_network || ' · tx ' || v_tx_hash,
     'treasury_withdrawal', v_id);

  INSERT INTO public.audit_logs(actor_id, action, entity_type, entity_id, details)
  VALUES (v_admin, 'onchain_broadcast', 'treasury_withdrawal', v_id::text,
    jsonb_build_object('user_id', p_user_id, 'asset', v_asset, 'network', v_network,
      'amount_usd', round(p_amount, 2), 'member_fee_usd', 0,
      'destination', v_destination, 'tx_hash', v_tx_hash,
      'verified_onchain_deposits_usd', round(v_deposited, 6),
      'prior_onchain_withdrawals_usd', round(v_withdrawn, 6)));
  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_treasury_record_onchain_withdrawal(uuid, text, text, numeric, numeric, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_treasury_record_onchain_withdrawal(uuid, text, text, numeric, numeric, text, text, text)
  TO authenticated;
NOTIFY pgrst, 'reload schema';
