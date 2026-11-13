# ZentraChain

ZentraChain digital asset platform.

## Website source

- `index.html` — recovered HTML snapshot of the current website.
- `src/api/site.js` — recovered Vercel Node.js serverless handler.
- `src/chunks/part_00.js` through `part_33.js` — compressed website payload consumed by that handler.
- `src/vercel.json` — recovered Vercel rewrite configuration.

## Backend architecture

The inspected live backend is not Python. It uses **Supabase Edge Functions written in TypeScript (Deno)** plus a **Supabase PostgreSQL** database. The Vercel website handler is Node.js.

Recovered Edge Functions:
- `site-analytics`
- `generate-deposit-address`
- `bootstrap-admin`
- `ensure-admin-account`
- `market-data`

The deposit-address function derives blockchain deposit addresses and depends on the private `WALLET_MNEMONIC` Supabase secret. Privileged functions also use server-side Supabase secrets.

## Database migrations

All 11 migration SQL statements recorded in the live Supabase migration history were exported into `supabase/migrations/` on 2026-11-13. The filenames preserve the original migration version and name. See `supabase/migrations/README.md` for restore guidance.

These files are a record of the migration statements, not a backup of live customer data.

## Secrets and deployment

Never commit service-role keys, wallet recovery phrases, admin setup secrets, admin passwords, or provider API keys. Keep these in Supabase Edge Function secrets or Vercel environment variables.

## Recovery limitations

The website payload was recovered from the successful Vercel deployment, and the Edge Function source was recovered from the active Supabase functions. The migration SQL was recovered from the live Supabase migration history. A complete disaster-recovery plan should additionally include a secure database data backup and a separate inventory of required environment-variable names (never their secret values).
