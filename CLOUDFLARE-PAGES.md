# Cloudflare Worker preview for ZentraChain

This branch prepares an isolated Cloudflare Workers deployment for testing. It does not change the Vercel production project, the custom domain, or Supabase.

## Worker build settings

Use the existing Cloudflare Worker named `zentrachain` and connect it to:

- GitHub repository: `GForceTracker/zentrachain`
- Git branch: `cloudflare/pages-preview`
- Root directory: `/`
- Build command: `node scripts/build-cloudflare-pages.js`
- Deploy command: `npx wrangler deploy`
- Environment variable: `NODE_VERSION=22`

The `wrangler.jsonc` file configures the Worker to serve static files from `dist/`. The Cloudflare `workers.dev` address remains separate from `zentrachain.vercel.app`. Do not attach the production custom domain.

## What the build does

The build script:
- Uses `src/site.html` as the website page source.
- Applies the visitor plan behaviour patch used by the Vercel handler.
- Copies `src/js/env.js`, configured for the existing production Supabase project, to `dist/js/env.js`.
- Copies the website's `assets/` directory.
- Produces a static `dist/` directory for the Cloudflare Worker.

It deliberately does not copy the local sandbox environment, change Supabase, or modify Vercel configuration.

## Supabase Auth redirect allow-list

After the Worker deploys, add its exact `workers.dev` hostname as an additional allowed redirect URL in Supabase Authentication URL Configuration.

Keep the existing Site URL and existing Vercel redirect entries unchanged. Do not replace the production Site URL with the Cloudflare URL.

## Verification

After the first successful deployment, test the landing page, sign-in, sign-up, plan selection, dashboard loading, and Supabase-backed flows. This Cloudflare Worker uses the live production Supabase backend, so any real account or financial operation is production activity. Do not use real deposits, withdrawals, or financial transactions as tests.
