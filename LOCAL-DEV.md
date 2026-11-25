# Running ZentraChain on this laptop

## Sandbox accounts

The sandbox is a separate Supabase project (`mdpdcpxvohbcdlhirtdp`) with its own
data and accounts. Do not store test account emails, passwords, recovery
phrases, or API secrets in this repository. Create or reset local test users
through the sandbox Supabase Auth dashboard.

**Important:** older public Git history contained reusable sandbox test
credentials. Removing them from this file does not erase those old commits or
copies. Reset or disable the previously documented sandbox test accounts in
Supabase Auth before using them again. Do not use sandbox accounts in production.

## The simple daily workflow

Edit code on the laptop, test in the browser against the sandbox, then push to
GitHub — Vercel deploys and the live site talks to the production project.

```powershell
node serve.js
git add .
git commit -m "Fix ..."
git push
```

The root `js/env.js` is configured for the SANDBOX project. The deployed
`src/js/env.js` must remain configured for the production project. Do not
copy the production environment setting into the local file.

## Adding new names to the feed

**Real users appear automatically** when a real user makes a deposit that gets
credited or a withdrawal that gets paid.

To add more showcase names alongside the existing ones:

```powershell
.\scripts\add-showcase-names.ps1 -Names "Adaeze Obi", "Kwame Asante" -Region "Nigeria"
.\scripts\add-showcase-names.ps1
```

The script appends to `supabase/data/showcase-names.json`, regenerates the
seed, and pushes it to the sandbox. Commit the updated JSON and seed files so
the live site can receive the new showcase names.

To fetch new international names from the free randomuser.me API:

```powershell
.\scripts\add-generated-names.ps1 -Count 25
```

## Backend environment switch

- `js/env.js` (root, local testing) → `MODE: 'sandbox'`
- `src/js/env.js` (deployed copy) → `MODE: 'cloud'`

Both HTML files may contain a production fallback for deployment. Never put a
service-role key, wallet seed, or other private secret in either browser file.

## Sandbox project structure

- `supabase/sandbox-base.sql` — base objects (profiles, private.is_admin, triggers)
  that predate migration history
- `supabase/sandbox-tables.sql` — reconstructed request/ledger/report tables
  and application RPCs
- `supabase/migrations/` — versioned schema and security changes
- `supabase/data/showcase-names.json` — fictional names used by the public feed
- `supabase/sandbox-mnemonic.txt` and `supabase/.env.local` — local-only secrets;
  both are gitignored and must never be committed

The first-admin flow is `bootstrap-admin` and is one-time/secret-protected.
The old `ensure-admin-account` provisioning endpoint has been retired.

## Managing the sandbox (CLI)

```powershell
supabase projects list
supabase secrets list --project-ref mdpdcpxvohbcdlhirtdp
```

Keep the Supabase CLI access token in your local environment, never in a file
committed to GitHub.

## Laptop backups (production project)

```powershell
supabase login
supabase link --project-ref ltowdrhwebaitbrrupks
supabase db dump --file backup.sql
```

## Notes

- Migration files are schema history, not customer data backups.
- Real secrets (`WALLET_MNEMONIC`, service-role keys, admin passwords, provider
  API keys, cron secrets) belong in Supabase Edge Function secrets or protected
  Vercel environment variables — never in Git.
