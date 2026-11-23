-- Plan-linked deposits and exact-plan auto-purchase after verification.
-- A linked deposit buys only the user's selected active plan when its credited
-- USD amount is within that plan's configured minimum and maximum.
-- Deposits outside that range remain in Deposit Balance.

create table if not exists public.plan_deposit_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid not null references public.gforce_investment_plans(id) on delete restrict,
  status text not null default 'pending' check(status in ('pending','consumed','cancelled')),
  outcome text check(outcome is null or outcome in ('purchased','not_eligible','plan_unavailable','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  consumed_at timestamptz
);
create unique index if not exists plan_deposit_intents_one_pending_per_user
  on public.plan_deposit_intents(user_id) where status='pending';
alter table public.plan_deposit_intents enable row level security;
drop policy if exists "Users read own plan deposit intents" on public.plan_deposit_intents;
create policy "Users read own plan deposit intents"
  on public.plan_deposit_intents for select to authenticated
  using(user_id=(select auth.uid()));
revoke all on public.plan_deposit_intents from anon,authenticated;
grant select on public.plan_deposit_intents to authenticated;

alter table public.deposit_requests
  add column if not exists plan_id uuid references public.gforce_investment_plans(id) on delete set null,
  add column if not exists plan_deposit_intent_id uuid references public.plan_deposit_intents(id) on delete set null,
  add column if not exists auto_purchase_status text not null default 'not_requested',
  add column if not exists auto_purchase_note text,
  add column if not exists blockchain_deposit_id uuid references public.blockchain_deposits(id) on delete set null;
alter table public.deposit_requests drop constraint if exists deposit_requests_status_check;
alter table public.deposit_requests add constraint deposit_requests_status_check
  check(status=any(array['pending','under_review','approved','rejected','credited']::text[]));
alter table public.deposit_requests drop constraint if exists deposit_requests_auto_purchase_status_check;
alter table public.deposit_requests add constraint deposit_requests_auto_purchase_status_check
  check(auto_purchase_status=any(array['not_requested','pending','purchased','not_eligible','plan_unavailable','expired']::text[]));
create unique index if not exists deposit_requests_blockchain_deposit_uidx
  on public.deposit_requests(blockchain_deposit_id) where blockchain_deposit_id is not null;

create or replace function public.start_gforce_plan_deposit(p_plan_id uuid)
returns uuid language plpgsql security definer set search_path=''
as $function$
declare
  v_uid uuid:=auth.uid();
  v_plan public.gforce_investment_plans%rowtype;
  v_intent_id uuid;
begin
  if v_uid is null then raise exception 'Sign in to continue'; end if;
  select * into v_plan from public.gforce_investment_plans
    where id=p_plan_id and is_active=true;
  if not found then raise exception 'This plan is not available'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text,0));
  select id into v_intent_id from public.plan_deposit_intents
    where user_id=v_uid and status='pending' for update;
  if v_intent_id is null then
    insert into public.plan_deposit_intents(user_id,plan_id,status,outcome,created_at,expires_at,consumed_at)
    values(v_uid,v_plan.id,'pending',null,now(),now()+interval '24 hours',null)
    returning id into v_intent_id;
  else
    update public.plan_deposit_intents
      set plan_id=v_plan.id,outcome=null,created_at=now(),
          expires_at=now()+interval '24 hours',consumed_at=null
      where id=v_intent_id;
  end if;
  return v_intent_id;
end;
$function$;
revoke all on function public.start_gforce_plan_deposit(uuid) from public,anon;
grant execute on function public.start_gforce_plan_deposit(uuid) to authenticated;

create or replace function private.zc_apply_plan_deposit_intent(
  p_user_id uuid,p_deposit_request_id uuid,p_intent_id uuid,p_amount numeric,p_actor_id uuid
)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  v_intent public.plan_deposit_intents%rowtype;
  v_plan public.gforce_investment_plans%rowtype;
  v_auto_status text:='not_requested';
  v_note text:='No plan-linked deposit purchase was requested.';
  v_investment_ledger_id uuid;
  v_investment_id uuid;
begin
  if p_intent_id is null then
    update public.deposit_requests set auto_purchase_status='not_requested',auto_purchase_note=v_note
      where id=p_deposit_request_id;
    return jsonb_build_object('status',v_auto_status,'note',v_note);
  end if;
  select * into v_intent from public.plan_deposit_intents
    where id=p_intent_id and user_id=p_user_id for update;
  if not found or v_intent.status<>'pending' then
    v_note:='The linked plan deposit selection is no longer active. Funds remain in Deposit Balance.';
    update public.deposit_requests
      set plan_id=coalesce(v_intent.plan_id,plan_id),
          auto_purchase_status='not_requested',auto_purchase_note=v_note
      where id=p_deposit_request_id;
    return jsonb_build_object('status','not_requested','note',v_note);
  end if;
  if v_intent.expires_at<=now() then
    update public.plan_deposit_intents set status='cancelled',outcome='expired',consumed_at=now()
      where id=v_intent.id;
    v_auto_status:='expired';
    v_note:='The plan deposit selection expired. Funds remain in Deposit Balance.';
  else
    select * into v_plan from public.gforce_investment_plans
      where id=v_intent.plan_id and is_active=true;
    if not found then
      v_auto_status:='plan_unavailable';
      v_note:='The selected plan is no longer available. Funds remain in Deposit Balance.';
    elsif p_amount<v_plan.min_amount or p_amount>v_plan.max_amount then
      v_auto_status:='not_eligible';
      v_note:='The verified deposit is outside this plan''s minimum and maximum. Funds remain in Deposit Balance.';
    else
      insert into public.ledger_entries
        (user_id,amount,entry_type,description,reference_type,reference_id,created_by)
      values(p_user_id,-round(p_amount,8),'investment',
        'Plan purchased automatically from verified deposit','plan_purchase_deposit',null,p_actor_id)
      returning id into v_investment_ledger_id;
      insert into public.user_investments
        (user_id,ledger_entry_id,plan_id,amount,rate,status,starts_at,ends_at,note)
      values(
        p_user_id,v_investment_ledger_id,v_plan.id,round(p_amount,8),v_plan.percentage,'active',now(),
        case when lower(v_plan.duration_unit)='hours'
          then now()+(v_plan.duration_value||' hours')::interval
          else now()+(v_plan.duration_value||' days')::interval end,
        'Plan purchased automatically after verified deposit'
      ) returning id into v_investment_id;
      update public.ledger_entries set reference_id=v_investment_id where id=v_investment_ledger_id;
      v_auto_status:='purchased';
      v_note:='Verified deposit automatically purchased '||v_plan.name||'.';
      insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
      values(p_actor_id,'plan_auto_purchased_from_deposit','user_investment',v_investment_id,
        jsonb_build_object('user_id',p_user_id,'deposit_request_id',p_deposit_request_id,
          'plan_id',v_plan.id,'plan_name',v_plan.name,'amount',round(p_amount,8),'rate',v_plan.percentage));
    end if;
    update public.plan_deposit_intents
      set status='consumed',
          outcome=case when v_auto_status='purchased' then 'purchased'
                       when v_auto_status='not_eligible' then 'not_eligible'
                       else 'plan_unavailable' end,
          consumed_at=now()
      where id=v_intent.id;
  end if;
  update public.deposit_requests
    set plan_id=v_intent.plan_id,plan_deposit_intent_id=v_intent.id,
        auto_purchase_status=v_auto_status,auto_purchase_note=v_note
    where id=p_deposit_request_id;
  return jsonb_build_object('status',v_auto_status,'note',v_note,
    'plan_id',v_intent.plan_id,'investment_id',v_investment_id);
end;
$function$;
revoke all on function private.zc_apply_plan_deposit_intent(uuid,uuid,uuid,numeric,uuid)
  from public,anon,authenticated,service_role;

create or replace function public.admin_review_gforce_deposit(
  p_request_id uuid,p_approve boolean,p_note text
)
returns uuid language plpgsql security definer set search_path=''
as $function$
declare
  v_req public.deposit_requests%rowtype;
  v_uid uuid:=auth.uid();
  v_id uuid;
  v_ledger_id uuid;
  v_auto_result jsonb;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_note is null or btrim(p_note)='' then raise exception 'A review note is required'; end if;
  select * into v_req from public.deposit_requests where id=p_request_id for update;
  if not found then raise exception 'Deposit request not found'; end if;
  if v_req.status not in ('pending','under_review') then
    raise exception 'Deposit request was already reviewed or credited';
  end if;
  if p_approve then
    insert into public.ledger_entries
      (user_id,amount,entry_type,description,reference_type,reference_id,created_by)
    values(v_req.user_id,v_req.amount,'deposit','Deposit received','deposit_request',p_request_id,v_uid)
    returning id into v_ledger_id;
    v_auto_result:=private.zc_apply_plan_deposit_intent(
      v_req.user_id,p_request_id,v_req.plan_deposit_intent_id,v_req.amount,v_uid
    );
    update public.deposit_requests
      set status='approved',admin_note=p_note,reviewed_at=now()
      where id=p_request_id returning id into v_id;
    insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(v_uid,'deposit_approved','deposit_request',p_request_id,
      jsonb_build_object('amount',v_req.amount,'note',p_note,'user_id',v_req.user_id,'auto_purchase',v_auto_result));
  else
    update public.deposit_requests
      set status='rejected',admin_note=p_note,reviewed_at=now()
      where id=p_request_id returning id into v_id;
    insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(v_uid,'deposit_rejected','deposit_request',p_request_id,
      jsonb_build_object('note',p_note,'user_id',v_req.user_id));
  end if;
  return v_id;
end;
$function$;
revoke all on function public.admin_review_gforce_deposit(uuid,boolean,text) from public,anon;
grant execute on function public.admin_review_gforce_deposit(uuid,boolean,text) to authenticated;

create or replace function public.process_confirmed_monitored_deposit(
  p_blockchain_deposit_id uuid,p_amount_usd numeric
)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  v_chain public.blockchain_deposits%rowtype;
  v_req public.deposit_requests%rowtype;
  v_intent public.plan_deposit_intents%rowtype;
  v_req_id uuid;
  v_intent_id uuid;
  v_ledger_id uuid;
  v_auto_result jsonb;
  v_existing_ledger uuid;
begin
  if p_amount_usd is null or p_amount_usd<=0 then raise exception 'Invalid credited USD amount'; end if;
  select * into v_chain from public.blockchain_deposits where id=p_blockchain_deposit_id for update;
  if not found then raise exception 'Blockchain deposit not found'; end if;
  if v_chain.deposit_status='credited' then
    select id into v_req_id from public.deposit_requests where blockchain_deposit_id=v_chain.id limit 1;
    return jsonb_build_object('ok',true,'already_credited',true,'deposit_request_id',v_req_id);
  end if;
  if v_chain.deposit_status<>'confirmed' then raise exception 'Blockchain deposit is not confirmed'; end if;
  if upper(v_chain.asset_code)<>'USDT' or upper(v_chain.network_code) not in ('TRC20','ERC20','BEP20') then
    raise exception 'Only enabled USDT deposit networks can be credited through this flow';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_chain.user_id::text,0));
  select * into v_req from public.deposit_requests
    where user_id=v_chain.user_id and upper(network)=upper(v_chain.network_code)
      and (tx_hash=v_chain.tx_hash or coalesce(btrim(tx_hash),'')='')
      and status in ('pending','under_review','approved','credited')
    order by case when tx_hash=v_chain.tx_hash then 0 else 1 end,created_at desc
    limit 1 for update;
  if found then
    v_req_id:=v_req.id;
    select id into v_existing_ledger from public.ledger_entries
      where user_id=v_chain.user_id and entry_type='deposit'
        and reference_type='deposit_request' and reference_id=v_req_id limit 1;
    if v_existing_ledger is not null then
      update public.deposit_requests set blockchain_deposit_id=v_chain.id
        where id=v_req_id and blockchain_deposit_id is null;
      update public.blockchain_deposits set deposit_status='credited',credited_at=now()
        where id=v_chain.id;
      return jsonb_build_object('ok',true,'already_credited',true,'deposit_request_id',v_req_id);
    end if;
    update public.deposit_requests
      set amount=round(p_amount_usd,6),tx_hash=v_chain.tx_hash,status='credited',
          admin_note=coalesce(nullif(admin_note,''),'Automatic blockchain confirmation'),
          blockchain_deposit_id=v_chain.id,
          auto_purchase_status=case when plan_deposit_intent_id is null then 'not_requested' else 'pending' end
      where id=v_req_id;
  else
    select * into v_intent from public.plan_deposit_intents
      where user_id=v_chain.user_id and status='pending' and expires_at>now()
      order by created_at desc limit 1 for update;
    if found then v_intent_id:=v_intent.id; end if;
    insert into public.deposit_requests
      (user_id,amount,asset,network,tx_hash,status,admin_note,plan_id,plan_deposit_intent_id,auto_purchase_status,blockchain_deposit_id)
    values(v_chain.user_id,round(p_amount_usd,6),'USDT',upper(v_chain.network_code),v_chain.tx_hash,
      'credited','Automatic blockchain deposit credit',v_intent.plan_id,v_intent_id,
      case when v_intent_id is null then 'not_requested' else 'pending' end,v_chain.id)
    returning id into v_req_id;
  end if;
  insert into public.ledger_entries(user_id,amount,entry_type,description,reference_type,reference_id)
  values(v_chain.user_id,round(p_amount_usd,6),'deposit','Deposit received — verified on-chain',
    'deposit_request',v_req_id) returning id into v_ledger_id;
  select plan_deposit_intent_id into v_intent_id from public.deposit_requests where id=v_req_id;
  v_auto_result:=private.zc_apply_plan_deposit_intent(v_chain.user_id,v_req_id,v_intent_id,round(p_amount_usd,6),null);
  update public.blockchain_deposits set deposit_status='credited',credited_at=now() where id=v_chain.id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
  values(null,'blockchain_deposit_credited','deposit_request',v_req_id,
    jsonb_build_object('blockchain_deposit_id',v_chain.id,'user_id',v_chain.user_id,
      'amount_usd',round(p_amount_usd,6),'auto_purchase',v_auto_result));
  return jsonb_build_object('ok',true,'already_credited',false,'deposit_request_id',v_req_id,
    'user_id',v_chain.user_id,'amount_usd',round(p_amount_usd,6),'auto_purchase',v_auto_result);
end;
$function$;
revoke all on function public.process_confirmed_monitored_deposit(uuid,numeric) from public,anon,authenticated;
grant execute on function public.process_confirmed_monitored_deposit(uuid,numeric) to service_role;
