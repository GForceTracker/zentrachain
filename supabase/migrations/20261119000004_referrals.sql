-- Referral system: codes, links, admin-set reward paid on first credited deposit.
alter table public.profiles
  add column if not exists referral_code text unique;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, referral_code)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email,''),'@',1)),
    upper(substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 8))
  )
  on conflict (id) do update set
    email = excluded.email,
    referral_code = coalesce(public.profiles.referral_code, excluded.referral_code);
  return new;
end;
$$;

update public.profiles
  set referral_code = upper(substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 8))
  where referral_code is null;

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references auth.users(id) on delete cascade,
  referred_id uuid not null references auth.users(id) on delete cascade,
  reward_paid boolean not null default false,
  created_at timestamptz not null default now(),
  unique (referred_id),
  check (referrer_id <> referred_id)
);
create index if not exists referrals_referrer_idx on public.referrals(referrer_id, created_at desc);

alter table public.referrals enable row level security;

drop policy if exists "Users read own referral links" on public.referrals;
create policy "Users read own referral links"
  on public.referrals for select to authenticated
  using (referrer_id = (select auth.uid()) or referred_id = (select auth.uid()) or (select private.is_admin()));

drop policy if exists "Users record own referral" on public.referrals;
create policy "Users record own referral"
  on public.referrals for insert to authenticated
  with check (referred_id = (select auth.uid()) and referrer_id <> (select auth.uid()));

drop policy if exists "Admins manage referrals" on public.referrals;
create policy "Admins manage referrals"
  on public.referrals for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

grant select on public.referrals to authenticated;
grant insert on public.referrals to authenticated;
grant select, insert, update, delete on public.referrals to service_role;

insert into public.site_settings (setting_key, numeric_value, updated_at, updated_by)
values ('referral_reward_usd', 0, now(), null)
on conflict (setting_key) do nothing;

create or replace function public.pay_referral_reward()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref public.referrals%rowtype;
  v_reward numeric;
begin
  if new.entry_type <> 'deposit' or new.amount is null or new.amount <= 0 then
    return new;
  end if;
  select * into v_ref from public.referrals
    where referred_id = new.user_id and reward_paid = false
    for update;
  if not found then
    return new;
  end if;
  if exists (
    select 1 from public.ledger_entries
    where user_id = new.user_id and entry_type = 'deposit' and id <> new.id
  ) then
    update public.referrals set reward_paid = true where id = v_ref.id;
    return new;
  end if;
  select numeric_value into v_reward from public.site_settings
    where setting_key = 'referral_reward_usd';
  if v_reward is null or v_reward <= 0 then
    return new;
  end if;
  insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type, reference_id)
  values (
    v_ref.referrer_id, v_reward, 'bonus',
    'Referral reward for invited member',
    'referral_reward', v_ref.referred_id
  );
  update public.referrals set reward_paid = true where id = v_ref.id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (
    v_ref.referrer_id, 'referral_reward_paid', 'referral', v_ref.id::text,
    jsonb_build_object('amount', v_reward, 'referred_id', v_ref.referred_id)
  );
  return new;
end;
$$;

drop trigger if exists pay_referral_reward_trigger on public.ledger_entries;
create trigger pay_referral_reward_trigger
  after insert on public.ledger_entries
  for each row execute function public.pay_referral_reward();
