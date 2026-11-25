-- Public visitors may read active plans without querying the private profiles table.
-- Keep the admin visibility check only in the authenticated policy.
DROP POLICY IF EXISTS "Public can view active G-Force plans"
  ON public.gforce_investment_plans;

DROP POLICY IF EXISTS "Authenticated can view active G-Force plans"
  ON public.gforce_investment_plans;

CREATE POLICY "Public can view active G-Force plans"
  ON public.gforce_investment_plans
  FOR SELECT
  TO anon
  USING (is_active = true);

CREATE POLICY "Authenticated can view active G-Force plans"
  ON public.gforce_investment_plans
  FOR SELECT
  TO authenticated
  USING (
    is_active = true
    OR EXISTS (
      SELECT 1
      FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = 'admin'
    )
  );
