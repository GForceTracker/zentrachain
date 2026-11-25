-- Tap To Earn: separate rewards balance, daily usage, verified referral tap credits and reviewed USDT payouts.
-- This migration ships with the feature disabled. Rewards are only credited by PostgreSQL.

insert into public.site_settings(setting_key,numeric_value,updated_at,updated_by) values
 ('tap_earn_enabled',0,now(),null),
 ('tap_earn_daily_free_taps',100,now(),null),
 ('tap_earn_reward_per_tap',0.0003,now(),null),
 ('tap_earn_bonus_taps_per_referral',50,now(),null),
 ('tap_earn_min_invites',15,now(),null),
 ('tap_earn_min_withdrawal_usd',1.00,now(),null),
 ('tap_earn_max_withdrawal_usd',10000000,now(),null)
on conflict(setting_key) do nothing;

create table if not exists public.tap_earn_accounts (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 balance numeric(20,8) not null default 0 check(balance>=0),
 total_earned numeric(20,8) not null default 0 check(total_earned>=0),
 bonus_taps_available integer not null default 0 check(bonus_taps_available>=0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists public.tap_earn_daily_usage (
 user_id uuid not null references public.profiles(id) on delete cascade,
 usage_date date not null,
 free_taps_used integer not null default 0 check(free_taps_used>=0),
 updated_at timestamptz not null default now(),
 primary key(user_id,usage_date)
);
create table if not exists public.tap_earn_ledger (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 amount numeric(20,8) not null default 0,
 tap_count integer not null default 0,
 entry_type text not null,
 description text not null,
 reference_type text,
 reference_id uuid,
 created_at timestamptz not null default now()
);
create table if not exists public.tap_earn_withdrawals (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete cascade,
 amount numeric(20,8) not null check(amount>0),
 asset text not null default 'USDT' check(asset='USDT'),
 network text not null check(network in ('TRC20','ERC20','BEP20')),
 destination_address text not null,
 status text not null default 'pending' check(status in ('pending','under_review','approved','declined','paid')),
 admin_note text,
 tx_hash text,
 created_at timestamptz not null default now(),
 reviewed_at timestamptz,
 paid_at timestamptz,
 paid_by uuid references public.profiles(id)
);
create index if not exists tap_earn_ledger_user_created_idx on public.tap_earn_ledger(user_id,created_at desc);
create unique index if not exists tap_earn_ledger_reference_unique on public.tap_earn_ledger(user_id,entry_type,reference_type,reference_id) where reference_id is not null;
create index if not exists tap_earn_withdrawals_user_created_idx on public.tap_earn_withdrawals(user_id,created_at desc);
create index if not exists tap_earn_withdrawals_status_created_idx on public.tap_earn_withdrawals(status,created_at desc);

alter table public.tap_earn_accounts enable row level security;
alter table public.tap_earn_daily_usage enable row level security;
alter table public.tap_earn_ledger enable row level security;
alter table public.tap_earn_withdrawals enable row level security;
revoke all on public.tap_earn_accounts from public,anon,authenticated;
revoke all on public.tap_earn_daily_usage from public,anon,authenticated;
revoke all on public.tap_earn_ledger from public,anon,authenticated;
revoke all on public.tap_earn_withdrawals from public,anon,authenticated;

CREATE OR REPLACE FUNCTION private.zc_tap_earn_award_referral_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_bonus integer;
 v_ledger_id uuid;
begin
 select greatest(0,round(coalesce(numeric_value,50)))::integer
   into v_bonus
   from public.site_settings
  where setting_key='tap_earn_bonus_taps_per_referral';
 v_bonus := coalesce(v_bonus,50);
 if v_bonus <= 0 then return new; end if;

 insert into public.tap_earn_accounts(user_id)
 values(new.referrer_id)
 on conflict(user_id) do nothing;

 insert into public.tap_earn_ledger(
   user_id,amount,tap_count,entry_type,description,reference_type,reference_id
 )
 values(
   new.referrer_id,0,v_bonus,'referral_bonus',
   '50 bonus taps for a verified referral','referral',new.id
 )
 on conflict do nothing
 returning id into v_ledger_id;

 if v_ledger_id is not null then
   update public.tap_earn_accounts
      set bonus_taps_available=bonus_taps_available+v_bonus,
          updated_at=now()
    where user_id=new.referrer_id;
 end if;
 return new;
end;
$function$


revoke all on function private.zc_tap_earn_award_referral_bonus() from public,anon,authenticated;
drop trigger if exists zc_tap_earn_referral_bonus on public.referrals;
create trigger zc_tap_earn_referral_bonus after insert on public.referrals
 for each row execute function private.zc_tap_earn_award_referral_bonus();

do $backfill$
declare v_ref record; v_bonus integer; v_ledger_id uuid;
begin
 select greatest(0,round(coalesce(numeric_value,50)))::integer into v_bonus
 from public.site_settings where setting_key='tap_earn_bonus_taps_per_referral';
 v_bonus:=coalesce(v_bonus,50);
 if v_bonus>0 then
  for v_ref in select id,referrer_id from public.referrals order by created_at loop
   insert into public.tap_earn_accounts(user_id) values(v_ref.referrer_id) on conflict(user_id) do nothing;
   insert into public.tap_earn_ledger(user_id,amount,tap_count,entry_type,description,reference_type,reference_id)
   values(v_ref.referrer_id,0,v_bonus,'referral_bonus','50 bonus taps for an existing verified referral','referral',v_ref.id)
   on conflict do nothing returning id into v_ledger_id;
   if v_ledger_id is not null then update public.tap_earn_accounts set bonus_taps_available=bonus_taps_available+v_bonus,updated_at=now() where user_id=v_ref.referrer_id; end if;
   v_ledger_id:=null;
  end loop;
 end if;
end;
$backfill$;

CREATE OR REPLACE FUNCTION public.tap_earn_admin_approve_withdrawal(p_request_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_uid uuid:=auth.uid();
 v_req public.tap_earn_withdrawals%rowtype;
begin
 if v_uid is null or not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
 select * into v_req from public.tap_earn_withdrawals where id=p_request_id for update;
 if not found then raise exception 'Tap withdrawal request not found'; end if;
 if v_req.status not in ('pending','under_review','approved') then raise exception 'This request is already completed'; end if;
 update public.tap_earn_withdrawals
    set status='approved',reviewed_at=now(),admin_note=coalesce(admin_note,'Approved for payout')
  where id=p_request_id;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
 values(v_uid,'tap_withdrawal_approved','tap_earn_withdrawal',p_request_id,
   jsonb_build_object('user_id',v_req.user_id,'amount',v_req.amount,'network',v_req.network));
 return p_request_id;
end;
$function$


CREATE OR REPLACE FUNCTION public.tap_earn_admin_decline_withdrawal(p_request_id uuid, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_uid uuid:=auth.uid();
 v_req public.tap_earn_withdrawals%rowtype;
begin
 if v_uid is null or not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
 select * into v_req from public.tap_earn_withdrawals where id=p_request_id for update;
 if not found then raise exception 'Tap withdrawal request not found'; end if;
 if v_req.status not in ('pending','under_review','approved') then raise exception 'This request is already completed'; end if;
 update public.tap_earn_withdrawals
    set status='declined',
        reviewed_at=now(),
        admin_note=coalesce(nullif(btrim(p_note),''),'Tap To Earn withdrawal declined')
  where id=p_request_id;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
 values(v_uid,'tap_withdrawal_declined','tap_earn_withdrawal',p_request_id,
   jsonb_build_object('user_id',v_req.user_id,'amount',v_req.amount,'note',p_note));
 return p_request_id;
end;
$function$


CREATE OR REPLACE FUNCTION public.tap_earn_admin_pay_withdrawal(p_request_id uuid, p_tx_hash text, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_uid uuid:=auth.uid();
 v_req public.tap_earn_withdrawals%rowtype;
 v_balance numeric(20,8);
begin
 if v_uid is null or not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
 if p_tx_hash is null or length(btrim(p_tx_hash))<20 then raise exception 'Enter the payout transaction hash'; end if;

 select * into v_req from public.tap_earn_withdrawals where id=p_request_id for update;
 if not found then raise exception 'Tap withdrawal request not found'; end if;
 if v_req.status not in ('pending','under_review','approved') then raise exception 'This request is already completed'; end if;

 perform pg_advisory_xact_lock(hashtextextended(v_req.user_id::text,9101));
 select balance into v_balance
   from public.tap_earn_accounts where user_id=v_req.user_id for update;
 if coalesce(v_balance,0)<v_req.amount then raise exception 'Tap balance is lower than the requested payout'; end if;

 update public.tap_earn_accounts
    set balance=balance-v_req.amount,updated_at=now()
  where user_id=v_req.user_id;

 insert into public.tap_earn_ledger(
   user_id,amount,tap_count,entry_type,description,reference_type,reference_id
 )
 values(
   v_req.user_id,-v_req.amount,0,'withdrawal',
   'Tap To Earn withdrawal paid','withdrawal',v_req.id
 );

 update public.tap_earn_withdrawals
    set status='paid',tx_hash=btrim(p_tx_hash),admin_note=nullif(btrim(coalesce(p_note,'')),''),
        reviewed_at=now(),paid_at=now(),paid_by=v_uid
  where id=p_request_id;

 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
 values(v_uid,'tap_withdrawal_paid','tap_earn_withdrawal',p_request_id,
   jsonb_build_object('user_id',v_req.user_id,'amount',v_req.amount,'network',v_req.network,'tx_hash',btrim(p_tx_hash)));
 return p_request_id;
end;
$function$


CREATE OR REPLACE FUNCTION public.tap_earn_admin_save_settings(p_enabled boolean, p_daily_free_taps integer, p_reward_per_tap numeric, p_bonus_taps_per_referral integer, p_minimum_invites integer, p_minimum_withdrawal_usd numeric, p_maximum_withdrawal_usd numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_uid uuid := auth.uid();
begin
 if v_uid is null or not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
 if p_daily_free_taps is null or p_daily_free_taps<1 or p_daily_free_taps>10000 then
   raise exception 'Daily free taps must be between 1 and 10,000';
 end if;
 if p_reward_per_tap is null or p_reward_per_tap<=0 or p_reward_per_tap>1 then
   raise exception 'Reward per tap must be greater than zero and no more than $1';
 end if;
 if p_bonus_taps_per_referral is null or p_bonus_taps_per_referral<0 or p_bonus_taps_per_referral>10000 then
   raise exception 'Bonus taps must be between 0 and 10,000';
 end if;
 if p_minimum_invites is null or p_minimum_invites<0 or p_minimum_invites>100000 then
   raise exception 'Minimum invites must be between 0 and 100,000';
 end if;
 if p_minimum_withdrawal_usd is null or p_minimum_withdrawal_usd<=0 then
   raise exception 'Minimum Tap To Earn withdrawal must be greater than zero';
 end if;
 if p_maximum_withdrawal_usd is null or p_maximum_withdrawal_usd<p_minimum_withdrawal_usd then
   raise exception 'Maximum withdrawal must be at least the minimum withdrawal';
 end if;

 insert into public.site_settings(setting_key,numeric_value,updated_at,updated_by) values
  ('tap_earn_enabled',case when coalesce(p_enabled,false) then 1 else 0 end,now(),v_uid),
  ('tap_earn_daily_free_taps',p_daily_free_taps,now(),v_uid),
  ('tap_earn_reward_per_tap',round(p_reward_per_tap,8),now(),v_uid),
  ('tap_earn_bonus_taps_per_referral',p_bonus_taps_per_referral,now(),v_uid),
  ('tap_earn_min_invites',p_minimum_invites,now(),v_uid),
  ('tap_earn_min_withdrawal_usd',round(p_minimum_withdrawal_usd,8),now(),v_uid),
  ('tap_earn_max_withdrawal_usd',round(p_maximum_withdrawal_usd,8),now(),v_uid)
 on conflict(setting_key) do update set
  numeric_value=excluded.numeric_value,updated_at=excluded.updated_at,updated_by=excluded.updated_by;

 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
 values(v_uid,'tap_earn_settings_updated','tap_earn_settings',null::uuid,
   jsonb_build_object(
    'enabled',p_enabled,'daily_free_taps',p_daily_free_taps,
    'reward_per_tap',p_reward_per_tap,'bonus_taps_per_referral',p_bonus_taps_per_referral,
    'minimum_invites',p_minimum_invites,'minimum_withdrawal_usd',p_minimum_withdrawal_usd,
    'maximum_withdrawal_usd',p_maximum_withdrawal_usd
   ));
 return true;
end;
$function$


CREATE OR REPLACE FUNCTION public.tap_earn_admin_state()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_settings jsonb;
 v_requests jsonb;
begin
 if auth.uid() is null or not (select private.is_admin()) then
   raise exception 'Administrator access required';
 end if;

 select jsonb_build_object(
   'enabled',coalesce(max(numeric_value) filter(where setting_key='tap_earn_enabled'),0)>=1,
   'daily_free_taps',coalesce(max(numeric_value) filter(where setting_key='tap_earn_daily_free_taps'),100),
   'reward_per_tap',coalesce(max(numeric_value) filter(where setting_key='tap_earn_reward_per_tap'),0.0003),
   'bonus_taps_per_referral',coalesce(max(numeric_value) filter(where setting_key='tap_earn_bonus_taps_per_referral'),50),
   'minimum_invites',coalesce(max(numeric_value) filter(where setting_key='tap_earn_min_invites'),15),
   'minimum_withdrawal_usd',coalesce(max(numeric_value) filter(where setting_key='tap_earn_min_withdrawal_usd'),1.00),
   'maximum_withdrawal_usd',coalesce(max(numeric_value) filter(where setting_key='tap_earn_max_withdrawal_usd'),10000000)
 ) into v_settings
 from public.site_settings
 where setting_key like 'tap_earn_%';

 select coalesce(jsonb_agg(jsonb_build_object(
   'id',w.id,'user_id',w.user_id,'name',coalesce(nullif(p.full_name,''),p.email),
   'email',p.email,'amount',w.amount,'asset',w.asset,'network',w.network,
   'destination_address',w.destination_address,'status',w.status,
   'admin_note',w.admin_note,'tx_hash',w.tx_hash,'created_at',w.created_at
 ) order by w.created_at desc),'[]'::jsonb)
 into v_requests
 from (
   select * from public.tap_earn_withdrawals order by created_at desc limit 100
 ) w
 left join public.profiles p on p.id=w.user_id;

 return jsonb_build_object('settings',v_settings,'withdrawals',v_requests);
end;
$function$


CREATE OR REPLACE FUNCTION public.tap_earn_claim(p_taps integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_uid uuid := auth.uid();
 v_enabled numeric;
 v_daily_limit integer;
 v_reward numeric(20,8);
 v_today date := (now() at time zone 'UTC')::date;
 v_used integer := 0;
 v_bonus integer := 0;
 v_free_remaining integer := 0;
 v_free_use integer := 0;
 v_bonus_use integer := 0;
 v_credit numeric(20,8);
begin
 if v_uid is null then raise exception 'Authentication required'; end if;
 if p_taps is null or p_taps<1 or p_taps>10 then
   raise exception 'Tap count must be between 1 and 10';
 end if;

 select coalesce(max(numeric_value) filter(where setting_key='tap_earn_enabled'),0),
        coalesce(max(numeric_value) filter(where setting_key='tap_earn_daily_free_taps'),100)::integer,
        coalesce(max(numeric_value) filter(where setting_key='tap_earn_reward_per_tap'),0.0003)
   into v_enabled,v_daily_limit,v_reward
   from public.site_settings
  where setting_key in ('tap_earn_enabled','tap_earn_daily_free_taps','tap_earn_reward_per_tap');

 if coalesce(v_enabled,0)<1 then raise exception 'Tap To Earn is currently disabled'; end if;
 if coalesce(v_reward,0)<=0 then raise exception 'Tap rewards are temporarily unavailable'; end if;

 perform pg_advisory_xact_lock(hashtextextended(v_uid::text,9101));
 insert into public.tap_earn_accounts(user_id) values(v_uid)
 on conflict(user_id) do nothing;
 insert into public.tap_earn_daily_usage(user_id,usage_date,free_taps_used)
 values(v_uid,v_today,0)
 on conflict(user_id,usage_date) do nothing;

 select free_taps_used into v_used
   from public.tap_earn_daily_usage
  where user_id=v_uid and usage_date=v_today for update;
 select bonus_taps_available into v_bonus
   from public.tap_earn_accounts where user_id=v_uid for update;

 v_free_remaining:=greatest(0,coalesce(v_daily_limit,100)-coalesce(v_used,0));
 v_free_use:=least(p_taps,v_free_remaining);
 v_bonus_use:=p_taps-v_free_use;
 if v_bonus_use>coalesce(v_bonus,0) then
   raise exception 'Daily free taps are finished. Invite someone to receive 50 extra taps.';
 end if;

 update public.tap_earn_daily_usage
    set free_taps_used=free_taps_used+v_free_use,updated_at=now()
  where user_id=v_uid and usage_date=v_today;

 update public.tap_earn_accounts
    set balance=balance+(v_reward*p_taps),
        total_earned=total_earned+(v_reward*p_taps),
        bonus_taps_available=bonus_taps_available-v_bonus_use,
        updated_at=now()
  where user_id=v_uid;

 v_credit:=round(v_reward*p_taps,8);
 insert into public.tap_earn_ledger(user_id,amount,tap_count,entry_type,description)
 values(
   v_uid,v_credit,p_taps,'tap_reward',
   'Tap To Earn reward ('||p_taps::text||' tap'||case when p_taps=1 then '' else 's' end||')'
 );

 return public.tap_earn_state() || jsonb_build_object(
   'last_claim_taps',p_taps,'last_claim_reward',v_credit
 );
end;
$function$


CREATE OR REPLACE FUNCTION public.tap_earn_is_enabled()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_uid uuid := auth.uid();
 v_enabled numeric;
begin
 if v_uid is null then return false; end if;
 select numeric_value into v_enabled
   from public.site_settings where setting_key='tap_earn_enabled';
 return coalesce(v_enabled,0)>=1;
end;
$function$


CREATE OR REPLACE FUNCTION public.tap_earn_request_withdrawal(p_amount numeric, p_network text, p_destination text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_uid uuid := auth.uid();
 v_enabled numeric;
 v_min_invites integer;
 v_min_withdraw numeric(20,8);
 v_max_withdraw numeric(20,8);
 v_invites integer;
 v_balance numeric(20,8);
 v_reserved numeric(20,8);
 v_amount numeric(20,8);
 v_request_id uuid;
begin
 if v_uid is null then raise exception 'Authentication required'; end if;
 select coalesce(max(numeric_value) filter(where setting_key='tap_earn_enabled'),0),
        coalesce(max(numeric_value) filter(where setting_key='tap_earn_min_invites'),15)::integer,
        coalesce(max(numeric_value) filter(where setting_key='tap_earn_min_withdrawal_usd'),1.00),
        coalesce(max(numeric_value) filter(where setting_key='tap_earn_max_withdrawal_usd'),10000000)
   into v_enabled,v_min_invites,v_min_withdraw,v_max_withdraw
   from public.site_settings
  where setting_key in ('tap_earn_enabled','tap_earn_min_invites','tap_earn_min_withdrawal_usd','tap_earn_max_withdrawal_usd');

 if coalesce(v_enabled,0)<1 then raise exception 'Tap To Earn is currently disabled'; end if;
 v_amount:=round(p_amount,8);
 if v_amount is null or v_amount<coalesce(v_min_withdraw,1) or v_amount>coalesce(v_max_withdraw,10000000) then
   raise exception 'Withdrawal amount must be between $% and $% USD',
     coalesce(v_min_withdraw,1),coalesce(v_max_withdraw,10000000);
 end if;

 if p_network is null or p_network not in ('TRC20','ERC20','BEP20') then raise exception 'Choose a supported USDT network'; end if;
 if p_destination is null then raise exception 'USDT destination address is required'; end if;
 if p_network='TRC20' and p_destination !~ '^T[1-9A-HJ-NP-Za-km-z]{33}$' then
   raise exception 'Enter a valid TRC20 USDT address';
 elsif p_network in ('ERC20','BEP20') and p_destination !~ '^0x[a-fA-F0-9]{40}$' then
   raise exception 'Enter a valid EVM USDT address';
 end if;

 perform pg_advisory_xact_lock(hashtextextended(v_uid::text,9101));
 select count(*)::integer into v_invites from public.referrals where referrer_id=v_uid;
 if coalesce(v_invites,0)<greatest(0,coalesce(v_min_invites,15)) then
   raise exception 'You need % verified invites before withdrawing. Current invites: %',
     greatest(0,coalesce(v_min_invites,15)),coalesce(v_invites,0);
 end if;

 insert into public.tap_earn_accounts(user_id) values(v_uid)
 on conflict(user_id) do nothing;
 select balance into v_balance
   from public.tap_earn_accounts where user_id=v_uid for update;
 select coalesce(sum(amount),0)::numeric(20,8) into v_reserved
   from public.tap_earn_withdrawals
  where user_id=v_uid and status in ('pending','under_review','approved');
 if v_amount>greatest(0,coalesce(v_balance,0)-coalesce(v_reserved,0)) then
   raise exception 'Insufficient Tap Balance. Available: $%',round(greatest(0,coalesce(v_balance,0)-coalesce(v_reserved,0)),8);
 end if;

 insert into public.tap_earn_withdrawals(user_id,amount,asset,network,destination_address,status)
 values(v_uid,v_amount,'USDT',p_network,btrim(p_destination),'pending')
 returning id into v_request_id;
 return v_request_id;
end;
$function$


CREATE OR REPLACE FUNCTION public.tap_earn_state()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_uid uuid := auth.uid();
 v_enabled numeric;
 v_daily_limit integer;
 v_reward numeric(20,8);
 v_bonus_per_referral integer;
 v_min_invites integer;
 v_min_withdraw numeric(20,8);
 v_max_withdraw numeric(20,8);
 v_today date := (now() at time zone 'UTC')::date;
 v_used integer := 0;
 v_balance numeric(20,8) := 0;
 v_total_earned numeric(20,8) := 0;
 v_bonus integer := 0;
 v_invites integer := 0;
 v_reserved numeric(20,8) := 0;
 v_history jsonb := '[]'::jsonb;
begin
 if v_uid is null then raise exception 'Authentication required'; end if;
 select coalesce(max(numeric_value) filter(where setting_key='tap_earn_enabled'),0),
        coalesce(max(numeric_value) filter(where setting_key='tap_earn_daily_free_taps'),100)::integer,
        coalesce(max(numeric_value) filter(where setting_key='tap_earn_reward_per_tap'),0.0003),
        coalesce(max(numeric_value) filter(where setting_key='tap_earn_bonus_taps_per_referral'),50)::integer,
        coalesce(max(numeric_value) filter(where setting_key='tap_earn_min_invites'),15)::integer,
        coalesce(max(numeric_value) filter(where setting_key='tap_earn_min_withdrawal_usd'),1.00),
        coalesce(max(numeric_value) filter(where setting_key='tap_earn_max_withdrawal_usd'),10000000)
   into v_enabled,v_daily_limit,v_reward,v_bonus_per_referral,v_min_invites,v_min_withdraw,v_max_withdraw
   from public.site_settings
  where setting_key in (
   'tap_earn_enabled','tap_earn_daily_free_taps','tap_earn_reward_per_tap',
   'tap_earn_bonus_taps_per_referral','tap_earn_min_invites',
   'tap_earn_min_withdrawal_usd','tap_earn_max_withdrawal_usd'
  );
 if coalesce(v_enabled,0)<1 then raise exception 'Tap To Earn is currently disabled'; end if;
 insert into public.tap_earn_accounts(user_id) values(v_uid) on conflict(user_id) do nothing;
 select balance,total_earned,bonus_taps_available into v_balance,v_total_earned,v_bonus
   from public.tap_earn_accounts where user_id=v_uid;
 select free_taps_used into v_used from public.tap_earn_daily_usage
  where user_id=v_uid and usage_date=v_today;
 select count(*)::integer into v_invites from public.referrals where referrer_id=v_uid;
 select coalesce(sum(amount),0)::numeric(20,8) into v_reserved
   from public.tap_earn_withdrawals
  where user_id=v_uid and status in ('pending','under_review','approved');
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',h.id,'amount',h.amount,'asset',h.asset,'network',h.network,
   'status',h.status,'created_at',h.created_at,'tx_hash',h.tx_hash,'admin_note',h.admin_note
 ) order by h.created_at desc),'[]'::jsonb)
 into v_history
 from (
   select id,amount,asset,network,status,created_at,tx_hash,admin_note
    from public.tap_earn_withdrawals where user_id=v_uid order by created_at desc limit 10
 ) h;
 return jsonb_build_object(
   'enabled',true,'currency','USD','asset','USDT',
   'tap_balance',coalesce(v_balance,0),'total_earned',coalesce(v_total_earned,0),
   'reward_per_tap',coalesce(v_reward,0.0003),
   'daily_free_taps',greatest(0,coalesce(v_daily_limit,100)),
   'free_taps_used',coalesce(v_used,0),
   'free_taps_remaining',greatest(0,coalesce(v_daily_limit,100)-coalesce(v_used,0)),
   'bonus_taps_available',coalesce(v_bonus,0),
   'bonus_taps_per_referral',greatest(0,coalesce(v_bonus_per_referral,50)),
   'invite_count',coalesce(v_invites,0),
   'minimum_invites',greatest(0,coalesce(v_min_invites,15)),
   'minimum_withdrawal_usd',coalesce(v_min_withdraw,1.00),
   'maximum_withdrawal_usd',coalesce(v_max_withdraw,10000000),
   'reserved_withdrawal',coalesce(v_reserved,0),
   'available_balance',greatest(0,coalesce(v_balance,0)-coalesce(v_reserved,0)),
   'daily_reset_timezone','UTC','recent_withdrawals',v_history
 );
end;
$function$


revoke all on function public.tap_earn_is_enabled() from public,anon;
revoke all on function public.tap_earn_state() from public,anon;
revoke all on function public.tap_earn_claim(integer) from public,anon;
revoke all on function public.tap_earn_request_withdrawal(numeric,text,text) from public,anon;
revoke all on function public.tap_earn_admin_state() from public,anon;
revoke all on function public.tap_earn_admin_save_settings(boolean,integer,numeric,integer,integer,numeric,numeric) from public,anon;
revoke all on function public.tap_earn_admin_approve_withdrawal(uuid) from public,anon;
revoke all on function public.tap_earn_admin_decline_withdrawal(uuid,text) from public,anon;
revoke all on function public.tap_earn_admin_pay_withdrawal(uuid,text,text) from public,anon;

grant execute on function public.tap_earn_is_enabled() to authenticated;
grant execute on function public.tap_earn_state() to authenticated;
grant execute on function public.tap_earn_claim(integer) to authenticated;
grant execute on function public.tap_earn_request_withdrawal(numeric,text,text) to authenticated;
grant execute on function public.tap_earn_admin_state() to authenticated;
grant execute on function public.tap_earn_admin_save_settings(boolean,integer,numeric,integer,integer,numeric,numeric) to authenticated;
grant execute on function public.tap_earn_admin_approve_withdrawal(uuid) to authenticated;
grant execute on function public.tap_earn_admin_decline_withdrawal(uuid,text) to authenticated;
grant execute on function public.tap_earn_admin_pay_withdrawal(uuid,text,text) to authenticated;
