# ZentraChain

ZentraChain digital asset platform.

## Run on this computer

```powershell
node serve.js
```

Then open http://localhost:8080. The local browser configuration in `js/env.js`
must use the separate sandbox Supabase project. The deployed copy in
`src/js/env.js` must use the production project. See `LOCAL-DEV.md` for the
workflow and security notes.

## Website source

- `index.html` — editable HTML source for the visitor and account portal.
- `src/site.html` — runtime HTML copy served by the Vercel website handler.
- `src/api/site.js` — Vercel Node.js serverless handler that serves `src/site.html`.
- `src/chunks/part_00.js` through `part_33.js` — retained compressed recovery artifacts; the current handler no longer serves this stale snapshot.
- `src/vercel.json` — Vercel rewrite configuration.

The visitor page includes the public plan carousel and an anonymized on-chain
activity feed. Public feed data is restricted to the fields and rows selected by
its database policies and reader function.

## Backend architecture

The backend uses **Supabase Edge Functions written in TypeScript (Deno)** and
**Supabase PostgreSQL**. Vercel serves the website.

Important Edge Functions include:
- `generate-deposit-address` — generates member deposit addresses using the
  server-only `WALLET_MNEMONIC` secret.
- `reveal-deposit-key` — restricted to administrators; returns a derived
  private key and must only be used from the protected admin workflow.
- `chain-send` — administrator-only on-chain sending.
- `monitor-deposits` — administrator-only for manual scans, or authorized by a
  long random `ZC_CRON_SECRET` for scheduled scans.
- `bootstrap-admin` — one-time, secret-protected first-administrator setup.
- `ensure-admin-account` — retired; returns HTTP 410 and no longer provisions
  or resets administrator credentials.

## Database migrations

The versioned SQL in `supabase/migrations/` records the database structure and
security changes. These statements are not a backup of live customer data.
Apply migrations in filename/version order only when provisioning a new
database; do not replay production migrations onto an already migrated project.

## Secrets and deployment

The Supabase project URL and publishable key in browser code are public client
configuration, not private credentials. Their safety depends on row-level
security, table grants, and authorization checks.

Never commit service-role or secret API keys, wallet recovery phrases, private
keys, admin setup secrets, passwords, provider credentials, or real
`.env` files. Keep them in Supabase Edge Function secrets or protected Vercel
environment variables. Use the root `.gitignore` and `supabase/.gitignore`;
do not remove those protections.

## Recovery limitations

A complete disaster-recovery plan should include a secure database data backup
and an inventory of required environment-variable names (never their secret
values).
