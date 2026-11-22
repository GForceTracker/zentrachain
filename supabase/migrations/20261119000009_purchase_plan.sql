-- Users buy a plan from their available balance.
-- Server-side validation: plan active, amount in range, available funds
-- (ledger minus reserved withdrawals minus active plan principals).
create or replace function public.purchase_gforce_plan(p_plan_id uuid, p_amount numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plan public.gforce_investment_plans%rowtype;
  v_balance numeric;
  v_reserved numeric;
  v_locked numeric;
  v_led uuid;
  v_inv uuid;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select * into v_plan from public.gforce_investment_plans where id = p_plan_id for update;
  if not found or v_plan.is_active = false then raise exception 'This plan is not available'; end if;
  if p_amount is null or p_amount < v_plan.min_amount or p_amount > v_plan.max_amount then
    raise exception 'Amount must be between % and % USD', v_plan.min_amount, v_plan.max_amount;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  select coalesce(sum(amount),0) into v_balance from public.ledger_entries where user_id = v_uid;
  select coalesce(sum(amount),0) into v_reserved from public.withdrawal_requests
    where user_id = v_uid and status in ('pending','under_review','approved');
  select coalesce(sum(amount),0) into v_locked from public.user_investments
    where user_id = v_uid and status = 'active' and (ends_at is null or ends_at > now());
  if p_amount > v_balance - v_reserved - v_locked then
    raise exception 'Not enough balance. Fund your account to continue.';
  end if;
  insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type)
  values (v_uid, -round(p_amount, 8), 'investment', 'Plan purchase: ' || v_plan.name, 'plan_purchase')
  returning id into v_led;
  insert into public.user_investments (user_id, ledger_entry_id, plan_id, amount, rate, status, starts_at, ends_at)
  values (
    v_uid, v_led, v_plan.id, round(p_amount, 8), v_plan.percentage, 'active', now(),
    case
      when lower(v_plan.duration_unit) = 'hours' then now() + (v_plan.duration_value || ' hours')::interval
      else now() + (v_plan.duration_value || ' days')::interval
    end
  )
  returning id into v_inv;
  update public.ledger_entries set reference_id = v_inv where id = v_led;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (v_uid, 'plan_purchased', 'user_investment', v_inv::text,
          jsonb_build_object('plan_id', p_plan_id, 'plan_name', v_plan.name, 'amount', p_amount, 'rate', v_plan.percentage));
  return v_inv;
end;
$$;

revoke all on function public.purchase_gforce_plan(uuid, numeric) from public;
grant execute on function public.purchase_gforce_plan(uuid, numeric) to authenticated;
