-- Public storage paths need anonymous SELECT only; uploads and mutation must be
-- authenticated and pass the bucket-specific storage.objects RLS policies.
REVOKE ALL PRIVILEGES ON TABLE storage.objects FROM anon;
GRANT SELECT ON TABLE storage.objects TO anon;

-- The old plan purchase wrapper is not used by the current client. Keep the
-- validated purchase_gforce_plan_from_balance RPC as the supported path.
REVOKE EXECUTE ON FUNCTION public.purchase_gforce_plan(uuid, numeric)
  FROM anon, authenticated, PUBLIC;
