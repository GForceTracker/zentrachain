-- ZentraChain: automatic, unattended deposit scanning and ledger crediting.
-- The scanner secret is generated once and remains encrypted inside Supabase Vault.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net;

GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;
GRANT USAGE ON SCHEMA net TO postgres;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'zc_monitor_cron_secret'
  ) THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'zc_monitor_cron_secret',
      'Private authentication credential for scheduled ZentraChain deposit monitoring'
    );
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS private.zc_deposit_monitor_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_offset integer NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO private.zc_deposit_monitor_state (id, next_offset)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;
REVOKE ALL ON TABLE private.zc_deposit_monitor_state FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.next_zc_deposit_monitor_batch(p_limit integer DEFAULT 6)
RETURNS SETOF public.user_deposit_addresses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_total integer;
  v_offset integer;
  v_limit integer := greatest(1, least(coalesce(p_limit, 6), 10));
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('zc_deposit_monitor_batch', 0));

  INSERT INTO private.zc_deposit_monitor_state (id, next_offset)
  VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;

  SELECT count(*)::integer INTO v_total
  FROM public.user_deposit_addresses
  WHERE address_status = 'active';

  IF v_total <= 0 THEN RETURN; END IF;

  SELECT next_offset INTO v_offset
  FROM private.zc_deposit_monitor_state WHERE id = 1 FOR UPDATE;

  v_offset := coalesce(v_offset, 0) % v_total;

  UPDATE private.zc_deposit_monitor_state
  SET next_offset = (v_offset + v_limit) % v_total,
      updated_at = pg_catalog.now()
  WHERE id = 1;

  RETURN QUERY
  WITH ranked AS (
    SELECT a.*, pg_catalog.row_number() OVER (ORDER BY a.created_at, a.id)::integer AS rn
    FROM public.user_deposit_addresses AS a
    WHERE a.address_status = 'active'
  )
  SELECT
    r.id, r.user_id, r.asset_network_id, r.asset_code, r.network_code,
    r.address, r.derivation_index, r.derivation_path, r.address_status, r.created_at
  FROM ranked AS r
  WHERE ((r.rn - 1 - v_offset + v_total) % v_total) < v_limit
  ORDER BY ((r.rn - 1 - v_offset + v_total) % v_total);
END;
$function$;

REVOKE ALL ON FUNCTION public.next_zc_deposit_monitor_batch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_zc_deposit_monitor_batch(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.verify_zc_monitor_cron_secret(p_secret text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT coalesce(
    p_secret IS NOT NULL AND p_secret <> ''
    AND EXISTS (
      SELECT 1 FROM vault.decrypted_secrets AS s
      WHERE s.name = 'zc_monitor_cron_secret' AND s.decrypted_secret = p_secret
    ),
    false
  );
$function$;

REVOKE ALL ON FUNCTION public.verify_zc_monitor_cron_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_zc_monitor_cron_secret(text) TO service_role;

-- The monitor enforces the admin-configured minimum and maximum deposit values.
ALTER TABLE public.deposit_requests
  DROP CONSTRAINT IF EXISTS deposit_requests_amount_check;
ALTER TABLE public.deposit_requests
  ADD CONSTRAINT deposit_requests_amount_check
  CHECK (amount > 0 AND amount <= 10000000);

ALTER TABLE public.deposit_requests
  DROP CONSTRAINT IF EXISTS deposit_requests_network_check;
ALTER TABLE public.deposit_requests
  ADD CONSTRAINT deposit_requests_network_check
  CHECK (network = ANY (ARRAY[
    'TRC20', 'ERC20', 'BEP20', 'BITCOIN', 'TRON',
    'DOGECOIN', 'SOLANA', 'ETHEREUM'
  ]));

CREATE OR REPLACE FUNCTION public.process_confirmed_monitored_deposit(
  p_blockchain_deposit_id uuid,
  p_amount_usd numeric
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_chain public.blockchain_deposits%rowtype;
  v_req public.deposit_requests%rowtype;
  v_intent public.plan_deposit_intents%rowtype;
  v_req_id uuid;
  v_intent_id uuid;
  v_ledger_id uuid;
  v_auto_result jsonb;
  v_existing_ledger uuid;
BEGIN
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RAISE EXCEPTION 'Invalid credited USD amount';
  END IF;

  SELECT * INTO v_chain
  FROM public.blockchain_deposits
  WHERE id = p_blockchain_deposit_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Blockchain deposit not found'; END IF;

  IF v_chain.deposit_status = 'credited' THEN
    SELECT id INTO v_req_id
    FROM public.deposit_requests
    WHERE blockchain_deposit_id = v_chain.id
    LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'already_credited', true, 'deposit_request_id', v_req_id);
  END IF;

  IF v_chain.deposit_status <> 'confirmed' THEN
    RAISE EXCEPTION 'Blockchain deposit is not confirmed';
  END IF;

  IF NOT (
    (upper(v_chain.asset_code) = 'USDT' AND upper(v_chain.network_code) IN ('TRC20', 'ERC20', 'BEP20'))
    OR (upper(v_chain.asset_code) = 'BTC' AND upper(v_chain.network_code) = 'BITCOIN')
    OR (upper(v_chain.asset_code) = 'ETH' AND upper(v_chain.network_code) = 'ETHEREUM')
    OR (upper(v_chain.asset_code) = 'TRX' AND upper(v_chain.network_code) = 'TRON')
    OR (upper(v_chain.asset_code) = 'DOGE' AND upper(v_chain.network_code) = 'DOGECOIN')
    OR (upper(v_chain.asset_code) = 'SOL' AND upper(v_chain.network_code) = 'SOLANA')
  ) THEN
    RAISE EXCEPTION 'Unsupported asset and network combination for automatic credit';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_chain.user_id::text, 0));

  SELECT * INTO v_req
  FROM public.deposit_requests
  WHERE user_id = v_chain.user_id
    AND upper(network) = upper(v_chain.network_code)
    AND (tx_hash = v_chain.tx_hash OR coalesce(btrim(tx_hash), '') = '')
    AND status IN ('pending', 'under_review', 'approved', 'credited')
  ORDER BY CASE WHEN tx_hash = v_chain.tx_hash THEN 0 ELSE 1 END, created_at DESC
  LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    v_req_id := v_req.id;

    SELECT id INTO v_existing_ledger
    FROM public.ledger_entries
    WHERE user_id = v_chain.user_id AND entry_type = 'deposit'
      AND reference_type = 'deposit_request' AND reference_id = v_req_id
    LIMIT 1;

    IF v_existing_ledger IS NOT NULL THEN
      UPDATE public.deposit_requests
      SET blockchain_deposit_id = v_chain.id
      WHERE id = v_req_id AND blockchain_deposit_id IS NULL;

      UPDATE public.blockchain_deposits
      SET deposit_status = 'credited', credited_at = pg_catalog.now()
      WHERE id = v_chain.id;

      RETURN jsonb_build_object('ok', true, 'already_credited', true, 'deposit_request_id', v_req_id);
    END IF;

    UPDATE public.deposit_requests
    SET amount = round(p_amount_usd, 6),
        tx_hash = v_chain.tx_hash,
        status = 'credited',
        admin_note = coalesce(nullif(admin_note, ''), 'Automatic blockchain confirmation'),
        blockchain_deposit_id = v_chain.id,
        auto_purchase_status = CASE WHEN plan_deposit_intent_id IS NULL THEN 'not_requested' ELSE 'pending' END
    WHERE id = v_req_id;
  ELSE
    SELECT * INTO v_intent
    FROM public.plan_deposit_intents
    WHERE user_id = v_chain.user_id AND status = 'pending' AND expires_at > pg_catalog.now()
    ORDER BY created_at DESC
    LIMIT 1 FOR UPDATE;

    IF FOUND THEN v_intent_id := v_intent.id; END IF;

    INSERT INTO public.deposit_requests
      (user_id, amount, asset, network, tx_hash, status, admin_note,
       plan_id, plan_deposit_intent_id, auto_purchase_status, blockchain_deposit_id)
    VALUES
      (v_chain.user_id, round(p_amount_usd, 6), 'USDT', upper(v_chain.network_code),
       v_chain.tx_hash, 'credited', 'Automatic blockchain deposit credit',
       v_intent.plan_id, v_intent_id,
       CASE WHEN v_intent_id IS NULL THEN 'not_requested' ELSE 'pending' END,
       v_chain.id)
    RETURNING id INTO v_req_id;
  END IF;

  INSERT INTO public.ledger_entries
    (user_id, amount, entry_type, description, reference_type, reference_id)
  VALUES
    (v_chain.user_id, round(p_amount_usd, 6), 'deposit',
     'Deposit received — verified on-chain', 'deposit_request', v_req_id)
  RETURNING id INTO v_ledger_id;

  SELECT plan_deposit_intent_id INTO v_intent_id
  FROM public.deposit_requests WHERE id = v_req_id;

  v_auto_result := private.zc_apply_plan_deposit_intent(
    v_chain.user_id, v_req_id, v_intent_id, round(p_amount_usd, 6), NULL
  );

  UPDATE public.blockchain_deposits
  SET deposit_status = 'credited', credited_at = pg_catalog.now()
  WHERE id = v_chain.id;

  INSERT INTO public.audit_logs(actor_id, action, entity_type, entity_id, details)
  VALUES (
    NULL, 'blockchain_deposit_credited', 'deposit_request', v_req_id,
    jsonb_build_object(
      'blockchain_deposit_id', v_chain.id,
      'user_id', v_chain.user_id,
      'amount_usd', round(p_amount_usd, 6),
      'auto_purchase', v_auto_result
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'already_credited', false, 'deposit_request_id', v_req_id,
    'user_id', v_chain.user_id, 'amount_usd', round(p_amount_usd, 6),
    'auto_purchase', v_auto_result
  );
END;
$function$;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  FOR v_job_id IN
    SELECT jobid FROM cron.job WHERE jobname = 'zc-auto-deposit-monitor'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'zc-auto-deposit-monitor',
    '30 seconds',
    $job$
      SELECT net.http_post(
        url := 'https://ltowdrhwebaitbrrupks.supabase.co/functions/v1/monitor-deposits',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', 'sb_publishable_mLgEtnFl6FnOzbykh6tWPw_14T_c8nS',
          'x-zc-cron-secret',
          (SELECT decrypted_secret FROM vault.decrypted_secrets
           WHERE name = 'zc_monitor_cron_secret' LIMIT 1)
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
    $job$
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
