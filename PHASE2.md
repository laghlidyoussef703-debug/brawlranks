# Phase 2 — Production Database & Data Foundation

This document covers what Phase 2 added on top of the Phase 1 infrastructure
scaffold: the versioned migration system, the Phase 2 production schema, and
the canonical Brawler catalog vertical slice (official API → proxy →
tracked fetch run → immutable raw snapshot → validation → canonical
normalization → normalized snapshot → change detection → completion).

This document does not restate the specification. `BRAWLRANKS_WEBSITE_SPEC.md`
is the single source of truth — in particular Sections 7, 7.5, 7.6, 7.21,
7.24, 8, 25, 26, 29, 30, 38, 43, 44, 51, 52. Where this document and the spec
ever disagree, the spec wins.

## Stack decision for this phase

Raw `mysql2/promise` with parameterized SQL — no Prisma, Drizzle, Supabase,
MongoDB, or PostgreSQL. This was an explicit instruction for Phase 2 and
takes precedence over the spec's original Section 24.7 ORM suggestion.

## Migration system

`scripts/migrate.mjs` — a small, dependency-free runner:

```bash
npm run migrate:status   # list applied/pending migrations, no changes
npm run migrate:up       # apply all pending migrations, in order
```

Guarantees:
- Migrations are discovered from `migrations/*.sql`, applied in
  filename-sorted (`NNNN_name.sql`) order.
- A `schema_migrations` bookkeeping table is bootstrap-created
  (`CREATE TABLE IF NOT EXISTS`) and records `version`, `name`, a SHA-256
  `checksum` of the file's exact contents, `applied_at`, and `execution_ms`.
- Every already-applied migration's on-disk checksum is re-verified against
  the recorded one before anything runs. A mismatch (an applied migration
  was edited after the fact) aborts immediately — nothing is silently
  reapplied or ignored.
- A MariaDB named lock (`GET_LOCK('brawlranks_schema_migration', 30)` /
  `RELEASE_LOCK`) serializes concurrent runs, so two deploys — or a human
  and a cron job — can never apply migrations at the same time.
- Each migration file runs inside its own transaction. A failure rolls back
  that migration and stops immediately; no later pending migration is
  attempted.
- The runner only ever `CREATE`s new tables. It never drops or alters an
  existing table, and it never references `api_test_snapshots`.
- There is no automatic `down`/rollback command — see "Rollback procedure"
  below.

## Phase 2 table inventory

Eight migrations, `migrations/0001` through `0008`, all
`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, all
primary keys `CHAR(36)` (application-generated via `crypto.randomUUID()`,
per the spec's canonical entity model — Section 7.6). This is a different
key strategy than the pre-existing `api_test_snapshots` proof-of-concept
table (`BIGINT AUTO_INCREMENT`), which is left untouched and out of scope.

| Migration | Tables | Purpose |
|---|---|---|
| `0001_create_data_source_registry.sql` | `data_sources`, `source_endpoints` | Registry of approved upstream data sources and their verified endpoints (Section 7.1/7.21). |
| `0002_create_workflow_foundation.sql` | `workflow_definitions`, `workflow_runs`, `workflow_steps`, `workflow_locks` | Workflow/run traceability and the generated-column single-active-lock pattern. |
| `0003_create_fetch_run_tracking.sql` | `data_fetch_runs` | Full lifecycle of one fetch attempt against one source endpoint, including `changes_detected_count`. |
| `0004_create_raw_snapshot_storage.sql` | `raw_api_snapshots` | Immutable, append-only raw payload storage (layer A). `payload` is `LONGTEXT`, never `JSON` — see "MariaDB compatibility" below. |
| `0005_create_normalized_snapshot_foundation.sql` | `normalized_snapshots` | Layer B input to change detection. Generated-column pattern enforces at most one `is_accepted = 1` row per `(entity_type, entity_id)`. |
| `0006_create_canonical_brawler_catalog.sql` | `canonical_brawlers`, `brawler_aliases`, `gadgets`, `star_powers` | The canonical entity model for the Brawler vertical slice. Deliberately excludes rarity/class/description/image columns and gears — unverified this session, not invented. |
| `0007_create_change_detection.sql` | `detected_changes` | Change events (Section 8). A no-change run writes zero rows here. |
| `0008_create_data_incidents.sql` | `data_incidents` | Quarantine/incident records (Section 7.24). `detail` must never contain a secret. |

### Foreign keys, constraints, indexes

- `source_endpoints.data_source_id → data_sources.id`; unique
  `(data_source_id, endpoint_category)`.
- `workflow_runs.workflow_definition_id → workflow_definitions.id`.
- `workflow_steps.workflow_run_id → workflow_runs.id`; unique
  `(workflow_run_id, step_order)`.
- `workflow_locks.workflow_definition_id → workflow_definitions.id`; unique
  `(workflow_definition_id, active_flag)` where
  `active_flag = IF(released_at IS NULL, 1, NULL)` — MariaDB's equivalent of
  a Postgres partial unique index (Section 25/26.4's "generated-column
  unique pattern").
- `data_fetch_runs.data_source_id → data_sources.id`,
  `.source_endpoint_id → source_endpoints.id`,
  `.workflow_run_id → workflow_runs.id` (nullable).
- `raw_api_snapshots.data_fetch_run_id → data_fetch_runs.id`.
- `normalized_snapshots.data_fetch_run_id → data_fetch_runs.id`; unique
  `(entity_type, entity_id, accepted_flag)` where
  `accepted_flag = IF(is_accepted = 1, 1, NULL)`.
- `canonical_brawlers.last_fetch_run_id → data_fetch_runs.id` (nullable);
  unique `source_brawler_id`; unique `slug`.
- `brawler_aliases.brawler_id → canonical_brawlers.id`; unique
  `(brawler_id, alias)`.
- `gadgets.brawler_id`/`star_powers.brawler_id → canonical_brawlers.id`;
  unique `(brawler_id, source_gadget_id)` / `(brawler_id, source_star_power_id)`.
- `detected_changes.data_fetch_run_id → data_fetch_runs.id`.
- `data_incidents.related_fetch_run_id → data_fetch_runs.id` (nullable).
- Every enum-like column (`source_type`, `status`, `trigger_type`,
  `change_type`, `severity`, `incident_type`, `alias_type`, etc.) is backed
  by a `CHECK (... IN (...))` constraint — MariaDB supports `CHECK`, unlike
  `CAST(? AS JSON)`.

## MariaDB compatibility notes

- **No `CAST(? AS JSON)`.** Every JSON-shaped payload (`payload`,
  `normalized_payload`, `output_summary`, `detail`, `config`) is a
  `LONGTEXT` column. The application serializes/deserializes JSON in
  TypeScript; nothing relies on the MySQL `JSON` type or `JSON_VALID` casts.
- **Generated-column unique pattern**, used twice (`workflow_locks.active_flag`,
  `normalized_snapshots.accepted_flag`) as this MariaDB version's equivalent
  of a Postgres partial unique index.
- **`GET_LOCK()`/`RELEASE_LOCK()`** for the migration-runner concurrency
  lock specifically — chosen because it works before any lock table exists
  (the bootstrap problem: you need a lock before you can create the table
  that would otherwise hold it).
- **`SELECT ... FOR UPDATE`** is the pattern used for the application-level
  workflow lock (`workflow_locks`), consistent with Section 26.4.

## Data source / endpoint seeding

`scripts/seed-catalog-source.mjs` registers the `official-brawl-stars-api`
data source and its `brawlers_catalog` (`/v1/brawlers`) endpoint. This is
data seeding, not schema DDL, so it is intentionally kept out of
`migrations/*.sql` — re-running it (e.g. to bump `verified_at`) must not
trip the migration runner's checksum-drift protection.

```bash
npm run seed:catalog-source
```

Idempotent: uses `INSERT ... ON DUPLICATE KEY UPDATE` keyed on the unique
columns, so re-running it never creates duplicate rows.

## Canonical Brawler catalog sync (the vertical slice)

`lib/catalog/sync.ts` → `runCatalogSync(triggeredBy, triggeredByActor?)`
implements the full pipeline:

```
official API → proxy (lib/proxy.ts) → tracked fetch run (data_fetch_runs)
  → immutable raw snapshot (raw_api_snapshots)
  → validation (lib/catalog/schema.ts)
  → canonical normalization (lib/catalog/normalize.ts)
  → normalized snapshot (normalized_snapshots)
  → change detection (lib/catalog/changeDetection.ts → detected_changes)
  → canonical upsert (canonical_brawlers / brawler_aliases / gadgets / star_powers)
  → successful completion (workflow_runs / data_fetch_runs)
```

- Triggered via `POST /api/internal/cron/catalog-sync` (Bearer-authenticated
  with `INTERNAL_CRON_SECRET`, timing-safe, Node runtime, never reachable
  from client code).
- Read-only operational status: `GET /api/internal/test/catalog-status`
  (same auth) — returns counts, recent fetch runs, recent changes, and open
  incidents only. Never returns raw/normalized payload bytes or secrets.

### Raw vs. normalized

`raw_api_snapshots` is the byte-for-byte proxy response, append-only,
never updated or deleted by application code. `normalized_snapshots` is the
canonicalized, order-stable shape (`{ sourceId, name, slug, starPowers[],
gadgets[] }`, nested arrays sorted by source id) used for change-detection
comparison — one row per `(entity_type, entity_id)` per fetch run, with at
most one `is_accepted = 1` row per entity at any time (DB-enforced).

### Validation (`lib/catalog/schema.ts`)

Defensive by design: only `id` and `name` are required per Brawler item.
`starPowers`/`gadgets` are optional, best-effort arrays — a malformed nested
entry is dropped, not treated as a reason to reject the parent Brawler. An
unrecognized extra field on an item (e.g. a future `rarity` field) is
ignored, never a rejection reason. **The real `/v1/brawlers` payload shape
has not been independently verified in this session** — no local DB
credentials and no Hostinger MCP access to inspect a stored raw snapshot —
so this validator is deliberately conservative rather than assuming an
unverified shape. See "Known limitations" below.

### Canonical identity & aliases (Section 7.6)

`canonical_brawlers.source_brawler_id` is the 1:1 mapping to the official
API's Brawler id. `slug` is generated once at first sync
(`lib/catalog/normalize.ts#generateSlug`) and never regenerated — a later
name change writes a `brawler_aliases` row (`alias_type = 'name_history'`)
and updates `canonical_brawlers.name`, but never changes the slug and never
creates a second canonical row for the same `source_brawler_id`.

### Change detection (Section 8)

`lib/catalog/changeDetection.ts` compares the newest normalized candidate
against the last **accepted** normalized snapshot for that entity — never
raw, never published. Emits, for this vertical slice:

- `new_brawler` — no previously accepted row exists.
- `brawler_removed_or_deprecated` — a previously accepted entity is absent
  from the new fetch (and the removal isn't part of a blocked mass change).
- `gadget_change` / `star_power_change` — a nested item was added or
  removed (an `info`-severity addition, a `warning`-severity removal).
- Identical checksum between candidate and previous accepted → **zero**
  rows are written, and the run does not proceed to recalculation or
  publication for that entity (Section 8.2's no-meaningful-change rule).
- A pure rename (name differs, everything else identical) intentionally
  produces **zero** `detected_changes` rows — there is no `name_change`
  entry in the `change_type` `CHECK` constraint, and forcing it into an
  unrelated bucket would misrepresent the event. It is still captured
  precisely via the `brawler_aliases` mechanism above.
- `missing_source_data` / `unexpected_mass_change` — set-level guards
  (`detectVolumeAnomaly`): zero new items when previous data existed, or
  more than half the previously-known roster disappearing in one run, both
  **block acceptance** of that run entirely. A `data_incident` is opened
  (`partial_payload` / `volume_collapse`), the fetch run is marked
  `partial`, the workflow run is marked `held`, and no canonical/normalized
  writes happen for that run — this is the mass-removal protection
  mechanism, and it is covered by
  `tests/changeDetection.test.ts`'s "mass-removal protection" cases.
- `stat_change`, `new_game_mode`, `patch_version_change`, `gear_change`,
  `schema_change` are defined in the `detected_changes.change_type` `CHECK`
  constraint for future phases but never fire from this vertical slice — the
  catalog endpoint carries no numeric stats, game modes, patch version, or
  gear data.

### Transaction safety & idempotency

The raw fetch, proxy call, and payload validation happen before any
database transaction opens. The raw snapshot insert, the volume-anomaly
check, every canonical/normalized/change-detection write, and the incident
write for rejected items all happen inside **one transaction**
(`pool.getConnection()` → `beginTransaction()` → ... → `commit()`, with
`rollback()` on any thrown error). A failure anywhere in that phase rolls
back to zero partial application — a retried sync after a failure is always
safe, never picks up half-applied state. Fetch-run and workflow-run
bookkeeping is written separately (outside the transaction, after commit)
so a lifecycle record always exists even if the pipeline fails before
reaching the transaction.

### Incident/quarantine behavior (Section 7.24)

- Individual malformed items are quarantined at the validation layer
  (dropped from `valid`, listed in `rejected`) without failing the run.
- If any items were rejected, one `data_incidents` row
  (`incident_type = 'invalid_value'`) is opened per run, listing up to the
  first 20 rejected items' index/reason/id — never raw secret data.
- Volume anomalies open a `partial_payload` or `volume_collapse` incident
  and hold the run (see "Change detection" above).

## Idempotency guarantees

- Migrations: `schema_migrations` primary key on `version` — re-running
  `migrate:up` after all migrations are applied is a documented no-op.
- Source/endpoint seeding: `INSERT ... ON DUPLICATE KEY UPDATE` on unique
  `name` / `(data_source_id, endpoint_category)`.
- Canonical Brawler upsert: keyed on unique `source_brawler_id`; alias
  insert keyed on unique `(brawler_id, alias)` — re-observing an existing
  alias is a no-op.
- Gadget/star power upsert: keyed on unique `(brawler_id, source_gadget_id)`
  / `(brawler_id, source_star_power_id)`.
- A full catalog sync run against unchanged upstream data detects zero
  changes and leaves canonical state unchanged (`tests/dbIntegration.test.ts`
  — skipped locally, see "Known limitations").

## Internal auth

Both new routes (`/api/internal/cron/catalog-sync`,
`/api/internal/test/catalog-status`) reuse the existing
`verifyInternalCronBearer` (`lib/auth.ts`) — timing-safe comparison against
`INTERNAL_CRON_SECRET`, `Authorization: Bearer <secret>` only, no query-string
fallback, no weakened check. Neither route is imported by any client-facing
code path.

## Known limitations

- **No Hostinger MCP available this session** (confirmed via `ToolSearch`
  and `ListMcpResourcesTool` — only Canva/Higgsfield/Figma servers are
  connected). No migration was applied to production, no production sync
  ran, no production log/health was inspected. See the final report for the
  exact list of blocked actions.
- **No real database credentials exist in this local environment** — only
  `.env.example` with empty values. Every test or script that requires a
  live MySQL/MariaDB connection is written to skip gracefully (not fabricate
  a pass) when `DB_HOST`/`DB_NAME`/`DB_USER`/`BRAWL_DB_SECRET_V1` are unset
  — see `tests/dbIntegration.test.ts`.
- **The real `/v1/brawlers` payload shape has not been independently
  verified this session.** The validator and normalizer are built
  defensively against the general, publicly documented shape (`{ items: [{
  id, name, starPowers: [...], gadgets: [...] }] }`), requiring only `id`
  and `name`. The first real production sync run should be manually spot
  checked against `raw_api_snapshots` before relying on the normalized
  output.
- `rarity`, `class`, `description`, image fields, and a `gears` table are
  intentionally not modeled (migration 0006's header comment) — add them in
  a later migration once independently confirmed from a real payload.

## Phase 3 prerequisites

Everything below is explicitly out of scope for Phase 2 and was not
started: broad player sampling, continuous crawling, club expansion, battle
log collection/dedup, statistical aggregation (win/pick rate, weighting,
confidence engine), the ranking engine, tier assignment, build/counter
recommendation engines, AI explanations, ranking-publication quality gates,
publication snapshots for public pages (layer D), the admin dashboard, and
any public website page. Phase 3 can build on top of the canonical
`canonical_brawlers` table and the `normalized_snapshots`/`detected_changes`
audit trail this phase established, but none of that later work has begun.

## Rollback procedure

There is no automatic rollback command by design (Section 7.24 — destructive
operations must be a reviewed, human action). To roll back Phase 2 entirely,
a human runs the following in strict reverse-dependency order, after
confirming nothing in Phase 3+ has come to depend on these tables:

```sql
DROP TABLE IF EXISTS data_incidents;
DROP TABLE IF EXISTS detected_changes;
DROP TABLE IF EXISTS gadgets;
DROP TABLE IF EXISTS star_powers;
DROP TABLE IF EXISTS brawler_aliases;
DROP TABLE IF EXISTS canonical_brawlers;
DROP TABLE IF EXISTS normalized_snapshots;
DROP TABLE IF EXISTS raw_api_snapshots;
DROP TABLE IF EXISTS data_fetch_runs;
DROP TABLE IF EXISTS workflow_locks;
DROP TABLE IF EXISTS workflow_steps;
DROP TABLE IF EXISTS workflow_runs;
DROP TABLE IF EXISTS workflow_definitions;
DROP TABLE IF EXISTS source_endpoints;
DROP TABLE IF EXISTS data_sources;
DELETE FROM schema_migrations WHERE version BETWEEN '0001' AND '0008';
```

`api_test_snapshots` is never touched by this procedure.

## Local commands reference

```bash
npm run migrate:status       # inspect applied/pending migrations
npm run migrate:up           # apply pending migrations
npm run seed:catalog-source  # idempotently register the official API source/endpoint
npm run typecheck            # tsc --noEmit
npm run test                 # node:test via tsx, DB tests skip without credentials
npm run lint
npm run build
```
