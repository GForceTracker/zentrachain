-- Saved withdrawal addresses (tap-to-fill quick list, always editable at use time).
create table if not exists public.saved_withdrawal_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null default 'My wallet',
  asset_code text not null,
  network_code text not null,
  address text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, network_code, address)
);
create index if not exists saved_addresses_user_idx
  on public.saved_withdrawal_addresses(user_id, created_at desc);

alter table public.saved_withdrawal_addresses enable row level security;

drop policy if exists "Users manage own saved addresses" on public.saved_withdrawal_addresses;
create policy "Users manage own saved addresses"
  on public.saved_withdrawal_addresses for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Admins read saved addresses" on public.saved_withdrawal_addresses;
create policy "Admins read saved addresses"
  on public.saved_withdrawal_addresses for select to authenticated
  using ((select private.is_admin()));

grant select, insert, update, delete on public.saved_withdrawal_addresses to authenticated;
grant select on public.saved_withdrawal_addresses to service_role;

-- User investments: deposit -> plan linkage with status and custom rate.
create table if not exists public.user_investments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ledger_entry_id uuid references public.ledger_entries(id) on delete set null,
  plan_id uuid references public.gforce_investment_plans(id) on delete set null,
  amount numeric(20,8) not null check (amount > 0),
  rate numeric(9,4) not null check (rate >= 0 and rate <= 100),
  status text not null default 'active'
    check (status in ('active','completed','cancelled')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid references auth.users(id),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists user_investments_user_idx
  on public.user_investments(user_id, status, created_at desc);

alter table public.user_investments enable row level security;

drop policy if exists "Users read own investments" on public.user_investments;
create policy "Users read own investments"
  on public.user_investments for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

drop policy if exists "Admins manage investments" on public.user_investments;
create policy "Admins manage investments"
  on public.user_investments for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

grant select on public.user_investments to authenticated;
grant select, insert, update, delete on public.user_investments to service_role;

-- Backfill: one active investment per existing deposit, tiered by amount.
insert into public.user_investments (user_id, ledger_entry_id, plan_id, amount, rate, status, starts_at, ends_at)
select
  d.user_id,
  d.id,
  t.id,
  d.amount,
  t.percentage,
  'active',
  d.created_at,
  case
    when lower(t.duration_unit) = 'hours' then d.created_at + (t.duration_value || ' hours')::interval
    else d.created_at + (t.duration_value || ' days')::interval
  end
from public.ledger_entries d
join lateral (
  select p.id, p.percentage, p.duration_value, p.duration_unit
  from public.gforce_investment_plans p
  where p.is_active = true
    and d.amount >= p.min_amount and d.amount <= p.max_amount
  order by p.percentage desc
  limit 1
) t on true
where d.entry_type = 'deposit'
  and not exists (
    select 1 from public.user_investments u where u.ledger_entry_id = d.id
  );
