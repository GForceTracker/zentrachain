-- The current client uses public.purchase_gforce_plan instead.
-- Keep the legacy RPC available only to trusted service-role operations.
revoke all on function public.zc_purchase_gforce_plan(uuid, numeric) from public, anon, authenticated;
grant execute on function public.zc_purchase_gforce_plan(uuid, numeric) to service_role;
