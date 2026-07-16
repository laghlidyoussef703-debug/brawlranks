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

Phase 1 (infrastructure proof-of-concept), Phase 2 (production database
schema + canonical Brawler catalog vertical slice), Phase 3 (official API
ingestion: rankings/player/club sync, sampling and crawl scheduling, the
battle-log pipeline with deterministic dedup, rate-limit budgeting,
retry/backoff), and Phase 4 (region/trophy-bracket sampling diversity,
fair deterministic crawl scheduling, centralized cadence, discovery
promotion fairness, club-ingestion bug fix, incident deduplication, data
retention, coverage/readiness reporting) are locally complete — see
[`PHASE2.md`](./PHASE2.md), [`PHASE3.md`](./PHASE3.md), and
[`PHASE4.md`](./PHASE4.md) for the full design writeups and known
limitations (no Hostinger MCP, no local DB credentials, and no verified
DigitalOcean-proxy support for any of these phases' endpoints this
session, so nothing has been applied to production yet — the last known
production figure, 575 battles, is explicitly documented in `PHASE4.md`
as not yet sufficient for Phase 5). No ranking engine, aggregation, or
public content pages have been implemented. See
`BRAWLRANKS_WEBSITE_SPEC.md` Section 43 (Development Order) for the full
build sequence.
