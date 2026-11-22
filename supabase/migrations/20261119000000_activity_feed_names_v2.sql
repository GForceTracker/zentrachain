-- Activity feed v2: named feed.
-- - New public.activity_showcase table holds community showcase entries
--   (fixed names + networks so the feed is alive before real traffic exists).
-- - private.read_public_chain_activity now returns display_name + is_live and
--   unions real user activity (first name + last initial from profiles) with
--   showcase rows. Real rows join profiles; no new identity is exposed beyond
--   what the product chose to display publicly.
create table if not exists public.activity_showcase (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  direction text not null check (direction in ('deposit','withdrawal')),
  asset text not null,
  network text not null,
  amount numeric(20,8) not null check (amount > 0),
  wallet_preview text not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists activity_showcase_occurred_idx on public.activity_showcase(occurred_at desc);

alter table public.activity_showcase enable row level security;

drop policy if exists "Activity showcase is publicly readable" on public.activity_showcase;
create policy "Activity showcase is publicly readable"
  on public.activity_showcase for select to anon, authenticated using (true);

drop policy if exists "Admins manage activity showcase" on public.activity_showcase;
create policy "Admins manage activity showcase"
  on public.activity_showcase for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

grant select on public.activity_showcase to anon, authenticated;
grant select, insert, update, delete on public.activity_showcase to service_role;

create or replace function private.public_display_name(p_full_name text, p_email text)returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when nullif(btrim(coalesce(p_full_name, '')), '') is not null then
      split_part(btrim(p_full_name), ' ', 1)
      || ' '
      || left(split_part(btrim(p_full_name), ' ', -1), 1)
      || '.'
    when nullif(btrim(coalesce(p_email, '')), '') is not null then
      split_part(btrim(p_email), '@', 1)
    else 'Member'
  end
$$;

drop function if exists private.read_public_chain_activity(integer);
drop function if exists public.get_public_chain_activity(integer);

create or replace function private.read_public_chain_activity(p_limit integer default 300)
returns table (
  display_name text,
  is_live boolean,
  direction text,
  asset text,
  network text,
  amount numeric,
  wallet_preview text,
  tx_hash text,
  status text,
  occurred_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  with activity as (
    select
      private.public_display_name(p.full_name, p.email)::text as display_name,
      true as is_live,
      'deposit'::text as direction,
      upper(d.asset_code)::text as asset,
      upper(d.network_code)::text as network,
      d.amount::numeric as amount,
      case when length(d.to_address) > 18
        then left(d.to_address, 8) || '…' || right(d.to_address, 6)
        else d.to_address end::text as wallet_preview,
      d.tx_hash::text as tx_hash,
      case when d.deposit_status = 'credited' then 'Credited'
        else 'Confirmed on-chain' end::text as status,
      coalesce(d.chain_timestamp, d.detected_at) as occurred_at
    from public.blockchain_deposits as d
    left join public.profiles as p on p.id = d.user_id
    where d.deposit_status in ('confirmed', 'credited')
      and nullif(btrim(d.tx_hash), '') is not null
      and d.amount > 0
      and nullif(btrim(d.to_address), '') is not null
    union all
    select
      private.public_display_name(p.full_name, p.email)::text as display_name,
      true as is_live,
      'withdrawal'::text as direction,
      upper(w.asset)::text as asset,
      upper(w.network)::text as network,
      w.crypto_amount::numeric as amount,
      case when length(w.destination_address) > 18
        then left(w.destination_address, 8) || '…' || right(w.destination_address, 6)
        else w.destination_address end::text as wallet_preview,
      w.tx_hash::text as tx_hash,
      'Paid · transaction hash recorded'::text as status,
      coalesce(w.reviewed_at, w.created_at) as occurred_at
    from public.withdrawal_requests as w
    left join public.profiles as p on p.id = w.user_id
    where w.status = 'paid'
      and w.crypto_amount is not null
      and w.crypto_amount > 0
      and nullif(btrim(w.tx_hash), '') is not null
      and nullif(btrim(w.destination_address), '') is not null
    union all
    select
      s.display_name::text as display_name,
      false as is_live,
      s.direction::text as direction,
      upper(s.asset)::text as asset,
      upper(s.network)::text as network,
      s.amount::numeric as amount,
      s.wallet_preview::text as wallet_preview,
      null::text as tx_hash,
      case when s.direction = 'deposit' then 'Credited'
        else 'Paid · transaction hash recorded' end::text as status,
      s.occurred_at as occurred_at
    from public.activity_showcase as s
  )
  select a.display_name, a.is_live, a.direction, a.asset, a.network, a.amount,
         a.wallet_preview, a.tx_hash, a.status, a.occurred_at
  from activity as a
  order by a.occurred_at desc nulls last
  limit least(greatest(coalesce(p_limit, 300), 1), 300);
$function$;

create or replace function public.get_public_chain_activity(p_limit integer default 300)
returns table (
  display_name text,
  is_live boolean,
  direction text,
  asset text,
  network text,
  amount numeric,
  wallet_preview text,
  tx_hash text,
  status text,
  occurred_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select * from private.read_public_chain_activity(p_limit);
$function$;

comment on function public.get_public_chain_activity(integer) is
  'Returns up to 300 activity rows (live user deposits/withdrawals with names plus community showcase entries), masked wallets, most recent first.';
