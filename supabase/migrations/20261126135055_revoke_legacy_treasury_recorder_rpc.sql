-- The legacy 12-argument recorder does not carry explicit fee mode or requested amount.
-- Only the reservation-bound 14-argument Treasury recorder is callable by authenticated admins.
REVOKE ALL ON FUNCTION public.admin_treasury_record_onchain_withdrawal(
  uuid,text,text,numeric,numeric,numeric,numeric,text,text,text,text,uuid
) FROM PUBLIC, anon, authenticated;
