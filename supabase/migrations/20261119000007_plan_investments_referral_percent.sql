-- Plan purchases from available funds, automatic maturity settlement,
-- and a percentage-based referral bonus.

-- 1) user_investments access (table exists from an earlier migration)
alter table public.user_investments enable row level security;

drop policy if exists "Users read own investments" on public.user_investments;
create policy "Users read own investments"
  on public.user_investments for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

drop policy if exists "Users insert own investments" on public.user_investments;
create policy "Users insert own investments"
  on public.user_investments for insert to authenticated
  with check (user_id = (select auth.uid()));

grant select, insert on public.user_investments to authenticated;

-- 2) Purchase: deduct from available funds into a locked plan investment
create or replace function public.zc_purchase_gforce_plan(p_plan_id uuid, p_amount numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_plan public.gforce_investment_plans%rowtype;
  v_bal numeric;
  v_reserved numeric;
  v_available numeric;
  v_days numeric;
  v_entry_id uuid;
  v_inv_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Sign in to purchase a plan.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter a valid plan amount.';
  end if;

  select * into v_plan from public.gforce_investment_plans
    where id = p_plan_id and is_active = true;
  if not found then
    raise exception 'This plan is not available.';
  end if;
  if p_amount < v_plan.min_amount or p_amount > v_plan.max_amount then
    raise exception 'Amount must be between % and % for this plan.', v_plan.min_amount, v_plan.max_amount;
  end if;

  select coalesce(sum(amount), 0) into v_bal
    from public.ledger_entries where user_id = v_uid;
  select coalesce(sum(amount), 0) into v_reserved
    from public.withdrawal_requests
    where user_id = v_uid and status in ('pending','under_review','approved');
  v_available := v_bal - v_reserved;
  if v_available < p_amount then
    raise exception 'Not enough available funds. Available: %', floor(v_available);
  end if;

  v_days := v_plan.duration_value *
    (case when lower(coalesce(v_plan.duration_unit,'days')) like 'hour%' then 1.0/24 else 1 end);

  insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type)
    values (v_uid, -p_amount, 'plan_purchase',
            'Plan purchase: ' || v_plan.name, 'plan_investment')
    returning id into v_entry_id;

  insert into public.user_investments
    (user_id, ledger_entry_id, plan_id, amount, rate, status, starts_at, ends_at, note)
    values (v_uid, v_entry_id, v_plan.id, p_amount, v_plan.percentage, 'active',
            now(), now() + (v_days || ' days')::interval,
            'Plan purchase: ' || v_plan.name)
    returning id into v_inv_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
    values (v_uid, 'plan_purchased', 'investment', v_inv_id::text,
            jsonb_build_object('plan', v_plan.name, 'amount', p_amount));

  return v_inv_id;
end;
$$;

revoke execute on function public.zc_purchase_gforce_plan(uuid, numeric) from anon;
grant execute on function public.zc_purchase_gforce_plan(uuid, numeric) to authenticated;

-- 3) Settlement: matured plans return principal + profit to available funds
create or replace function public.zc_settle_gforce_investments()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.user_investments%rowtype;
  v_payout numeric;
  v_count int := 0;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return 0;
  end if;

  for v_row in
    update public.user_investments
      set status = 'completed'
      where user_id = v_uid
        and status = 'active'
        and ends_at is not null
        and ends_at <= now()
      returning *
  loop
    v_payout := v_row.amount + v_row.amount * coalesce(v_row.rate, 0) / 100.0;
    insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type, reference_id)
      values (v_uid, v_payout, 'plan_maturity',
              'Plan completed — principal and profit credited to available balance',
              'plan_maturity', v_row.id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.zc_settle_gforce_investments() from anon;
grant execute on function public.zc_settle_gforce_investments() to authenticated;

-- 4) Referral bonus becomes a percentage of the invited member's deposit
insert into public.site_settings (setting_key, numeric_value)
values ('referral_reward_percent', 5)
on conflict (setting_key) do nothing;

create or replace function public.pay_referral_reward()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref public.referrals%rowtype;
  v_percent numeric;
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

  select numeric_value into v_percent from public.site_settings
    where setting_key = 'referral_reward_percent';
  if v_percent is null or v_percent <= 0 then
    return new;
  end if;

  v_reward := round(new.amount * v_percent / 100.0, 2);
  if v_reward <= 0 then
    return new;
  end if;

  insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type, reference_id)
    values (
      v_ref.referrer_id, v_reward, 'bonus',
      'Referral bonus (' || v_percent || '% of invited member deposit)',
      'referral_reward', v_ref.referred_id
    );

  update public.referrals set reward_paid = true where id = v_ref.id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
    values (
      v_ref.referrer_id, 'referral_reward_paid', 'referral', v_ref.id::text,
      jsonb_build_object('amount', v_reward, 'percent', v_percent, 'referred_id', v_ref.referred_id)
    );

  return new;
end;
$$;

drop trigger if exists pay_referral_reward_trigger on public.ledger_entries;
create trigger pay_referral_reward_trigger
  after insert on public.ledger_entries
  for each row execute function public.pay_referral_reward();
