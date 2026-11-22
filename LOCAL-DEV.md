# Running ZentraChain on this laptop

## Test accounts (sandbox clone)

The sandbox is a **clone Supabase project** (`zentrachain-sandbox`, ref
`mdpdcpxvohbcdlhirtdp`) with the full schema, its own data, and its own accounts.
The local site reads it via `js/env.js` (`MODE: 'sandbox'`).

| Account | Email | Password | Role |
| --- | --- | --- | --- |
| Admin | inemesitobot1@gmail.com | 12345678 | admin |
| Customer | inemesitobot2@gmail.com | 12345678 | user ($500 test balance) |

Sandbox URL: https://mdpdcpxvohbcdlhirtdp.supabase.co (manage it at supabase.com dashboard)

## The simple daily workflow

Edit code on the laptop, test in the browser against the sandbox, then push to
GitHub — Vercel deploys and the live site talks to the real project.

```powershell
node serve.js          # serves the project at http://localhost:8080
git add .
git commit -m "Fix ..."
git push
```

`localhost:8080` uses the SANDBOX database. Your live site (Vercel) uses the REAL
one. Same code, different data — so you can break anything safely.

## Adding new names to the feed

**Real users appear automatically** — when a real user makes a deposit that gets
credited or a withdrawal that gets paid, their name joins the feed on its own.
Nothing to do.

To add more showcase names alongside the existing ones:

```powershell
.\scripts\add-showcase-names.ps1 -Names "Adaeze Obi", "Kwame Asante" -Region "Nigeria"
# or run it with no arguments and type the names when asked
.\scripts\add-showcase-names.ps1
```

The script appends to `supabase/data/showcase-names.json` (skips duplicates),
regenerates the seed, pushes it to the sandbox, and puts the new names at the
top of the feed. Commit the updated `showcase-names.json` + `showcase-seed.sql`
so the live site gets them too.

To fetch brand-new international names from a free API instead of typing them:

```powershell
.\scripts\add-generated-names.ps1 -Count 25
```

This pulls fresh names from randomuser.me (free, no key), adds them alongside
everything already in the list, and pushes them to the feed the same way.
Run it any time you want the feed to keep growing.

## Backend environment switch

- `js/env.js` (root, local testing) → `MODE: 'sandbox'`
- `src/js/env.js` (deployed copy) → `MODE: 'cloud'` — **never change this one**

Both HTML files also hardcode the cloud fallback, so production stays safe even if
env.js fails to load.

## Sandbox project structure

- `supabase/sandbox-base.sql` — base objects (profiles, private.is_admin, triggers)
  that predate migration history
- `supabase/sandbox-tables.sql` — reconstructed request/ledger/report tables + the
  RPCs the app calls (request_gforce_withdrawal, admin_review_gforce_deposit,
  admin_pay_gforce_withdrawal)
- `supabase/migrations/` — applied in order; recorded in
  `supabase_migrations.schema_migrations` so CLI tools see them as applied
- `supabase/data/showcase-names.json` — 254 fictional international names used by
  the public feed seed (regenerate seed with `node supabase/data/gen-showcase-seed.js`)
- Edge functions deployed: site-analytics, generate-deposit-address,
  bootstrap-admin, ensure-admin-account, market-data, verify-payout
- `verify-payout` checks withdrawal hashes on-chain via free public APIs
  (mempool.space for BTC, Blockchair for ETH/DOGE, BSC public RPC for BEP20,
  Tronscan for TRON, Solana public RPC for SOL) — no keys needed
- Secrets on the sandbox: WALLET_MNEMONIC (fresh test seed, see
  `supabase/sandbox-mnemonic.txt`, gitignored)
- Sandbox secrets live in `supabase/.env.local` (gitignored)

## Managing the sandbox (CLI)

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."   # or rely on the saved user env var
supabase projects list
supabase secrets list --project-ref mdpdcpxvohbcdlhirtdp
```

SQL can also be run through the Supabase Management API query endpoint.

## Laptop backups (real project)

```powershell
supabase login
supabase link --project-ref ltowdrhwebaitbrrupks
supabase db dump --file backup.sql
```

## Notes

- Migrations in `supabase/migrations/` are schema history, not customer data backups.
- Real secrets (`WALLET_MNEMONIC`, service-role keys, admin passwords, provider API keys)
  live in Supabase Edge Function secrets / Vercel env vars — never in git.
