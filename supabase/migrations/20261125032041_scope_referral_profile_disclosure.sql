-- Referrers only need the invitee's display name, email, and join date.
-- Remove the broad row-level SELECT path that exposed every profiles column.
DROP POLICY IF EXISTS "Referrers read invited profiles" ON public.profiles;

CREATE OR REPLACE FUNCTION public.get_my_referral_profiles()
RETURNS TABLE (
  id uuid,
  email text,
  full_name text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p.id, p.email, p.full_name, p.created_at
  FROM public.profiles AS p
  INNER JOIN public.referrals AS r
    ON r.referred_id = p.id
  WHERE r.referrer_id = (SELECT auth.uid());
$function$;

REVOKE ALL ON FUNCTION public.get_my_referral_profiles()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_referral_profiles()
  TO authenticated;
