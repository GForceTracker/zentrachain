-- storage.objects is owned/granted by the Supabase Storage service role.
-- Keep public SELECT for public buckets, but explicitly prevent anonymous writes
-- even if a permissive policy is introduced later by mistake.
DROP POLICY IF EXISTS "Deny anonymous storage uploads" ON storage.objects;
CREATE POLICY "Deny anonymous storage uploads"
  ON storage.objects AS RESTRICTIVE
  FOR INSERT TO anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "Deny anonymous storage updates" ON storage.objects;
CREATE POLICY "Deny anonymous storage updates"
  ON storage.objects AS RESTRICTIVE
  FOR UPDATE TO anon
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "Deny anonymous storage deletes" ON storage.objects;
CREATE POLICY "Deny anonymous storage deletes"
  ON storage.objects AS RESTRICTIVE
  FOR DELETE TO anon
  USING (false);
