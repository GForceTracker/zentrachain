-- Anonymous visitors should not receive blanket table privileges.
-- RLS was already limiting rows; this additionally removes unnecessary access
-- to private account, financial, support, and operational tables.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;

-- Re-expose only the tables used by public-facing unauthenticated pages.
-- Row-level policies still restrict which rows anon can see.
GRANT SELECT ON TABLE
  public.activity_showcase,
  public.app_settings,
  public.crypto_asset_networks,
  public.faq_items,
  public.gforce_investment_plans,
  public.site_settings,
  public.trade_reports
TO anon;

-- Do not automatically grant new public-schema tables to anonymous users.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon;
