-- ============================================================================
-- Admin FAQ manager, referral rewards (join bonus + deposit share) and the
-- admin treasury wallet.
-- Idempotent: safe to run again. Run in the SQL editor of EVERY Supabase
-- project that hosts this app (sandbox AND production/cloud).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) FAQ manager: admin-editable questions and answers shown on the website.
-- ---------------------------------------------------------------------------
create table if not exists public.faq_items (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.faq_items enable row level security;

drop policy if exists "Anyone reads active FAQs" on public.faq_items;
create policy "Anyone reads active FAQs"
  on public.faq_items for select to anon, authenticated
  using (is_active = true);

drop policy if exists "Admins read every FAQ" on public.faq_items;
create policy "Admins read every FAQ"
  on public.faq_items for select to authenticated
  using ((select private.is_admin()));

drop policy if exists "Admins manage FAQs" on public.faq_items;
create policy "Admins manage FAQs"
  on public.faq_items for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

grant select on public.faq_items to anon, authenticated;
grant insert, update, delete on public.faq_items to authenticated;

-- Seed the help centre once (keeps existing edits when re-run).
insert into public.faq_items (question, answer, sort_order)
select v.question, v.answer, v.sort_order
from (values
  ('Are market prices the same as my account performance?','No. Market prices are third-party reference data. Your account balance is calculated only from ledger entries recorded for your account.',1),
  ('How are deposits confirmed?','Every account has its own unique deposit addresses - always use the address shown in your account for the selected asset and network. Incoming transfers are tracked on the blockchain and credited after the required network confirmations.',2),
  ('How do withdrawals work?','Submit the amount, network and destination address. Each request is checked, then paid with its blockchain transaction hash recorded, so you can verify the transfer yourself on any explorer. Payout timing depends on network conditions.',3),
  ('How are profits generated?','ZentraChain runs automated trading systems that monitor the markets around the clock for opportunities. The percentages shown on plans are targets based on that activity - not guaranteed outcomes. All trading carries risk, including possible loss of capital.',4),
  ('Does the platform guarantee returns?','No. Cryptocurrency trading is high risk. There are no guaranteed profits, and historical results do not predict future results.',5),
  ('Is exchange trading automated?','No exchange API is currently connected to this portal. The market chart is informational and does not execute trades.',6),
  ('How do I contact support?','Use the support contact supplied through your verified company communication channel. Do not trust unsolicited wallet addresses or messages claiming to be support.',7)
) as v(question, answer, sort_order)
where not exists (select 1 from public.faq_items limit 1);

-- ---------------------------------------------------------------------------
-- 2) Referral rewards: join bonus (USD) + share of every credited deposit (%).
--    The inviter earns BOTH automatically.
-- ---------------------------------------------------------------------------
alter table public.referrals
  add column if not exists signup_paid boolean not null default false;

insert into public.site_settings (setting_key, numeric_value)
values
  ('referral_signup_bonus_usd', 0.2),
  ('referral_reward_percent', 5)
on conflict (setting_key) do nothing;

-- Attaching to a referrer now pays the inviter the signup bonus instantly.
create or replace function public.link_referral(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_referrer uuid;
  v_me uuid := auth.uid();
  v_bonus numeric;
  v_row public.referrals%rowtype;
begin
  if v_me is null then raise exception 'Authentication required'; end if;
  if p_code is null or btrim(p_code) = '' then raise exception 'Invalid referral code'; end if;
  select id into v_referrer from public.profiles
    where upper(referral_code) = upper(btrim(p_code)) limit 1;
  if not found then raise exception 'Referral code not found'; end if;
  if v_referrer = v_me then raise exception 'You cannot refer yourself'; end if;
  insert into public.referrals (referrer_id, referred_id)
    values (v_referrer, v_me)
    on conflict (referred_id) do nothing
    returning * into v_row;
  if found then
    select numeric_value into v_bonus from public.site_settings
      where setting_key = 'referral_signup_bonus_usd';
    if v_bonus is not null and v_bonus > 0 then
      insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type, reference_id)
      values (v_referrer, v_bonus, 'bonus', 'Referral signup bonus', 'referral_signup', v_me);
    end if;
    update public.referrals set signup_paid = true where id = v_row.id;
  end if;
  return v_referrer;
end;
$$;

revoke all on function public.link_referral(text) from public;
grant execute on function public.link_referral(text) to authenticated;

-- Every credited deposit of an invited member pays the inviter the share %.
create or replace function public.pay_referral_reward()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref_id uuid;
  v_referrer uuid;
  v_pct numeric;
  v_share numeric;
begin
  if new.entry_type <> 'deposit' or new.amount is null or new.amount <= 0 then
    return new;
  end if;
  select r.id, r.referrer_id into v_ref_id, v_referrer
    from public.referrals r
    where r.referred_id = new.user_id
    limit 1;
  if not found then return new; end if;
  select numeric_value into v_pct from public.site_settings
    where setting_key = 'referral_reward_percent';
  if v_pct is null or v_pct <= 0 then return new; end if;
  v_share := round(new.amount * v_pct / 100.0, 2);
  if v_share <= 0 then return new; end if;
  insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type, reference_id)
  values (v_referrer, v_share, 'bonus',
          'Referral share (' || v_pct || '%) of an invited member deposit',
          'referral_reward', new.user_id);
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (v_referrer, 'referral_deposit_share', 'referral', v_ref_id::text,
          jsonb_build_object('percent', v_pct, 'amount', v_share, 'referred_id', new.user_id));
  return new;
end;
$$;

drop trigger if exists pay_referral_reward_trigger on public.ledger_entries;
create trigger pay_referral_reward_trigger
  after insert on public.ledger_entries
  for each row execute function public.pay_referral_reward();

-- ---------------------------------------------------------------------------
-- 3) Treasury wallet: the administrator records moving pooled customer funds
--    to a trading address, and credits trading profits back to members.
-- ---------------------------------------------------------------------------
create table if not exists public.treasury_withdrawals (
  id uuid primary key default gen_random_uuid(),
  asset_code text not null,
  network_code text not null,
  amount numeric(20,2) not null check (amount > 0),
  destination_address text not null,
  tx_hash text,
  status text not null default 'sent',
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.treasury_withdrawals enable row level security;

drop policy if exists "Admins manage treasury withdrawals" on public.treasury_withdrawals;
create policy "Admins manage treasury withdrawals"
  on public.treasury_withdrawals for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

grant select, insert, update on public.treasury_withdrawals to authenticated;

create or replace function public.admin_record_treasury_withdrawal(
  p_asset text,
  p_network text,
  p_amount numeric,
  p_gas_fee numeric,
  p_destination text,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_destination is null or length(btrim(p_destination)) < 15 then raise exception 'Enter the destination wallet address'; end if;
  insert into public.treasury_withdrawals (asset_code, network_code, amount, destination_address, note, created_by)
  values (upper(btrim(p_asset)), upper(btrim(p_network)), round(p_amount, 2),
          btrim(p_destination), nullif(btrim(coalesce(p_note, '')), ''), v_uid)
  returning id into v_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (v_uid, 'treasury_withdrawal', 'treasury_withdrawal', v_id::text,
          jsonb_build_object('asset', p_asset, 'network', p_network, 'amount', p_amount, 'destination', p_destination));
  return v_id;
end;
$$;

revoke all on function public.admin_record_treasury_withdrawal(text, text, numeric, numeric, text, text) from public;
grant execute on function public.admin_record_treasury_withdrawal(text, text, numeric, numeric, text, text) to authenticated;

create or replace function public.admin_credit_user_funds(
  p_user_id uuid,
  p_amount numeric,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_user_id is null then raise exception 'Choose the member to credit'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type, reference_id)
  values (p_user_id, round(p_amount, 2), 'bonus',
          coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Trading profit credited by administrator'),
          'treasury_credit', p_user_id)
  returning id into v_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (v_uid, 'treasury_profit_credit', 'ledger_entry', v_id::text,
          jsonb_build_object('user_id', p_user_id, 'amount', p_amount, 'note', p_note));
  return v_id;
end;
$$;

revoke all on function public.admin_credit_user_funds(uuid, numeric, text) from public;
grant execute on function public.admin_credit_user_funds(uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Per-member treasury withdrawal: the administrator moves ONE member's
--    funds to a trading address. Deducts the amount from that member's
--    available balance and records the treasury movement.
-- ---------------------------------------------------------------------------
alter table public.treasury_withdrawals
  add column if not exists user_id uuid references auth.users(id);
alter table public.treasury_withdrawals
  add column if not exists gas_fee numeric(20,2) not null default 0;

create or replace function public.admin_treasury_withdraw_from_user(
  p_user_id uuid,
  p_asset text,
  p_network text,
  p_amount numeric,
  p_gas_fee numeric,
  p_destination text,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_bal numeric;
  v_res numeric;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_user_id is null then raise exception 'Choose the member to withdraw from'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_gas_fee is null then p_gas_fee := 0; end if;
  if p_gas_fee < 0 then raise exception 'Gas fee cannot be negative'; end if;
  if p_destination is null or length(btrim(p_destination)) < 15 then raise exception 'Enter the destination wallet address'; end if;
  select coalesce(sum(amount), 0) into v_bal from public.ledger_entries where user_id = p_user_id;
  select coalesce(sum(amount), 0) into v_res from public.withdrawal_requests
    where user_id = p_user_id and status in ('pending','under_review','approved');
  if (p_amount + p_gas_fee) > (v_bal - v_res) then
    raise exception 'Member does not have enough available balance (% left)', (v_bal - v_res);
  end if;
  insert into public.treasury_withdrawals (asset_code, network_code, amount, gas_fee, destination_address, note, user_id, created_by)
  values (upper(btrim(p_asset)), upper(btrim(p_network)), round(p_amount, 2), round(p_gas_fee, 2), btrim(p_destination),
          nullif(btrim(coalesce(p_note, '')), ''), p_user_id, v_uid)
  returning id into v_id;
  insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type, reference_id)
  values (p_user_id, -(round(p_amount, 2) + round(p_gas_fee, 2)), 'withdrawal',
          case when p_gas_fee > 0
            then 'Treasury withdrawal with gas fee ' || round(p_gas_fee, 2)::text
            else 'Funds moved to treasury trading wallet' end,
          'treasury_withdrawal', v_id);
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (v_uid, 'treasury_withdrawal_from_member', 'treasury_withdrawal', v_id::text,
          jsonb_build_object('user_id', p_user_id, 'asset', p_asset, 'network', p_network, 'amount', p_amount, 'destination', p_destination));
  return v_id;
end;
$$;

drop function if exists public.admin_treasury_withdraw_from_user(uuid, text, text, numeric, text, text);
revoke all on function public.admin_treasury_withdraw_from_user(uuid, text, text, numeric, numeric, text, text) from public;
grant execute on function public.admin_treasury_withdraw_from_user(uuid, text, text, numeric, numeric, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 5) Member management: ledger adjustments + profile control (ban/restrict).
-- ---------------------------------------------------------------------------
create or replace function public.admin_adjust_user_ledger(
  p_user_id uuid,
  p_amount numeric,
  p_entry_type text,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_bal numeric;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_user_id is null then raise exception 'Choose the member'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Enter a non-zero amount'; end if;
  if p_entry_type not in ('deposit','bonus','adjustment') then p_entry_type := 'adjustment'; end if;
  select coalesce(sum(amount),0) into v_bal from public.ledger_entries where user_id = p_user_id;
  if v_bal + p_amount < 0 then raise exception 'Adjustment would make the balance negative (current %)', v_bal; end if;
  insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type, reference_id)
  values (p_user_id, round(p_amount,2),
          coalesce(nullif(btrim(p_entry_type),''),'adjustment'),
          coalesce(nullif(btrim(coalesce(p_note,'')),''), 'Administrator balance adjustment'),
          'admin_adjustment', p_user_id)
  returning id into v_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (v_uid, 'balance_adjusted', 'ledger_entry', v_id::text,
          jsonb_build_object('user_id', p_user_id, 'amount', p_amount, 'note', p_note));
  return v_id;
end;
$$;

revoke all on function public.admin_adjust_user_ledger(uuid, numeric, text, text) from public;
grant execute on function public.admin_adjust_user_ledger(uuid, numeric, text, text) to authenticated;

create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_full_name text,
  p_role text,
  p_payout_frozen boolean,
  p_banned boolean,
  p_banned_reason text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_user_id is null then raise exception 'Choose the member'; end if;
  if p_role is not null and p_role not in ('user','admin') then raise exception 'Invalid role'; end if;
  update public.profiles set
    full_name = coalesce(p_full_name, full_name),
    role = coalesce(p_role, role),
    payout_frozen = coalesce(p_payout_frozen, payout_frozen),
    banned_reason = case when p_banned is null then banned_reason when p_banned then coalesce(nullif(btrim(coalesce(p_banned_reason,'')),''),'Account restricted by administrator') else null end,
    updated_at = now()
  where id = p_user_id;
  if not found then raise exception 'Member not found'; end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (v_uid, 'profile_updated', 'profiles', p_user_id::text,
          jsonb_build_object('full_name', p_full_name, 'role', p_role, 'payout_frozen', p_payout_frozen, 'banned', p_banned, 'banned_reason', p_banned_reason));
  return true;
end;
$$;

revoke all on function public.admin_update_profile(uuid, text, text, boolean, boolean, text) from public;
grant execute on function public.admin_update_profile(uuid, text, text, boolean, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Claimable email bonuses.
-- ---------------------------------------------------------------------------
create table if not exists public.email_bonuses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(20,2) not null check (amount > 0),
  code text not null unique default upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)),
  note text,
  status text not null default 'pending' check (status in ('pending','claimed','cancelled')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);

alter table public.email_bonuses enable row level security;

drop policy if exists "Admins manage email bonuses" on public.email_bonuses;
create policy "Admins manage email bonuses"
  on public.email_bonuses for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

drop policy if exists "Members read own bonuses" on public.email_bonuses;
create policy "Members read own bonuses"
  on public.email_bonuses for select to authenticated
  using (user_id = (select auth.uid()));

grant select, insert, update on public.email_bonuses to authenticated;

create or replace function public.admin_create_email_bonus(
  p_user_id uuid,
  p_amount numeric,
  p_note text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_user_id is null then raise exception 'Choose the member'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Bonus amount must be greater than zero'; end if;
  v_code := upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
  insert into public.email_bonuses (user_id, amount, note, created_by)
  values (p_user_id, round(p_amount,2), nullif(btrim(coalesce(p_note,'')),''), v_uid)
  returning code into v_code;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (v_uid, 'email_bonus_created', 'email_bonuses', v_code,
          jsonb_build_object('user_id', p_user_id, 'amount', p_amount));
  return v_code;
end;
$$;

revoke all on function public.admin_create_email_bonus(uuid, numeric, text) from public;
grant execute on function public.admin_create_email_bonus(uuid, numeric, text) to authenticated;

create or replace function public.claim_email_bonus(p_code text)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_bonus public.email_bonuses%rowtype;
begin
  if v_me is null then raise exception 'Log in to claim your bonus'; end if;
  if p_code is null or btrim(p_code) = '' then raise exception 'Invalid bonus code'; end if;
  select * into v_bonus from public.email_bonuses
    where upper(code) = upper(btrim(p_code)) and user_id = v_me
    for update;
  if not found then raise exception 'This bonus is not for your account'; end if;
  if v_bonus.status <> 'pending' then raise exception 'This bonus was already claimed'; end if;
  update public.email_bonuses set status = 'claimed', claimed_at = now() where id = v_bonus.id;
  insert into public.ledger_entries (user_id, amount, entry_type, description, reference_type, reference_id)
  values (v_me, v_bonus.amount, 'bonus',
          coalesce(v_bonus.note, 'Bonus claimed from email'), 'email_bonus', v_bonus.id);
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (v_me, 'email_bonus_claimed', 'email_bonuses', v_bonus.id::text,
          jsonb_build_object('amount', v_bonus.amount));
  return v_bonus.amount;
end;
$$;

revoke all on function public.claim_email_bonus(text) from public;
grant execute on function public.claim_email_bonus(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Email outbox + automatic deposit / withdrawal emails.
-- ---------------------------------------------------------------------------
create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  to_email text not null,
  subject text not null,
  html text not null,
  kind text not null default 'custom',
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table public.email_outbox enable row level security;

drop policy if exists "Admins manage email outbox" on public.email_outbox;
create policy "Admins manage email outbox"
  on public.email_outbox for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

grant select, insert, update on public.email_outbox to authenticated;

create or replace function public.zc_email_site_url()
returns text
language sql
security definer
set search_path = ''
as $$
  select coalesce((select numeric_value::text from public.site_settings where setting_key='site_url'),'');
$$;

create or replace function public.queue_transaction_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_name text;
  v_url text;
  v_html text;
begin
  if new.entry_type <> 'deposit' or new.amount is null or new.amount <= 0 then return new; end if;
  select coalesce(u.email,''), coalesce(p.full_name,'') into v_email, v_name
    from auth.users u join public.profiles p on p.id = u.id
    where u.id = new.user_id;
  if coalesce(v_email,'') = '' then return new; end if;
  v_url := public.zc_email_site_url();
  v_html := '<div style="font-family:Arial,Helvetica,sans-serif;background:#f4f6f5;padding:32px 12px">' ||
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e3e8e6">' ||
    '<div style="background:#06180f;padding:22px 26px;color:#9be8c5;font-weight:800;letter-spacing:2px">ZENTRACHAIN</div>' ||
    '<div style="padding:28px 26px;color:#17322a">' ||
    '<h2 style="margin:0 0 6px">Deposit successful</h2>' ||
    '<p style="margin:0 0 18px;color:#5f7a6f">Hi ' || coalesce(nullif(v_name,''),'there') || ', your deposit has been verified and credited.</p>' ||
    '<div style="border:1px solid #e3e8e6;border-radius:12px;padding:14px 16px;margin-bottom:18px">' ||
    '<div style="color:#5f7a6f;font-size:13px">Amount credited</div>' ||
    '<div style="font-size:24px;font-weight:800">$' || round(new.amount,2)::text || ' USDT</div>' ||
    '<div style="color:#5f7a6f;font-size:13px;margin-top:6px">Your new balance is available in your dashboard.</div></div>' ||
    (case when coalesce(v_url,'') <> '' then '<a href="' || v_url || '" style="display:inline-block;background:#20c783;color:#06180f;font-weight:800;padding:12px 22px;border-radius:10px;text-decoration:none">Open your dashboard</a>' else '' end) ||
    '<p style="margin:18px 0 0;color:#7c938a;font-size:12px">You did not request this? Contact support immediately — never share your password or codes.</p>' ||
    '</div></div></div>';
  insert into public.email_outbox (to_email, subject, html, kind)
  values (v_email, 'Deposit successful — $' || round(new.amount,2)::text || ' credited', v_html, 'deposit');
  return new;
end;
$$;

drop trigger if exists zc_deposit_email_trigger on public.ledger_entries;
create trigger zc_deposit_email_trigger
  after insert on public.ledger_entries
  for each row execute function public.queue_transaction_email();

create or replace function public.queue_withdrawal_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_name text;
  v_url text;
  v_html text;
begin
  if new.status is distinct from 'paid' then return new; end if;
  select coalesce(u.email,''), coalesce(p.full_name,'') into v_email, v_name
    from auth.users u join public.profiles p on p.id = u.id
    where u.id = new.user_id;
  if coalesce(v_email,'') = '' then return new; end if;
  v_url := public.zc_email_site_url();
  v_html := '<div style="font-family:Arial,Helvetica,sans-serif;background:#f4f6f5;padding:32px 12px">' ||
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e3e8e6">' ||
    '<div style="background:#06180f;padding:22px 26px;color:#9be8c5;font-weight:800;letter-spacing:2px">ZENTRACHAIN</div>' ||
    '<div style="padding:28px 26px;color:#17322a">' ||
    '<h2 style="margin:0 0 6px">Withdrawal completed</h2>' ||
    '<p style="margin:0 0 18px;color:#5f7a6f">Hi ' || coalesce(nullif(v_name,''),'there') || ', your withdrawal has been paid on-chain.</p>' ||
    '<div style="border:1px solid #e3e8e6;border-radius:12px;padding:14px 16px;margin-bottom:18px">' ||
    '<div style="color:#5f7a6f;font-size:13px">Amount withdrawn</div>' ||
    '<div style="font-size:24px;font-weight:800">$' || round(new.amount,2)::text || '</div>' ||
    '<div style="color:#5f7a6f;font-size:13px;margin-top:6px">Network: ' || coalesce(new.network,'—') || '</div>' ||
    (case when coalesce(new.tx_hash,'') <> '' then '<div style="color:#5f7a6f;font-size:13px;margin-top:6px;overflow-wrap:anywhere">Transaction: ' || new.tx_hash || '</div>' else '' end) || '</div>' ||
    (case when coalesce(v_url,'') <> '' then '<a href="' || v_url || '" style="display:inline-block;background:#20c783;color:#06180f;font-weight:800;padding:12px 22px;border-radius:10px;text-decoration:none">Open your dashboard</a>' else '' end) ||
    '<p style="margin:18px 0 0;color:#7c938a;font-size:12px">Was not you? Contact support immediately.</p>' ||
    '</div></div></div>';
  insert into public.email_outbox (to_email, subject, html, kind)
  values (v_email, 'Withdrawal completed — $' || round(new.amount,2)::text || ' sent', v_html, 'withdrawal');
  return new;
end;
$$;

drop trigger if exists zc_withdrawal_email_trigger on public.withdrawal_requests;
create trigger zc_withdrawal_email_trigger
  after update on public.withdrawal_requests
  for each row execute function public.queue_withdrawal_email();


-- ---------------------------------------------------------------------------
-- 8) App settings (text values, e.g. the website link used in emails).
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

drop policy if exists "Admins manage app settings" on public.app_settings;
create policy "Admins manage app settings"
  on public.app_settings for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

grant select on public.app_settings to anon, authenticated;
grant insert, update, delete on public.app_settings to authenticated;

create or replace function public.zc_email_site_url()
returns text
language sql
security definer
set search_path = ''
as $$
  select coalesce((select value from public.app_settings where key = 'site_url'), '');
$$;


