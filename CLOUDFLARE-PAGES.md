# Cloudflare Pages preview for ZentraChain

This branch prepares a separate Cloudflare Pages deployment. It does not change the Vercel production project, the custom domain, or Supabase.

## Cloudflare Pages settings

Create a Pages project named `zentrachain-preview` and connect the GitHub repository `GForceTracker/zentrachain`.

Use these settings:

- Production branch: `cloudflare/pages-preview`
- Root directory: `/` (repository root)
- Framework preset: `None`
- Build command: `node scripts/build-cloudflare-pages.js`
- Build output directory: `dist`
- Environment variable: `NODE_VERSION=22`

Do not add a custom domain. The Cloudflare `pages.dev` URL will remain separate from `zentrachain.vercel.app`.

This branch is the production branch only for the isolated Cloudflare Pages project. It is not the ZentraChain live domain or Vercel production branch.

## What the build does

The build script:
- Uses `src/site.html` as the website page source.
- Applies the same visitor plan behaviour patch currently injected by the Vercel handler.
- Copies `src/js/env.js`, which is configured for the existing production Supabase project.
- Copies the website's `assets/` directory.
- Produces a static `dist/` directory for Cloudflare Pages.

It deliberately does not copy local `js/env.js`, change Supabase, or modify Vercel configuration.

## Supabase Auth redirect allow-list

After Cloudflare creates the `pages.dev` hostname, add this as an additional allowed redirect URL in Supabase Authentication URL Configuration:

`https://zentrachain-preview.pages.dev/**`

Keep the existing Site URL and existing Vercel redirect entries unchanged. Do not replace the production Site URL with the Cloudflare URL.

## Verification

After the first successful deployment, test the landing page, sign-in, sign-up, plan selection, dashboard loading, and the Supabase-backed flows. The Cloudflare URL uses the live production Supabase backend, so any real account or financial operation is production activity.