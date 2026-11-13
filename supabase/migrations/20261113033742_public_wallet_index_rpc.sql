create or replace function public.reserve_wallet_derivation_index(p_asset_network_id text)
returns bigint
language sql
security definer
set search_path = ''
as $$ select private.reserve_wallet_derivation_index(p_asset_network_id); $$;
revoke all on function public.reserve_wallet_derivation_index(text) from public, anon, authenticated;
grant execute on function public.reserve_wallet_derivation_index(text) to service_role;
