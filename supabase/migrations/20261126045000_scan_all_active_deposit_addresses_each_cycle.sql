CREATE OR REPLACE FUNCTION public.next_zc_deposit_monitor_batch(p_limit integer DEFAULT 6)
 RETURNS SETOF public.user_deposit_addresses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_total integer;
  v_offset integer;
  v_limit integer := greatest(1, least(coalesce(p_limit, 6), 50));
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('zc_deposit_monitor_batch', 0));
  INSERT INTO private.zc_deposit_monitor_state (id, next_offset)
  VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;

  SELECT count(*)::integer
  INTO v_total
  FROM public.user_deposit_addresses
  WHERE address_status = 'active';

  IF v_total <= 0 THEN
    RETURN;
  END IF;

  SELECT next_offset INTO v_offset
  FROM private.zc_deposit_monitor_state
  WHERE id = 1
  FOR UPDATE;

  v_offset := coalesce(v_offset, 0) % v_total;

  UPDATE private.zc_deposit_monitor_state
  SET next_offset = (v_offset + v_limit) % v_total,
      updated_at = pg_catalog.now()
  WHERE id = 1;

  RETURN QUERY
  WITH ranked AS (
    SELECT
      a.*,
      pg_catalog.row_number() OVER (ORDER BY a.created_at, a.id)::integer AS rn
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

REVOKE ALL ON FUNCTION public.next_zc_deposit_monitor_batch(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_zc_deposit_monitor_batch(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_zc_deposit_monitor_batch(integer) TO service_role;
