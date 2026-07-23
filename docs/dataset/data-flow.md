# DATASET Phase 1 — end-to-end data flow

Every transition below is traced to a repository path and function. Evidence tags follow `docs/dataset/phase1-schema-audit.md`: **[CODE]** = proven by reading the implementation, **[PROD]** = owner-supplied production evidence, **[LIVE-REQUIRED]** = unverifiable without a production query.

```text
Official Brawl Stars API
  → DigitalOcean signed proxy                lib/proxy.ts
  → authenticated internal cron routes       app/api/internal/cron/**/route.ts
  → data_fetch_runs + raw_api_snapshots      lib/catalog/repository.ts
  → validation                               lib/ingestion/schemas.ts
  → normalization + deterministic identity   lib/ingestion/battleId.ts
  → battles / teams / participants / observations
  → discovery + crawl scheduling             lib/ingestion/sync/playerDiscoverySync.ts
  → resumable aggregation                    lib/aggregation/*
  → resumable ranking + quality gates        lib/ranking/*
  → atomic published_* snapshot              lib/ranking/repository.ts
  → public read layer                        lib/publishedSnapshots/repository.ts
  → /api/public/tier-list                    app/api/public/tier-list/route.ts
  → frontend + SEO                           lib/publicApi/*, lib/seo/*
```

**[PROD]** All seven collection/aggregation/ranking timers are currently disabled, so no stage of this pipeline is executing. The proxy service remains active.

---

## Stage 1 — Official API → DigitalOcean proxy

**Path:** `lib/proxy.ts` — `fetchBrawlersFromProxy`, `fetchPlayerFromProxy`, `fetchPlayerBattleLogFromProxy`, `fetchClubFromProxy`, `fetchRankingsFromProxy`.

| Aspect | Behavior |
|---|---|
| Input contract | Encoded player/club tag or region code. |
| Output contract | Envelope validated by `validateProxyEnvelope` / `validateProxyObjectEnvelope`; a malformed envelope yields `null` rather than a partial object. |
| Secrets | `DIGITALOCEAN_PROXY_URL`, `PROXY_SHARED_SECRET`. Never logged. |
| Transaction boundary | None — network only. |
| Idempotency | Natural: GET requests with no side effects. |
| Retry | `lib/ingestion/retry.ts` classifies retryable vs. permanent (404 → `dead`). |
| Failure state | Fetch run marked `failed` / `timeout` / `dead`; no raw snapshot written. |
| Rate limiting | `lib/ingestion/rateBudget.ts` — atomic `UPDATE ... WHERE requests_used < limit` against `ingestion_rate_budgets`, with a priority reserve. |

## Stage 2 — Internal cron routes

**Path:** `app/api/internal/cron/**/route.ts`. Auth: `lib/auth.ts::verifyInternalCronBearer` against `INTERNAL_CRON_SECRET`.

**[CODE]** Every internal route verifies the bearer *before* any database or proxy work and returns `401` with `errorBody("UNAUTHORIZED", ...)` on failure. Test coverage: `tests/ingestionRoutesAuth.test.ts`, `tests/phase4RoutesAuth.test.ts`, `tests/aggregationRouteAuth.test.ts`, `tests/rankingRouteAuth.test.ts`.

`app/api/public/tier-list/route.ts` is deliberately unauthenticated — it serves public data and reads only `published_*`.

Concurrency: each job acquires a `workflow_locks` row. `migrations/0002`'s unique `(workflow_definition_id, active_flag)` makes overlap impossible; a loser receives `lock_not_acquired` → HTTP 409, which is normal and not an error.

## Stage 3 — Fetch run + immutable raw snapshot

**Path:** `lib/catalog/repository.ts::createFetchRun`, `insertRawSnapshot`.

| Aspect | Behavior |
|---|---|
| Data written | `data_fetch_runs` row, then `raw_api_snapshots` row with `payload` (stable-stringified JSON) and `checksum` (SHA-256 of that exact text). |
| Transaction boundary | **[CODE]** `insertRawSnapshot` is called on the pool, *outside* the normalization transaction (`battleLogCrawlSync.ts:311` vs. the transaction opened at `:349`). Raw evidence is durable before normalization is attempted — deliberate. |
| Consequence | A crash between the two leaves a raw snapshot with no normalized battles. That is recoverable by replay and is not corruption. |
| Immutability | No `UPDATE` or `DELETE` targets `raw_api_snapshots` anywhere except `pruneRawSnapshotsOlderThan`. |
| Growth | **[PROD]** ~78.16 MB/day of payload. The single largest archival candidate. |

## Stage 4 — Validation

**Path:** `lib/ingestion/schemas.ts::validateBattleLogItems`.

**[CODE]** Returns `{ valid, rejected }`. Rejected items are never written as battles. A rejection rate above 50% sets `highRejectionRateObserved`, which downgrades the workflow to `succeeded_with_warnings`. Rejections raise a `data_incidents` row deduplicated by `computeIncidentSignature` (`migrations/0018`) so one recurring shape issue increments `occurrence_count` rather than creating unbounded incident rows.

## Stage 5 — Normalization and deterministic identity

**Path:** `lib/ingestion/battleId.ts::computeBattleKey`, `battleLogCrawlSync.ts::processOneBattle`.

| Aspect | Behavior |
|---|---|
| Identity | `battle_key` = SHA-256 over canonicalized battle fields. The official API exposes no stable global battle id, so identity is *derived*. |
| Dedup mechanism | **Database-level.** `uniq_normalized_battles_key` is the final guard, not application logic. A second sighting collides and is handled as a merge. |
| Transaction boundary | **[CODE]** One transaction per **player fetch**, wrapping every valid battle in that player's log (`battleLogCrawlSync.ts:349`). Note this differs from DATASET.md's "per battle" description. |
| Outcomes | `inserted` / `deduplicated` / `quarantined`, counted per batch. |
| Data written | `normalized_battles`, `battle_teams`, `battle_participants`, plus exactly one `battle_observations` row per `(battle_id, data_fetch_run_id)`. |
| Idempotency | Re-running the same fetch produces the same `battle_key`; the unique constraint absorbs it. Observations are unique per `(battle, fetch run)`. |
| Failure/recovery | Rollback discards that player's batch; the raw snapshot survives, so replay is possible. |
| Ratios | **[PROD]** ~7.69 participants, ~4.34 teams, ~1.38 observations per battle. |

**This stage produces the only irreplaceable derived data in the system.** Raw payloads can be re-archived; aggregates can be recomputed; a deleted normalized battle whose raw snapshot has also aged out is gone permanently. This is the basis for DATASET.md's rule that deleting normalized battle history is not an acceptable capacity solution.

## Stage 6 — Discovery and crawl scheduling

**Paths:** `lib/ingestion/sync/playerDiscoverySync.ts`, `lib/ingestion/repository.ts`, `lib/ingestion/fairness.ts`.

| Aspect | Behavior |
|---|---|
| Discovery | Battle participants and club members land in `observed_players` (unique `player_tag`, insert-or-ignore). |
| Promotion | `selectPromotionBatch` applies stratified fairness so the sample cannot drift into one region/trophy cluster. |
| Lease | **[CODE]** `lib/ingestion/repository.ts:478` selects due players `FOR UPDATE SKIP LOCKED`, then writes `leased_by_run_id` / `lease_expires_at`. The lease outlives the short lock, so two workers never take the same player. |
| Expired leases | Cleared before selection — a crashed run cannot wedge the queue. |
| Backoff | `recordCrawlOutcome` with `computeCrawlFailureBackoffMs`; repeated failure sets `is_active = 0`, never deletes the row. |
| Cadence | `computeSuccessDelayMs(valid.length)` — a player whose log yielded battles is revisited sooner. |

## Stage 7 — Aggregation

**Paths:** `lib/aggregation/sync.ts`, `lib/aggregation/repository.ts`, `app/api/internal/cron/aggregation-run/route.ts`.

Phases: `mode → overall → matchup → finalize → done`.

| Aspect | Behavior |
|---|---|
| Input | `normalized_battles`, `battle_participants`, `battle_teams`. Never mutates them. |
| Output | Three `aggregation_runs` rows (per_mode/overall/matchup) plus a complete new set of `brawler_mode_aggregates`, `brawler_overall_aggregates`, `matchup_aggregates`. |
| Transaction boundary | One per slice: the batch `INSERT ... SELECT` and the cursor advance commit **together**. |
| Idempotency | An interrupted slice rolls back wholly; the next call re-runs exactly that batch. Never partial, never double. |
| Resume | Cursor persisted in `workflow_steps` (`readJobCursor`/`writeJobCursor`). |
| Concurrency | `workflow_locks`, 2-minute slice TTL; a stale job is reclaimed after 15 minutes by `reconcileStaleWorkflowRuns`. |
| Visibility | Ranking sees an aggregation only when the workflow run **and** all three scoped runs are `succeeded`. |
| **Accumulation** | **A completed run is invisible to `findLatestRunningRun`, so the next scheduled call starts a brand-new full set. Old sets are never superseded or deleted.** |
| Failure | Missing cursor → run marked `failed`; a clean job starts next call. Partial aggregate rows from the abandoned run remain, unreferenced, forever. |

**[PROD]** A completed run produced 1,756 mode + 105 overall + 115,720 matchup aggregates with no reconciliation warnings.

## Stage 8 — Ranking, quality gates, publication

**Paths:** `lib/ranking/sync.ts`, `lib/ranking/repository.ts`, `lib/ranking/formulas.ts`.

Phases: `brawlers → matchups → finalize → publish → done`.

| Phase | Writes | Note |
|---|---|---|
| `brawlers` | `ranking_results` (overall + per-mode candidates) | written **before** any gate is evaluated |
| `matchups` | `matchup_results`, updates `matchup_coverage` | pooled across patch groups |
| `finalize` | pick-rate denominators, meta scores, percentile tiers | needs the whole run, hence a separate phase |
| `publish` | `published_snapshots` + items, or a hold | one transaction |

Gates in `publish`, in order:

1. **Mass-movement guard** — `exceedsMassMovementGuard(tierMoveRatio, isFirstRun)`, `lib/ranking/formulas.ts:214`, holds when `tierMoveRatio > 0.25`. On hold: run status `held`, `hold_reason = 'mass_movement_guard'`, `brawlers_published = 0`, **`published_snapshots.is_current` untouched**. The site keeps serving the previous snapshot.
2. **No-significant-change** — `hasSignificantChange(comparisons, isFirstRun)`. Status `succeeded`, `hold_reason = 'no_significant_change'`, nothing published.
3. **Publication** — one transaction: `supersedeCurrentSnapshot()` then `createPublishedSnapshot()` then all items. The unique `current_flag` makes two current snapshots impossible even under a race.

**[PROD]** Repeated runs: 106 brawlers evaluated, `held_mass_movement`, `brawlersPublished: 0`, `tierMoveRatio` ≈0.56–0.65 — the guard functioning correctly on a young dataset. Each held run still persists a full candidate set, and nothing cleans them up.

## Stage 9 — Public read layer

**Paths:** `lib/publishedSnapshots/repository.ts`, `app/api/public/tier-list/route.ts`.

| Aspect | Behavior |
|---|---|
| Tables read | `published_snapshots`, `published_snapshot_items`, `published_matchup_items`, joined to `canonical_brawlers` and `patches` for labels. **Nothing else.** |
| Current-row lookup | `WHERE is_current = 1 LIMIT 1`, served by the unique `current_flag` index — deliberately never `ORDER BY created_at DESC`, which could surface a superseded row. |
| Contract | `{ available: false, reason: "no_published_snapshot_yet" }` or `{ available: true, publishedAt, patchVersion, brawlers[] }`. |
| Isolation | No public path can reach normalized, raw, aggregate or candidate tables. |

**Consequence for migration:** archiving normalized history, raw payloads, historical aggregates, or old candidates has **no public-API impact**. Publication tables are the opposite — permanently hot, never archived, never purged.

## Stage 10 — Frontend and SEO

`lib/publicApi/types.ts` re-exports the backend types, so the frontend cannot drift from the API contract. `lib/publicApi/tierList.ts` is the client; `components/data-display/*` renders; `lib/seo/jsonld.ts`, `lib/seo/metadata.ts`, `lib/seo/canonicalUrl.ts` derive metadata; `lib/time/staleness.ts` derives freshness from `publishedAt`.

**`canonical_brawlers.slug` is the highest-risk single field**: it is the routing key, the canonical URL component, and the JSON-LD identity. A slug change breaks URLs and inbound links. `migrations/0006` already guarantees a rename produces a `brawler_aliases` row rather than a slug change.

---

## Concurrency and failure summary

| Mechanism | Where | Protects |
|---|---|---|
| `workflow_locks` unique `(definition, active_flag)` | `migrations/0002`, `lib/workflow.ts` | overlapping job invocations |
| `battle_key` unique | `migrations/0014` | duplicate battles |
| `(battle_id, data_fetch_run_id)` unique | `migrations/0014` | duplicate observations |
| `current_flag` unique | `migrations/0024` | two current published snapshots |
| `active_flag` unique on `patches`, `ranking_rule_sets` | `migrations/0020`, `0021` | two active configs |
| `FOR UPDATE SKIP LOCKED` + lease columns | `lib/ingestion/repository.ts` | two workers crawling one player |
| `GET_LOCK` | `scripts/migrate.mjs` | concurrent migration runs |
| slice-scoped transactions | aggregation/ranking | partial batch + cursor divergence |

**Single shared pool.** `lib/mysql.ts` is the only pool in the project, `connectionLimit: 2`, `queueLimit: 10`. Collectors and public readers share it, which is why DATASET.md Phase 9 requires role-aware pools before any staggered cutover — today they cannot be switched independently.
