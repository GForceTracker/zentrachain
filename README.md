# ZentraChain

ZentraChain digital asset platform.

## Run on this computer

```powershell
node serve.js
```

Then open http://localhost:8080. The page talks to the hosted Supabase backend
(same as production). See `LOCAL-DEV.md` for details, the backend switch, and
how to push fixes back to GitHub.

## Website source

- `index.html` — editable HTML source for the visitor and account portal.
- `src/site.html` — runtime HTML copy served by the Vercel website handler. Keep this file in sync with `index.html`.
- `src/api/site.js` — Vercel Node.js serverless handler that serves `src/site.html`.
- `src/chunks/part_00.js` through `part_33.js` — retained compressed recovery artifacts; the current handler no longer serves this stale snapshot.
- `src/vercel.json` — Vercel rewrite configuration.

The visitor page includes the public plan carousel and an anonymized on-chain activity feed. The feed reads at most 300 confirmed/credited deposits and paid withdrawals with a recorded transaction hash. It does not publish customer names or full wallet addresses.

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

The original migration SQL was exported into `supabase/migrations/`. The public visitor activity feed is defined in `20261118081731_public_chain_activity_feed.sql`. It uses a private, security-definer reader and a public security-invoker RPC wrapper; only masked addresses and transaction activity fields are returned.

These files are migration statements, not a backup of live customer data.

## Secrets and deployment

Never commit service-role keys, wallet recovery phrases, admin setup secrets, admin passwords, or provider API keys. Keep these in Supabase Edge Function secrets or Vercel environment variables.

## Recovery limitations

The website payload and Edge Function source were recovered from successful Vercel deployments and active Supabase functions. The migration SQL was recovered from Supabase migration history. A complete disaster-recovery plan should additionally include a secure database data backup and a separate inventory of required environment-variable names (never their secret values).
