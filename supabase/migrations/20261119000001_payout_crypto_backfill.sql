-- Backfill crypto quote fields at payout time for v1 withdrawal requests.
-- request_gforce_withdrawal (v1) has no quote parameters, so paid v1 rows would
-- otherwise be invisible in the public chain-activity feed (which requires
-- crypto_amount). USDT settles 1:1, so backfill amount/1.0 when unset.
create or replace function public.admin_pay_gforce_withdrawal(
  p_request_id uuid,
  p_tx_hash text,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.withdrawal_requests%rowtype;
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if not (select private.is_admin()) then raise exception 'Administrator access required'; end if;
  if p_tx_hash is null or btrim(p_tx_hash) = '' then raise exception 'A transaction hash is required'; end if;
  select * into v_req from public.withdrawal_requests where id = p_request_id for update;
  if not found then raise exception 'Withdrawal request not found'; end if;
  if v_req.status not in ('pending','under_review','approved') then raise exception 'Withdrawal request was already completed'; end if;
  update public.withdrawal_requests
    set status = 'paid', tx_hash = btrim(p_tx_hash), admin_note = p_note,
        crypto_amount = coalesce(crypto_amount, case when upper(asset) = 'USDT' then amount else null end),
        usd_price = coalesce(usd_price, case when upper(asset) = 'USDT' then 1 else null end),
        paid_by = v_uid, paid_at = now(), updated_at = now()
    where id = p_request_id
    returning id into v_id;
  insert into public.ledger_entries(user_id, amount, entry_type, description, reference_type, reference_id)
  values (v_req.user_id, -v_req.amount, 'withdrawal',
          'Withdrawal paid: ' || coalesce(nullif(btrim(p_note), ''), 'payout recorded'),
          'withdrawal_request', p_request_id);
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (v_uid, 'withdrawal_paid', 'withdrawal_request', p_request_id::text,
          jsonb_build_object('amount', v_req.amount, 'tx_hash', p_tx_hash, 'user_id', v_req.user_id));
  return v_id;
end;
$$;

revoke all on function public.admin_pay_gforce_withdrawal(uuid,text,text) from public;
grant execute on function public.admin_pay_gforce_withdrawal(uuid,text,text) to authenticated;
