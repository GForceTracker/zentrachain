create schema if not exists private;
create table if not exists private.wallet_derivation_counters (
  asset_network_id text primary key references public.crypto_asset_networks(id) on delete restrict,
  next_index bigint not null default 0 check (next_index >= 0)
);
alter table private.wallet_derivation_counters enable row level security;
revoke all on private.wallet_derivation_counters from anon, authenticated;
insert into private.wallet_derivation_counters(asset_network_id,next_index)
select id,0 from public.crypto_asset_networks
on conflict (asset_network_id) do nothing;

create or replace function private.reserve_wallet_derivation_index(p_asset_network_id text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_index bigint;
begin
  if not exists (
    select 1 from public.crypto_asset_networks
    where id = p_asset_network_id
  ) then
    raise exception 'Unsupported asset/network';
  end if;
  insert into private.wallet_derivation_counters(asset_network_id,next_index)
  values (p_asset_network_id,0)
  on conflict (asset_network_id) do nothing;
  update private.wallet_derivation_counters
    set next_index = next_index + 1
    where asset_network_id = p_asset_network_id
    returning next_index - 1 into v_index;
  return v_index;
end;
$$;
revoke all on function private.reserve_wallet_derivation_index(text) from public, anon, authenticated;
grant execute on function private.reserve_wallet_derivation_index(text) to service_role;
