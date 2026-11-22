-- Split Deposit Balance and Available Funds as separate wallet sources.
-- Preserve internal administrator notes only in audit_logs; never expose them in ledger descriptions.

create or replace function public.admin_adjust_user_ledger(
  p_user_id uuid, p_amount numeric, p_entry_type text, p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_bucket text := lower(coalesce(nullif(btrim(p_entry_type), ''), 'available'));
  v_amount numeric(20,8);
  v_balance numeric(20,8);
  v_reserved numeric(20,8);
  v_locked numeric(20,8);
  v_total_spendable numeric(20,8);
  v_deposit_gross numeric(20,8);
  v_deposit_debits numeric(20,8);
  v_legacy_deposit_locked numeric(20,8);
  v_deposit_plan_spent numeric(20,8);
  v_deposit_balance numeric(20,8);
  v_available_balance numeric(20,8);
  v_bonus_balance numeric(20,8);
  v_ledger_type text;
  v_reference_type text;
  v_description text;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_user_id is null then raise exception 'Choose the member'; end if;
  if p_amount is null then raise exception 'Enter an amount'; end if;
  v_amount := round(p_amount, 2);
  if v_amount = 0 then raise exception 'Amount must be at least 0.01'; end if;
  if v_bucket = 'adjustment' then v_bucket := 'available'; end if;
  if v_bucket not in ('deposit','available','bonus') then
    raise exception 'Choose Deposit Balance or Available Funds';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select coalesce(sum(le.amount),0) into v_balance
  from public.ledger_entries le where le.user_id=p_user_id;
  select coalesce(sum(w.amount),0) into v_reserved
  from public.withdrawal_requests w
  where w.user_id=p_user_id and w.status in ('pending','under_review','approved');
  select coalesce(sum(ui.amount),0) into v_locked
  from public.user_investments ui
  left join public.ledger_entries le on le.id=ui.ledger_entry_id and le.user_id=p_user_id
  where ui.user_id=p_user_id and ui.status='active'
    and (ui.ends_at is null or ui.ends_at>now())
    and not coalesce(le.amount<0,false);
  v_total_spendable := greatest(0,v_balance-v_reserved-v_locked);

  select coalesce(sum(le.amount),0) into v_deposit_gross
  from public.ledger_entries le
  where le.user_id=p_user_id and le.entry_type in ('deposit','deposit_credit');
  select coalesce(sum(le.amount),0) into v_deposit_debits
  from public.ledger_entries le
  where le.user_id=p_user_id and le.reference_type='admin_deposit_debit';
  select coalesce(sum(ui.amount),0) into v_legacy_deposit_locked
  from public.user_investments ui
  join public.ledger_entries le on le.id=ui.ledger_entry_id and le.user_id=p_user_id
  where ui.user_id=p_user_id and ui.status='active'
    and (ui.ends_at is null or ui.ends_at>now())
    and le.entry_type in ('deposit','deposit_credit') and le.amount>0;
  select coalesce(sum(ui.amount),0) into v_deposit_plan_spent
  from public.user_investments ui
  join public.ledger_entries le on le.id=ui.ledger_entry_id and le.user_id=p_user_id
  where ui.user_id=p_user_id and ui.status<>'cancelled'
    and le.amount<0 and le.reference_type in ('plan_purchase_deposit','plan_purchase');

  v_deposit_balance := greatest(0,v_deposit_gross+v_deposit_debits-v_legacy_deposit_locked-v_deposit_plan_spent);
  v_deposit_balance := least(v_deposit_balance,v_total_spendable);
  v_available_balance := greatest(0,v_total_spendable-v_deposit_balance);

  select coalesce(sum(le.amount),0) into v_bonus_balance
  from public.ledger_entries le where le.user_id=p_user_id and le.entry_type='bonus';

  if v_bucket='deposit' and v_amount<0 and abs(v_amount)>v_deposit_balance then
    raise exception 'The member has only % in Deposit Balance',round(v_deposit_balance,2);
  elsif v_bucket='available' and v_amount<0 and abs(v_amount)>v_available_balance then
    raise exception 'The member has only % in Available Funds',round(v_available_balance,2);
  elsif v_bucket='bonus' and v_amount<0 and abs(v_amount)>greatest(0,v_bonus_balance) then
    raise exception 'The member has only % in Bonus Balance',round(greatest(0,v_bonus_balance),2);
  end if;

  if v_bucket='deposit' and v_amount>0 then
    v_ledger_type:='deposit_credit'; v_reference_type:='admin_deposit_credit'; v_description:='Deposit balance credited';
  elsif v_bucket='deposit' then
    v_ledger_type:='adjustment'; v_reference_type:='admin_deposit_debit'; v_description:='Deposit balance adjusted';
  elsif v_bucket='available' and v_amount>0 then
    v_ledger_type:='adjustment'; v_reference_type:='admin_available_credit'; v_description:='Available funds credited';
  elsif v_bucket='available' then
    v_ledger_type:='adjustment'; v_reference_type:='admin_available_debit'; v_description:='Available funds adjusted';
  elsif v_amount>0 then
    v_ledger_type:='bonus'; v_reference_type:='admin_bonus_credit'; v_description:='Bonus balance credited';
  else
    v_ledger_type:='bonus'; v_reference_type:='admin_bonus_debit'; v_description:='Bonus balance adjusted';
  end if;

  insert into public.ledger_entries(user_id,amount,entry_type,description,reference_type,reference_id,created_by)
  values(p_user_id,v_amount,v_ledger_type,v_description,v_reference_type,p_user_id,v_uid)
  returning id into v_id;

  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(v_uid,'balance_adjusted','ledger_entry',v_id,
         jsonb_build_object('user_id',p_user_id,'amount',v_amount,'bucket',v_bucket,'note',p_note));
  return v_id;
end;
$function$;

revoke all on function public.admin_adjust_user_ledger(uuid,numeric,text,text) from public, anon;
grant execute on function public.admin_adjust_user_ledger(uuid,numeric,text,text) to authenticated;

create or replace function public.admin_credit_user_funds(
  p_user_id uuid, p_amount numeric, p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_user_id is null then raise exception 'Choose the member to credit'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'Amount must be greater than zero'; end if;
  insert into public.ledger_entries(user_id,amount,entry_type,description,reference_type,reference_id,created_by)
  values(p_user_id,round(p_amount,2),'bonus','Trading profit credited','treasury_credit',p_user_id,v_uid)
  returning id into v_id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(v_uid,'treasury_profit_credit','ledger_entry',v_id,
         jsonb_build_object('user_id',p_user_id,'amount',p_amount,'note',p_note));
  return v_id;
end;
$function$;

revoke all on function public.admin_credit_user_funds(uuid,numeric,text) from public, anon;
grant execute on function public.admin_credit_user_funds(uuid,numeric,text) to authenticated;

create or replace function public.admin_review_gforce_deposit(
  p_request_id uuid, p_approve boolean, p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_req public.deposit_requests%rowtype;
  v_uid uuid := auth.uid();
  v_id uuid;
  v_led uuid;
  v_tier record;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_note is null or btrim(p_note)='' then raise exception 'A review note is required'; end if;
  select * into v_req from public.deposit_requests where id=p_request_id for update;
  if not found then raise exception 'Deposit request not found'; end if;
  if v_req.status not in ('pending','under_review') then raise exception 'Deposit request was already reviewed'; end if;

  if p_approve then
    update public.deposit_requests
      set status='approved',admin_note=p_note,reviewed_by=v_uid,reviewed_at=now(),updated_at=now()
      where id=p_request_id returning id into v_id;
    insert into public.ledger_entries(user_id,amount,entry_type,description,reference_type,reference_id,created_by)
    values(v_req.user_id,v_req.amount,'deposit','Deposit received','deposit_request',p_request_id,v_uid)
    returning id into v_led;
    select p.id,p.percentage,p.duration_value,p.duration_unit into v_tier
    from public.gforce_investment_plans p
    where p.is_active=true and v_req.amount>=p.min_amount and v_req.amount<=p.max_amount
    order by p.percentage desc limit 1;
    if found then
      insert into public.user_investments(user_id,ledger_entry_id,plan_id,amount,rate,status,starts_at,ends_at)
      values(
        v_req.user_id,v_led,v_tier.id,v_req.amount,v_tier.percentage,'active',now(),
        case when lower(v_tier.duration_unit)='hours'
          then now()+(v_tier.duration_value||' hours')::interval
          else now()+(v_tier.duration_value||' days')::interval end
      );
    end if;
    insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(v_uid,'deposit_approved','deposit_request',p_request_id,
           jsonb_build_object('amount',v_req.amount,'note',p_note,'user_id',v_req.user_id));
  else
    update public.deposit_requests
      set status='rejected',admin_note=p_note,reviewed_by=v_uid,reviewed_at=now(),updated_at=now()
      where id=p_request_id returning id into v_id;
    insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(v_uid,'deposit_rejected','deposit_request',p_request_id,
           jsonb_build_object('note',p_note,'user_id',v_req.user_id));
  end if;
  return v_id;
end;
$function$;

revoke all on function public.admin_review_gforce_deposit(uuid,boolean,text) from public, anon;
grant execute on function public.admin_review_gforce_deposit(uuid,boolean,text) to authenticated;

create or replace function public.purchase_gforce_plan_from_balance(
  p_plan_id uuid, p_amount numeric, p_funding_source text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_plan public.gforce_investment_plans%rowtype;
  v_source text := lower(coalesce(nullif(btrim(p_funding_source),''),''));
  v_balance numeric(20,8);
  v_reserved numeric(20,8);
  v_locked numeric(20,8);
  v_total_spendable numeric(20,8);
  v_deposit_gross numeric(20,8);
  v_deposit_debits numeric(20,8);
  v_legacy_deposit_locked numeric(20,8);
  v_deposit_plan_spent numeric(20,8);
  v_deposit_balance numeric(20,8);
  v_available_balance numeric(20,8);
  v_amount numeric(20,8);
  v_led uuid;
  v_inv uuid;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if v_source not in ('deposit','available') then raise exception 'Choose Deposit Balance or Available Funds'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text,0));
  select * into v_plan from public.gforce_investment_plans where id=p_plan_id for update;
  if not found or v_plan.is_active=false then raise exception 'This plan is not available'; end if;
  v_amount := round(p_amount,8);
  if v_amount is null or v_amount<v_plan.min_amount or v_amount>v_plan.max_amount then
    raise exception 'Amount must be between % and % USD',v_plan.min_amount,v_plan.max_amount;
  end if;

  perform public.zc_settle_gforce_investments();

  select coalesce(sum(le.amount),0) into v_balance
  from public.ledger_entries le where le.user_id=v_uid;
  select coalesce(sum(w.amount),0) into v_reserved
  from public.withdrawal_requests w
  where w.user_id=v_uid and w.status in ('pending','under_review','approved');
  select coalesce(sum(ui.amount),0) into v_locked
  from public.user_investments ui
  left join public.ledger_entries le on le.id=ui.ledger_entry_id and le.user_id=v_uid
  where ui.user_id=v_uid and ui.status='active'
    and (ui.ends_at is null or ui.ends_at>now())
    and not coalesce(le.amount<0,false);
  v_total_spendable := greatest(0,v_balance-v_reserved-v_locked);

  select coalesce(sum(le.amount),0) into v_deposit_gross
  from public.ledger_entries le
  where le.user_id=v_uid and le.entry_type in ('deposit','deposit_credit');
  select coalesce(sum(le.amount),0) into v_deposit_debits
  from public.ledger_entries le
  where le.user_id=v_uid and le.reference_type='admin_deposit_debit';
  select coalesce(sum(ui.amount),0) into v_legacy_deposit_locked
  from public.user_investments ui
  join public.ledger_entries le on le.id=ui.ledger_entry_id and le.user_id=v_uid
  where ui.user_id=v_uid and ui.status='active'
    and (ui.ends_at is null or ui.ends_at>now())
    and le.entry_type in ('deposit','deposit_credit') and le.amount>0;
  select coalesce(sum(ui.amount),0) into v_deposit_plan_spent
  from public.user_investments ui
  join public.ledger_entries le on le.id=ui.ledger_entry_id and le.user_id=v_uid
  where ui.user_id=v_uid and ui.status<>'cancelled'
    and le.amount<0 and le.reference_type in ('plan_purchase_deposit','plan_purchase');

  v_deposit_balance := greatest(0,v_deposit_gross+v_deposit_debits-v_legacy_deposit_locked-v_deposit_plan_spent);
  v_deposit_balance := least(v_deposit_balance,v_total_spendable);
  v_available_balance := greatest(0,v_total_spendable-v_deposit_balance);
  if v_source='deposit' and v_amount>v_deposit_balance then
    raise exception 'Not enough Deposit Balance. Available: % USD',round(v_deposit_balance,2);
  elsif v_source='available' and v_amount>v_available_balance then
    raise exception 'Not enough Available Funds. Available: % USD',round(v_available_balance,2);
  end if;

  insert into public.ledger_entries(user_id,amount,entry_type,description,reference_type,created_by)
  values(v_uid,-v_amount,'investment','Plan purchase: '||v_plan.name,
         case when v_source='deposit' then 'plan_purchase_deposit' else 'plan_purchase_available' end,v_uid)
  returning id into v_led;
  insert into public.user_investments(user_id,ledger_entry_id,plan_id,amount,rate,status,starts_at,ends_at,note)
  values(
    v_uid,v_led,v_plan.id,v_amount,v_plan.percentage,'active',now(),
    case when lower(v_plan.duration_unit)='hours'
      then now()+(v_plan.duration_value||' hours')::interval
      else now()+(v_plan.duration_value||' days')::interval end,
    'Plan purchase: '||v_plan.name
  ) returning id into v_inv;
  update public.ledger_entries set reference_id=v_inv where id=v_led;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(v_uid,'plan_purchased','user_investment',v_inv,
         jsonb_build_object('plan_id',p_plan_id,'plan_name',v_plan.name,'amount',v_amount,
                            'rate',v_plan.percentage,'funding_source',v_source));
  return v_inv;
end;
$function$;

revoke all on function public.purchase_gforce_plan_from_balance(uuid,numeric,text) from public, anon;
grant execute on function public.purchase_gforce_plan_from_balance(uuid,numeric,text) to authenticated;

-- Backwards compatibility for older clients: old two-argument requests use Available Funds only.
create or replace function public.purchase_gforce_plan(p_plan_id uuid,p_amount numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return public.purchase_gforce_plan_from_balance(p_plan_id,p_amount,'available');
end;
$function$;

revoke all on function public.purchase_gforce_plan(uuid,numeric) from public, anon;
grant execute on function public.purchase_gforce_plan(uuid,numeric) to authenticated;
