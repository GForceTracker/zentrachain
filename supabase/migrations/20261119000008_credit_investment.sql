-- Credit flow creates the investment row (tier by amount) so plans,
-- progress, cancellation and maturity all share one source of truth.
create or replace function public.admin_review_gforce_deposit(
  p_request_id uuid,
  p_approve boolean,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.deposit_requests%rowtype;
  v_uid uuid := auth.uid();
  v_id uuid;
  v_led uuid;
  v_tier record;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_note is null or btrim(p_note) = '' then raise exception 'A review note is required'; end if;
  select * into v_req from public.deposit_requests where id = p_request_id for update;
  if not found then raise exception 'Deposit request not found'; end if;
  if v_req.status not in ('pending','under_review') then raise exception 'Deposit request was already reviewed'; end if;
  if p_approve then
    update public.deposit_requests
      set status = 'approved', admin_note = p_note, reviewed_by = v_uid,
          reviewed_at = now(), updated_at = now()
      where id = p_request_id
      returning id into v_id;
    insert into public.ledger_entries(user_id, amount, entry_type, description, reference_type, reference_id)
    values (v_req.user_id, v_req.amount, 'deposit', 'Deposit credited: ' || btrim(p_note), 'deposit_request', p_request_id)
    returning id into v_led;
    select p.id, p.percentage, p.duration_value, p.duration_unit
      into v_tier
      from public.gforce_investment_plans p
      where p.is_active = true
        and v_req.amount >= p.min_amount and v_req.amount <= p.max_amount
      order by p.percentage desc
      limit 1;
    if found then
      insert into public.user_investments (user_id, ledger_entry_id, plan_id, amount, rate, status, starts_at, ends_at)
      values (
        v_req.user_id, v_led, v_tier.id, v_req.amount, v_tier.percentage, 'active', now(),
        case
          when lower(v_tier.duration_unit) = 'hours' then now() + (v_tier.duration_value || ' hours')::interval
          else now() + (v_tier.duration_value || ' days')::interval
        end
      );
    end if;
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (v_uid, 'deposit_approved', 'deposit_request', p_request_id::text,
            jsonb_build_object('amount', v_req.amount, 'note', p_note, 'user_id', v_req.user_id));
  else
    update public.deposit_requests
      set status = 'rejected', admin_note = p_note, reviewed_by = v_uid,
          reviewed_at = now(), updated_at = now()
      where id = p_request_id
      returning id into v_id;
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (v_uid, 'deposit_rejected', 'deposit_request', p_request_id::text,
            jsonb_build_object('note', p_note, 'user_id', v_req.user_id));
  end if;
  return v_id;
end;
$$;

revoke all on function public.admin_review_gforce_deposit(uuid,boolean,text) from public;
grant execute on function public.admin_review_gforce_deposit(uuid,boolean,text) to authenticated;
