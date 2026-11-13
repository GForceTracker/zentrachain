# ZentraChain

ZentraChain digital asset platform website.

## Project files

- `index.html` — complete website, including responsive layouts and client-side application logic.

## Deployment

This repository is connected to the Vercel project **zentrachain**. Pushes to `main` trigger a production deployment. Vercel serves the root `index.html` as the site entry point.

## Supabase configuration and security

The website uses the Supabase JavaScript client from the browser. Any Supabase URL and anon/public key used by a browser app are public configuration, not secrets. Keep the Supabase service-role key, database passwords, access tokens, and other private credentials out of this repository and out of browser code.

Protect database access with appropriate Row Level Security policies and server-side authorization. Never rely on frontend visibility or disabled buttons as security controls.

## Source recovery

The website HTML was recovered from a previously successful ZentraChain Vercel production deployment and restored as a single deployable entry point.
