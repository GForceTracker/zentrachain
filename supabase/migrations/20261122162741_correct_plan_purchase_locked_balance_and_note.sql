-- Restore the already-applied production migration to source control.
-- This intermediate migration records the plan-purchase lock/note fix that was
-- applied to Supabase before it was committed to the repository. The later
-- 20261122185000 migration further hardens the lock calculation and RPC grants.

create or replace function public.purchase_gforce_plan(p_plan_id uuid, p_amount numeric)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_plan public.gforce_investment_plans%rowtype;
  v_balance numeric;
  v_reserved numeric;
  v_locked numeric;
  v_led uuid;
  v_inv uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  select * into v_plan
  from public.gforce_investment_plans
  where id = p_plan_id
  for update;

  if not found or v_plan.is_active = false then
    raise exception 'This plan is not available';
  end if;

  if p_amount is null or p_amount < v_plan.min_amount or p_amount > v_plan.max_amount then
    raise exception 'Amount must be between % and % USD', v_plan.min_amount, v_plan.max_amount;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  -- Settle ended plans before checking funds so matured principal and profit
  -- return to the spendable ledger without waiting for a page refresh.
  perform public.zc_settle_gforce_investments();

  select coalesce(sum(amount), 0)
  into v_balance
  from public.ledger_entries
  where user_id = v_uid;

  select coalesce(sum(amount), 0)
  into v_reserved
  from public.withdrawal_requests
  where user_id = v_uid
    and status in ('pending', 'under_review', 'approved');

  -- Existing deposit-backed investments still have their principal in the
  -- ledger. A direct purchase creates a negative investment ledger entry, so
  -- that principal has already been deducted and must not be subtracted twice.
  select coalesce(sum(ui.amount), 0)
  into v_locked
  from public.user_investments ui
  left join public.ledger_entries le on le.id = ui.ledger_entry_id
  where ui.user_id = v_uid
    and ui.status = 'active'
    and (ui.ends_at is null or ui.ends_at > now())
    and not (le.entry_type = 'investment' and coalesce(le.amount, 0) < 0);

  if p_amount > v_balance - v_reserved - v_locked then
    raise exception 'Not enough balance. Fund your account to continue.';
  end if;

  insert into public.ledger_entries
    (user_id, amount, entry_type, description, reference_type)
  values
    (v_uid, -round(p_amount, 8), 'investment',
     'Plan purchase: ' || v_plan.name, 'plan_purchase')
  returning id into v_led;

  insert into public.user_investments
    (user_id, ledger_entry_id, plan_id, amount, rate, status, starts_at, ends_at, note)
  values
    (
      v_uid,
      v_led,
      v_plan.id,
      round(p_amount, 8),
      v_plan.percentage,
      'active',
      now(),
      case
        when lower(v_plan.duration_unit) = 'hours'
          then now() + (v_plan.duration_value || ' hours')::interval
        else now() + (v_plan.duration_value || ' days')::interval
      end,
      'Plan purchase: ' || v_plan.name
    )
  returning id into v_inv;

  update public.ledger_entries
  set reference_id = v_inv
  where id = v_led;

  insert into public.audit_logs
    (actor_id, action, entity_type, entity_id, details)
  values
    (v_uid, 'plan_purchased', 'user_investment', v_inv,
     jsonb_build_object(
       'plan_id', p_plan_id,
       'plan_name', v_plan.name,
       'amount', p_amount,
       'rate', v_plan.percentage
     ));

  return v_inv;
end;
$function$;

revoke all on function public.purchase_gforce_plan(uuid, numeric) from public;
grant execute on function public.purchase_gforce_plan(uuid, numeric) to authenticated;
