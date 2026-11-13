# ZentraChain

ZentraChain digital asset platform.

## Website source

- `index.html` — full recovered HTML snapshot of the current website.
- `src/api/site.js` — original Vercel Node.js serverless handler.
- `src/chunks/part_00.js` through `part_33.js` — compressed website payload consumed by that handler.
- `src/vercel.json` — original Vercel rewrite configuration.

## Backend architecture

The backend is not Python in the inspected live project. It uses **Supabase Edge Functions written in TypeScript (Deno)** plus a **Supabase PostgreSQL** database. The Vercel website handler is Node.js.

Recovered Edge Functions:
- `site-analytics`
- `generate-deposit-address`
- `bootstrap-admin`
- `ensure-admin-account`
- `market-data`

The deposit-address function derives blockchain deposit addresses and depends on the private `WALLET_MNEMONIC` Supabase secret. Other privileged functions also use server-side Supabase secrets.

## Secrets and deployment

Never commit service-role keys, wallet recovery phrases, admin setup secrets, admin passwords, or provider API keys. Keep these in Supabase Edge Function secrets or Vercel environment variables.

## Database migration note

The connected Supabase project is `g-force-analytics`. The live database currently has 11 recorded migrations. Their SQL source files have not yet been exported into this repository, so this repository is not yet a fully reproducible database backup.
