-- In-app welcome and referral notifications. Applied to the production project as
-- migration 20261125103114_zc_notifications_and_referral_alerts.

CREATE TABLE IF NOT EXISTS public.user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notification_type text NOT NULL CHECK (notification_type IN ('welcome', 'referral_joined', 'referred_by')),
  title text NOT NULL,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  reference_id uuid REFERENCES public.referrals(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS user_notifications_user_created_idx
  ON public.user_notifications (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS user_notifications_welcome_once_idx
  ON public.user_notifications (user_id)
  WHERE notification_type = 'welcome';

CREATE UNIQUE INDEX IF NOT EXISTS user_notifications_referral_once_idx
  ON public.user_notifications (user_id, notification_type, reference_id)
  WHERE reference_id IS NOT NULL;

ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_notifications FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON TABLE public.user_notifications TO authenticated;
GRANT UPDATE (read_at) ON TABLE public.user_notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_notifications TO service_role;

DROP POLICY IF EXISTS "Users read their own notifications" ON public.user_notifications;
CREATE POLICY "Users read their own notifications"
  ON public.user_notifications FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users mark their own notifications as read" ON public.user_notifications;
CREATE POLICY "Users mark their own notifications as read"
  ON public.user_notifications FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE OR REPLACE FUNCTION private.zc_notify_new_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.user_notifications (user_id, notification_type, title, message, metadata)
  VALUES (NEW.id, 'welcome', 'Welcome to ZentraChain',
          'Your account is ready. Welcome to ZentraChain!',
          jsonb_build_object('account_created_at', NEW.created_at))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.zc_notify_new_profile() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zc_notify_new_profile ON public.profiles;
CREATE TRIGGER zc_notify_new_profile AFTER INSERT ON public.profiles
FOR EACH ROW EXECUTE FUNCTION private.zc_notify_new_profile();

CREATE OR REPLACE FUNCTION private.zc_notify_referral_linked()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_referrer_name text;
  v_referred_name text;
BEGIN
  SELECT COALESCE(NULLIF(btrim(p.full_name), ''),
                  NULLIF(split_part(COALESCE(p.email, ''), '@', 1), ''),
                  'a ZentraChain member')
    INTO v_referrer_name
    FROM public.profiles AS p WHERE p.id = NEW.referrer_id;

  SELECT COALESCE(NULLIF(btrim(p.full_name), ''),
                  NULLIF(split_part(COALESCE(p.email, ''), '@', 1), ''),
                  'A new member')
    INTO v_referred_name
    FROM public.profiles AS p WHERE p.id = NEW.referred_id;

  v_referrer_name := COALESCE(v_referrer_name, 'a ZentraChain member');
  v_referred_name := COALESCE(v_referred_name, 'A new member');

  INSERT INTO public.user_notifications
    (user_id, notification_type, title, message, metadata, reference_id, created_at)
  VALUES
    (NEW.referred_id, 'referred_by', 'You were referred',
     'You were referred by ' || v_referrer_name || '.',
     jsonb_build_object('referral_id', NEW.id, 'referrer_id', NEW.referrer_id,
                        'referrer_name', v_referrer_name), NEW.id, NEW.created_at)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.user_notifications
    (user_id, notification_type, title, message, metadata, reference_id, created_at)
  VALUES
    (NEW.referrer_id, 'referral_joined', 'New referral joined',
     v_referred_name || ' joined using your referral link.',
     jsonb_build_object('referral_id', NEW.id, 'referred_id', NEW.referred_id,
                        'referred_name', v_referred_name), NEW.id, NEW.created_at)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.zc_notify_referral_linked() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zc_notify_referral_linked ON public.referrals;
CREATE TRIGGER zc_notify_referral_linked AFTER INSERT ON public.referrals
FOR EACH ROW EXECUTE FUNCTION private.zc_notify_referral_linked();

INSERT INTO public.user_notifications (user_id, notification_type, title, message, metadata, created_at)
SELECT p.id, 'welcome', 'Welcome to ZentraChain',
       'Your account is ready. Welcome to ZentraChain!',
       jsonb_build_object('account_created_at', p.created_at), p.created_at
FROM public.profiles AS p
WHERE p.created_at >= now() - interval '24 hours'
ON CONFLICT DO NOTHING;

INSERT INTO public.user_notifications
  (user_id, notification_type, title, message, metadata, reference_id, created_at)
SELECT r.referred_id, 'referred_by', 'You were referred',
       'You were referred by ' || COALESCE(NULLIF(btrim(inviter.full_name), ''),
         NULLIF(split_part(COALESCE(inviter.email, ''), '@', 1), ''),
         'a ZentraChain member') || '.',
       jsonb_build_object('referral_id', r.id, 'referrer_id', r.referrer_id,
                          'referrer_name', COALESCE(NULLIF(btrim(inviter.full_name), ''),
                          'a ZentraChain member')), r.id, r.created_at
FROM public.referrals AS r
LEFT JOIN public.profiles AS inviter ON inviter.id = r.referrer_id
ON CONFLICT DO NOTHING;

INSERT INTO public.user_notifications
  (user_id, notification_type, title, message, metadata, reference_id, created_at)
SELECT r.referrer_id, 'referral_joined', 'New referral joined',
       COALESCE(NULLIF(btrim(invited.full_name), ''),
                NULLIF(split_part(COALESCE(invited.email, ''), '@', 1), ''),
                'A new member') || ' joined using your referral link.',
       jsonb_build_object('referral_id', r.id, 'referred_id', r.referred_id,
                          'referred_name', COALESCE(NULLIF(btrim(invited.full_name), ''),
                          'A new member')), r.id, r.created_at
FROM public.referrals AS r
LEFT JOIN public.profiles AS invited ON invited.id = r.referred_id
ON CONFLICT DO NOTHING;

DO $publication$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'user_notifications'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_notifications;
  END IF;
END;
$publication$;
