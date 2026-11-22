-- Repair audit entity UUID writes and tighten public SECURITY DEFINER RPC grants.
-- This migration intentionally preserves each live function body and changes only
-- the known text-to-UUID audit assignments. It fails closed if a target body differs.

do $migration$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.admin_adjust_user_ledger(uuid,numeric,text,text)'::regprocedure) into v_def;
  v_new := replace(v_def, 'v_id::text', 'v_id');
  if v_new = v_def then raise exception 'Expected audit UUID cast not found: admin_adjust_user_ledger'; end if;
  execute v_new;

  select pg_get_functiondef('public.admin_credit_user_funds(uuid,numeric,text)'::regprocedure) into v_def;
  v_new := replace(v_def, 'v_id::text', 'v_id');
  if v_new = v_def then raise exception 'Expected audit UUID cast not found: admin_credit_user_funds'; end if;
  execute v_new;

  select pg_get_functiondef('public.admin_review_gforce_deposit(uuid,boolean,text)'::regprocedure) into v_def;
  v_new := replace(v_def, 'p_request_id::text', 'p_request_id');
  if v_new = v_def then raise exception 'Expected audit UUID cast not found: admin_review_gforce_deposit'; end if;
  execute v_new;

  select pg_get_functiondef('public.admin_update_profile(uuid,text,text,boolean,boolean,text)'::regprocedure) into v_def;
  v_new := replace(v_def, 'p_user_id::text', 'p_user_id');
  if v_new = v_def then raise exception 'Expected audit UUID cast not found: admin_update_profile'; end if;
  execute v_new;

  select pg_get_functiondef('public.admin_pay_gforce_withdrawal(uuid,text,text)'::regprocedure) into v_def;
  v_new := replace(v_def, 'p_request_id::text', 'p_request_id');
  if v_new = v_def then raise exception 'Expected audit UUID cast not found: admin_pay_gforce_withdrawal'; end if;
  execute v_new;

  select pg_get_functiondef('public.admin_treasury_withdraw_from_user(uuid,text,text,numeric,numeric,text,text)'::regprocedure) into v_def;
  v_new := replace(v_def, 'v_id::text', 'v_id');
  if v_new = v_def then raise exception 'Expected audit UUID cast not found: admin_treasury_withdraw_from_user'; end if;
  execute v_new;

  select pg_get_functiondef('public.admin_record_treasury_withdrawal(text,text,numeric,numeric,text,text)'::regprocedure) into v_def;
  v_new := replace(v_def, 'v_id::text', 'v_id');
  if v_new = v_def then raise exception 'Expected audit UUID cast not found: admin_record_treasury_withdrawal'; end if;
  execute v_new;

  -- Preserve the email bonus code as the RPC return value; audit by row UUID.
  select pg_get_functiondef('public.admin_create_email_bonus(uuid,numeric,text)'::regprocedure) into v_def;
  v_new := replace(v_def, '  v_code text;', '  v_code text;' || chr(10) || '  v_bonus_id uuid;');
  if v_new = v_def then raise exception 'Expected declaration not found: admin_create_email_bonus'; end if;
  v_def := v_new;
  v_new := replace(v_def, 'returning code into v_code;', 'returning id, code into v_bonus_id, v_code;');
  if v_new = v_def then raise exception 'Expected insert return clause not found: admin_create_email_bonus'; end if;
  v_def := v_new;
  v_new := replace(v_def, '''email_bonus_created'', ''email_bonuses'', v_code,', '''email_bonus_created'', ''email_bonuses'', v_bonus_id,');
  if v_new = v_def then raise exception 'Expected audit entity assignment not found: admin_create_email_bonus'; end if;
  execute v_new;

  select pg_get_functiondef('public.claim_email_bonus(text)'::regprocedure) into v_def;
  v_new := replace(v_def, 'v_bonus.id::text', 'v_bonus.id');
  if v_new = v_def then raise exception 'Expected audit UUID cast not found: claim_email_bonus'; end if;
  execute v_new;

  select pg_get_functiondef('public.pay_referral_reward()'::regprocedure) into v_def;
  v_new := replace(v_def, 'v_ref_id::text', 'v_ref_id');
  if v_new = v_def then raise exception 'Expected audit UUID cast not found: pay_referral_reward'; end if;
  execute v_new;
end;
$migration$;

-- Administrative RPCs remain available to signed-in clients, with the existing
-- private.is_admin() authorization check still enforced inside every function.
revoke all on function public.admin_adjust_user_ledger(uuid,numeric,text,text) from public, anon;
grant execute on function public.admin_adjust_user_ledger(uuid,numeric,text,text) to authenticated;
revoke all on function public.admin_create_email_bonus(uuid,numeric,text) from public, anon;
grant execute on function public.admin_create_email_bonus(uuid,numeric,text) to authenticated;
revoke all on function public.admin_credit_user_funds(uuid,numeric,text) from public, anon;
grant execute on function public.admin_credit_user_funds(uuid,numeric,text) to authenticated;
revoke all on function public.admin_pay_gforce_withdrawal(uuid,text,text) from public, anon;
grant execute on function public.admin_pay_gforce_withdrawal(uuid,text,text) to authenticated;
revoke all on function public.admin_record_treasury_withdrawal(text,text,numeric,numeric,text,text) from public, anon;
grant execute on function public.admin_record_treasury_withdrawal(text,text,numeric,numeric,text,text) to authenticated;
revoke all on function public.admin_review_gforce_deposit(uuid,boolean,text) from public, anon;
grant execute on function public.admin_review_gforce_deposit(uuid,boolean,text) to authenticated;
revoke all on function public.admin_treasury_withdraw_from_user(uuid,text,text,numeric,numeric,text,text) from public, anon;
grant execute on function public.admin_treasury_withdraw_from_user(uuid,text,text,numeric,numeric,text,text) to authenticated;
revoke all on function public.admin_update_profile(uuid,text,text,boolean,boolean,text) from public, anon;
grant execute on function public.admin_update_profile(uuid,text,text,boolean,boolean,text) to authenticated;

-- User-facing RPCs require a valid authenticated session.
revoke all on function public.claim_email_bonus(text) from public, anon;
grant execute on function public.claim_email_bonus(text) to authenticated;
revoke all on function public.link_referral(text) from public, anon;
grant execute on function public.link_referral(text) to authenticated;
revoke all on function public.purchase_gforce_plan(uuid,numeric) from public, anon;
grant execute on function public.purchase_gforce_plan(uuid,numeric) to authenticated;
revoke all on function public.request_gforce_withdrawal(numeric,text,text) from public, anon;
grant execute on function public.request_gforce_withdrawal(numeric,text,text) to authenticated;
revoke all on function public.request_gforce_withdrawal_v2(numeric,text,text,text,numeric,numeric) from public, anon;
grant execute on function public.request_gforce_withdrawal_v2(numeric,text,text,text,numeric,numeric) to authenticated;
revoke all on function public.zc_settle_gforce_investments() from public, anon;
grant execute on function public.zc_settle_gforce_investments() to authenticated;

-- Trigger/internal helpers are not client-callable RPC endpoints.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.pay_referral_reward() from public, anon, authenticated;
revoke all on function public.queue_transaction_email() from public, anon, authenticated;
revoke all on function public.queue_withdrawal_email() from public, anon, authenticated;
revoke all on function public.zc_email_site_url() from public, anon, authenticated;
