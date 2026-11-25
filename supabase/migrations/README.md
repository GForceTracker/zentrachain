# Supabase migrations

The SQL files in this directory record versioned schema, RPC, policy, and
permission changes applied to the ZentraChain Supabase project. They are not a
backup of live customer data or secrets.

Apply the files in filename/version order only when provisioning a new database.
The live production project already has these migration versions recorded as
applied; do not replay them against an existing production database.

Security hardening added on 2026-11-25 includes:
- Removing direct member INSERT access to `user_investments` and `referrals`.
- Restricting the `anon` role to SELECT-only access on explicitly public tables.
- Removing default anonymous privileges from future public-schema tables.
- Revoking the obsolete plan-purchase RPC from client roles.
- Adding restrictive RLS policies that deny anonymous storage uploads,
  updates, and deletes while preserving public reads for public buckets.
- Restricting referral profile lookups to the minimum fields shown in the
  referral list; a referrer can no longer query the invitee's entire profile.

Secrets and environment variables are intentionally excluded. Configure those
separately in Supabase Edge Function secrets or protected Vercel environment
variables. Keep this directory synchronized with changes applied to the live
database.
