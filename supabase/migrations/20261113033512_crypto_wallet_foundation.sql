create table if not exists public.crypto_asset_networks (
  id text primary key,
  asset_code text not null,
  network_code text not null,
  asset_name text not null,
  network_name text not null,
  asset_type text not null check (asset_type in ('native','token')),
  decimals smallint not null check (decimals between 0 and 18),
  is_enabled boolean not null default false,
  contract_address text,
  created_at timestamptz not null default now(),
  unique (asset_code, network_code),
  check ((asset_type = 'native' and contract_address is null) or asset_type = 'token')
);

insert into public.crypto_asset_networks
(id,asset_code,network_code,asset_name,network_name,asset_type,decimals,is_enabled)
values
('usdt-trc20','USDT','TRC20','Tether USD','TRON (TRC20)','token',6,false),
('usdt-erc20','USDT','ERC20','Tether USD','Ethereum (ERC20)','token',6,false),
('usdt-bep20','USDT','BEP20','Tether USD','BNB Smart Chain (BEP20)','token',18,false),
('btc-bitcoin','BTC','BITCOIN','Bitcoin','Bitcoin','native',8,false),
('trx-tron','TRX','TRON','TRON','TRON','native',6,false),
('doge-dogecoin','DOGE','DOGECOIN','Dogecoin','Dogecoin','native',8,false),
('sol-solana','SOL','SOLANA','Solana','Solana','native',9,false),
('eth-ethereum','ETH','ETHEREUM','Ethereum','Ethereum','native',18,false)
on conflict (id) do nothing;

create table if not exists public.user_deposit_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  asset_network_id text not null references public.crypto_asset_networks(id),
  asset_code text not null,
  network_code text not null,
  address text not null,
  derivation_index bigint not null check (derivation_index >= 0),
  derivation_path text not null,
  address_status text not null default 'active' check (address_status in ('active','disabled')),
  created_at timestamptz not null default now(),
  unique (user_id, asset_network_id),
  unique (network_code, address),
  unique (asset_network_id, derivation_index)
);

create index if not exists user_deposit_addresses_user_idx
  on public.user_deposit_addresses(user_id, created_at desc);

create table if not exists public.blockchain_deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  address_id uuid not null references public.user_deposit_addresses(id) on delete restrict,
  asset_network_id text not null references public.crypto_asset_networks(id),
  asset_code text not null,
  network_code text not null,
  tx_hash text not null,
  event_index integer not null default 0 check (event_index >= 0),
  from_address text,
  to_address text not null,
  amount numeric(38,18) not null check (amount > 0),
  confirmations integer not null default 0 check (confirmations >= 0),
  required_confirmations integer not null check (required_confirmations > 0),
  deposit_status text not null default 'detected'
    check (deposit_status in ('detected','confirming','confirmed','credited','ignored','reorged')),
  chain_timestamp timestamptz,
  detected_at timestamptz not null default now(),
  credited_at timestamptz,
  raw_event jsonb not null default '{}'::jsonb,
  unique (network_code, tx_hash, event_index)
);

create index if not exists blockchain_deposits_user_idx
  on public.blockchain_deposits(user_id, detected_at desc);
create index if not exists blockchain_deposits_status_idx
  on public.blockchain_deposits(network_code, deposit_status, detected_at);

create table if not exists public.crypto_sweep_requests (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references public.blockchain_deposits(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  asset_network_id text not null references public.crypto_asset_networks(id),
  asset_code text not null,
  network_code text not null,
  from_address text not null,
  destination_address text not null,
  amount numeric(38,18) not null check (amount > 0),
  status text not null default 'pending'
    check (status in ('pending','approved','broadcasting','broadcast','confirmed','failed','cancelled')),
  tx_hash text,
  admin_note text,
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  broadcast_at timestamptz,
  completed_at timestamptz,
  unique (deposit_id)
);

create index if not exists crypto_sweep_requests_status_idx
  on public.crypto_sweep_requests(status, created_at);

alter table public.crypto_asset_networks enable row level security;
alter table public.user_deposit_addresses enable row level security;
alter table public.blockchain_deposits enable row level security;
alter table public.crypto_sweep_requests enable row level security;

drop policy if exists "Crypto networks are publicly readable" on public.crypto_asset_networks;
create policy "Crypto networks are publicly readable"
  on public.crypto_asset_networks for select to anon, authenticated using (true);

drop policy if exists "Users read own deposit addresses or admins read all" on public.user_deposit_addresses;
create policy "Users read own deposit addresses or admins read all"
  on public.user_deposit_addresses for select to authenticated
  using ((select auth.uid()) = user_id or (select private.is_admin()));

drop policy if exists "Users read own blockchain deposits or admins read all" on public.blockchain_deposits;
create policy "Users read own blockchain deposits or admins read all"
  on public.blockchain_deposits for select to authenticated
  using ((select auth.uid()) = user_id or (select private.is_admin()));

drop policy if exists "Only admins read and manage sweep requests" on public.crypto_sweep_requests;
create policy "Only admins read and manage sweep requests"
  on public.crypto_sweep_requests for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

grant select on public.crypto_asset_networks to anon, authenticated;
grant select on public.user_deposit_addresses to authenticated;
grant select on public.blockchain_deposits to authenticated;
grant select, insert, update, delete on public.crypto_sweep_requests to authenticated;
