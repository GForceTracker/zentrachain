-- Public, anonymized chain-activity feed.
-- The private SECURITY DEFINER reader can see verified activity rows while exposing
-- only masked wallet addresses and no customer identity. The public wrapper is invoker-only.
create or replace function private.read_public_chain_activity(p_limit integer default 300)
returns table (
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
    where d.deposit_status in ('confirmed', 'credited')
      and nullif(btrim(d.tx_hash), '') is not null
      and d.amount > 0
      and nullif(btrim(d.to_address), '') is not null
    union all
    select
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
    where w.status = 'paid'
      and w.crypto_amount is not null
      and w.crypto_amount > 0
      and nullif(btrim(w.tx_hash), '') is not null
      and nullif(btrim(w.destination_address), '') is not null
  )
  select a.direction,a.asset,a.network,a.amount,a.wallet_preview,a.tx_hash,a.status,a.occurred_at
  from activity as a
  order by a.occurred_at desc nulls last
  limit least(greatest(coalesce(p_limit, 300), 1), 300);
$function$;

revoke all on function private.read_public_chain_activity(integer) from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.read_public_chain_activity(integer) to anon, authenticated;

create or replace function public.get_public_chain_activity(p_limit integer default 300)
returns table (
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

revoke all on function public.get_public_chain_activity(integer) from public;
grant execute on function public.get_public_chain_activity(integer) to anon, authenticated;

comment on function public.get_public_chain_activity(integer) is
  'Returns up to 300 anonymized verified deposit confirmations and paid withdrawals with transaction hashes; excludes all user identity fields and full wallet addresses.';
