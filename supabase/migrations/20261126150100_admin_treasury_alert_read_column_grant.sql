-- Authenticated admins may only update the read marker, not alert ownership or links.
revoke update on table public.admin_deposit_alerts from authenticated;
grant update (treasury_seen_at) on table public.admin_deposit_alerts to authenticated;
