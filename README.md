# BrawlRanks — Hostinger Infrastructure Scaffold

This is a **minimal, production-ready Next.js 16 App Router scaffold**, created to prove out the Hostinger deployment pipeline before the full BrawlRanks platform is built. It intentionally contains no product features yet.

The full product, backend, data, and SEO specification lives in [`BRAWLRANKS_WEBSITE_SPEC.md`](./BRAWLRANKS_WEBSITE_SPEC.md). Keyword research inputs live in [`keyword/`](./keyword/).

## Stack

- Next.js 16 (App Router)
- TypeScript
- Tailwind CSS
- Node.js runtime (no Edge runtime dependencies)

## What's included

- `app/page.tsx` — a temporary infrastructure test homepage (not the production BrawlRanks homepage)
- `app/api/health/route.ts` — a health-check endpoint returning `{ ok, service, time }`
- Tailwind CSS wired up via PostCSS
- ESLint (flat config) via `eslint-config-next`

## Local development

```bash
npm install
npm run dev
```

Visit `http://localhost:3000`. Check the health endpoint at `http://localhost:3000/api/health`.

## Build

```bash
npm run build
npm start
```

## Environment variables

Copy `.env.example` to `.env.local` and fill in real values locally. **Never commit `.env.local` or any file containing a real secret.** The Brawl Stars API key is never used by this application directly — per the spec (Section 24), it lives only on the DigitalOcean fixed-IP proxy service, never in this Hostinger-hosted app.

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `BRAWL_DB_SECRET_V1` | Hostinger MySQL connection (server-only) |
| `DIGITALOCEAN_PROXY_URL` | Base URL of the DigitalOcean fixed-IP proxy service |
| `PROXY_SHARED_SECRET` | Shared secret for signing requests to the DigitalOcean proxy |
| `INTERNAL_CRON_SECRET` | Authenticates Hostinger cron calls into protected internal endpoints |

## Status

This is an infrastructure proof-of-concept only. No database connection, authentication, ranking engine, or public content pages have been implemented yet. See `BRAWLRANKS_WEBSITE_SPEC.md` Section 43 (Development Order) for the full build sequence.
