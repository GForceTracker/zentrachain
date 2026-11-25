-- Users must purchase investments through the validated balance-purchase RPC.
-- Direct inserts would allow arbitrary investment rows without a ledger debit.
DROP POLICY IF EXISTS "Users insert own investments" ON public.user_investments;
REVOKE INSERT ON TABLE public.user_investments FROM anon, authenticated;

-- Referral links must be created by link_referral(), which validates the referral
-- code and prevents users from assigning arbitrary referrers by UUID.
DROP POLICY IF EXISTS "Users record own referral" ON public.referrals;
REVOKE INSERT ON TABLE public.referrals FROM anon, authenticated;
