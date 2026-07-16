# Phase 4 — Sampling Stability and Historical Dataset Operations

Companion to `PHASE1.md`/`PHASE2.md`/`PHASE3.md`. This phase does not
rebuild anything from Phase 3 (seed players, observed players,
player-crawl-schedule, profile/battle-log fetching, deterministic battle
IDs, dedup, teams/participants, raw snapshots, retries, rate budgets,
workflow locking) — it hardens the fairness, diversity, cadence, retention,
and observability of the pipeline built on top of those, and closes one
real automation gap discovered along the way (Section 3). **No admin
dashboard, no manual editorial workflow, no frontend, no ranking
calculation** — every new mechanism is either fully automatic (a cron-hit
route) or a protected, read-only reporting endpoint.

## 1. Objective

Turn the Phase 3 ingestion pipeline into a stable, diverse, fair,
rate-safe, continuously operating historical dataset collection system —
enough representative battle data, sampled fairly across region, trophy
bracket, and player population, for Phase 5 aggregation and ranking
intelligence to eventually consume. This phase does not compute any
ranking, score, or aggregate statistic beyond diagnostic counts.

## 2. Starting verified production state

No production database access exists in this session (same limitation as
every prior phase — no Hostinger MCP, no usable SSH credential path,
verified by repeated attempts and repeated `ls`/environment checks that
never found a real key). The only prior-session production numbers on
record (from the investigation immediately preceding this phase) were
**575 normalized battles**, **1 active region ("global")**, and
**`normalizedClubCount: 0`** despite club-ingestion code already existing.
All Phase 4 work is local-only: migrations written but not applied to
production, code written and locally tested but not deployed, no
production smoke test performed. This is stated plainly in every section
below rather than implied only here.

## 3. Existing Phase 3 components reused (not rebuilt)

`seed_players`, `observed_players`, `player_crawl_schedule` (lease
columns, `SELECT ... FOR UPDATE SKIP LOCKED`), `normalized_players`,
`normalized_battles`/`battle_participants`/`battle_teams`/
`battle_observations`, `raw_api_snapshots`, `data_fetch_runs`,
`workflow_definitions`/`workflow_runs`/`workflow_steps`/`workflow_locks`,
`ingestion_rate_budgets` + `tryConsumeBudget`, `computeBattleKey`,
`lib/ingestion/retry.ts`'s in-request HTTP retry/backoff,
`lib/ingestion/tags.ts`'s `validateAndNormalizeTag`,
`verifyInternalCronBearer`. All reused as-is; Phase 4 only adds new call
sites and a small number of new columns/indexes on top of them.

**One real automation gap was found and closed, in-scope for Phase 4.4's
"crawl cadence... by category" and the phase's overarching "no manual
workflow" requirement:** `player-crawl-batch` (profile fetching) required
an explicit `tags` array in its request body — nothing in the existing
automatic cron chain ever supplied one, so a battle-log-discovered
participant's real profile (trophies, club, region-relevant data) could
never actually be fetched by an unattended schedule; only a stub row from
`ensurePlayerStub` would ever exist for them. Fixed with a small, additive
change (`app/api/internal/cron/player-crawl-batch/route.ts` +
`lib/ingestion/repository.ts#getUnprofiledPlayerTags`): when no explicit
tags are supplied, the route now self-selects up to `MAX_TAGS_PER_REQUEST`
never-profiled stubs (`trophies IS NULL`, oldest-discovered-first) using
the existing `normalized_players` schema — no new column, no new table.
Explicit-tag requests (manual backfill, targeted retry) still work
unchanged.

## 4. Region strategy (4.1)

`lib/ingestion/regions.ts` introduces `CURATED_REGIONS`: `global` (the
existing production baseline) plus 6 country codes (`us`, `br`, `de`,
`sa`, `id`, `au`) chosen for geographic/population diversity reasoning —
each with a `justification` string in the code, not verified real
player-count data (no live proxy access this session). `INITIAL_RANKING_REGIONS`
(`lib/ingestion/config.ts`) is now derived from this list instead of the
old hardcoded `["global"]`. `isValidCountryCodeShape`/`normalizeCountryCode`
validate every region before it's ever sent to the proxy — invalid shapes
never reach `fetchRankingsFromProxy`. `MAX_REGIONS_PER_REQUEST = 10` bounds
a single request server-side regardless of what a caller's body claims.
Duplicate canonical players across regions are prevented the same way
Phase 3 already prevented duplicate seed rows — `seed_players`/
`player_crawl_schedule` are keyed on `player_tag`, and a region-losing
refresh is guarded by the existing `SEED_STALE_RATIO_GUARD`. Per-region
failure isolation already existed in `rankingSeedSync.ts` (each region's
`RegionResult` is independent); this phase adds `invalid_country_code` as
an explicit isolated-failure outcome rather than aborting the whole batch.

## 5. Trophy-bracket strategy (4.2)

`lib/ingestion/trophyBracket.ts` replaces the old inline
`trophyBracketFor` (previously duplicated in `rankingSeedSync.ts`) with a
single source of truth: 6 brackets (`bracket_0_5k` through
`bracket_75k_plus`) plus an explicit `unranked` sentinel for
null/negative/non-finite trophy values — never fabricated into a real
bracket. Boundaries are monotonic and gap-free (`TROPHY_BRACKETS[i].max
=== TROPHY_BRACKETS[i+1].min`, exclusive upper bound), so every trophy
value — including exact boundary values — resolves to exactly one
bracket, verified for every declared boundary and swept every 137 trophies
from 0–80,000 in `tests/trophyBracket.test.ts`. Assignment is a pure
function of the trophy value, so it's deterministic by construction. No
`CHECK` constraint governs `trophy_bracket` at the DB level (plain
`VARCHAR`), so this is a pure application-code change — no migration.
Reassignment semantics differ deliberately by table: `seed_players.trophy_bracket`
is **refreshed** on every re-observation (an analytical field, tracks live
trophy changes); `player_crawl_schedule.region`/`trophy_bracket` are
**sticky** — the first non-null assignment wins
(`COALESCE(existing, new)`, fixed from the old non-deterministic
`COALESCE(VALUES(x), x)` ordering) — representing a stable
discovery-source tag for fair scheduling, not a live trophy tracker.

## 6. Fair crawl selection / fairness algorithm (4.3)

`lib/ingestion/fairness.ts#selectFairBatch` is a pure, DB-free, weighted
round-robin across `(region, trophy_bracket)` strata: one candidate per
stratum per round, strata visited in stable alphabetical order, until
`batchSize` is reached or every stratum is exhausted. A stratum with a
single due candidate contributes it in round 1 and drops out without
blocking a much larger stratum — this is what gives a brand-new
region/bracket immediate representation instead of waiting for older,
larger strata to empty. Within a stratum, candidates are ordered
oldest-due-first, then by `priority_score` descending, then by `id`
ascending as a final deterministic tie-breaker (required for stable,
reproducible test assertions). `repository.ts#selectAndLeaseDuePlayers`
now: (1) clears any lease whose `lease_expires_at` has passed (stale-lease
recovery — a crashed or timed-out run can never permanently strand a
player), (2) fetches an oversampled, bounded candidate set
(`candidateFetchLimit`, 200–2000 rows) with `FOR UPDATE SKIP LOCKED`
(unchanged Phase 3 locking semantics — no double-lease across concurrent
runs), (3) applies `selectFairBatch` to that candidate set, (4) leases
only the selected subset. A dead/never-succeeding player is bounded from
consuming disproportionate capacity by `MAX_CONSECUTIVE_CRAWL_FAILURES = 5`
(existing Phase 3 deactivation) plus this phase's new bounded priority
decay (Section 7) — it competes for at most one slot per round like every
other candidate, never more.

## 7. Crawl cadence and priority (4.4)

Centralized in `lib/ingestion/cadence.ts` (previously split between a flat
`DEFAULT_RECRAWL_INTERVAL_MS` and a backoff function borrowed from the
in-request HTTP retry module). `computeSuccessDelayMs` distinguishes an
active player (new battles found → 2h re-crawl) from an empty-log player
(zero new battles, not a failure → 12h backoff) — no longer a flat
interval regardless of outcome. `computeCrawlFailureBackoffMs` is
full-jitter exponential, 10 minutes base up to a 24-hour ceiling — a
deliberately different, much longer horizon than
`lib/ingestion/retry.ts#computeBackoffMs`'s 2s–5min in-request HTTP-retry
scale, because this is "try again next scheduled cycle," not "retry this
same request immediately." A small, bounded priority adjustment
(`PRIORITY_DECAY_PER_FAILURE = 0.5`, `PRIORITY_RECOVERY_PER_SUCCESS = 0.1`,
floor `-10`, ceiling `10`) nudges a repeatedly-failing player behind
healthier same-stratum peers without starving it — `next_due_at` remains
the primary sort key, this is a secondary tiebreaker within
`selectFairBatch`. Stratum-level fairness (new/underrepresented vs.
oversampled) is handled structurally by Section 6's round-robin, not
duplicated here — a second weighting system here would fight that
mechanism. Profile-fetch cadence (Section 3's gap fix) uses a simpler
FIFO-by-discovery-time policy rather than the full stratified algorithm,
since a never-profiled stub has no region/bracket to stratify by yet.

## 8. Player discovery and promotion (4.5)

`recordObservedPlayer` (`repository.ts`) now validates every tag via the
existing `validateAndNormalizeTag` **before** it ever reaches
`observed_players` — previously neither the battle-participant path nor
the club-member path validated format, so a malformed or malicious tag
could reach `observed_players` and, via promotion, `player_crawl_schedule`.
Centralizing the check in `recordObservedPlayer` itself closes both call
sites at once (verified directly against a SQL-injection-shaped string in
`tests/phase4DbIntegration.test.ts`).
`lib/ingestion/sync/playerDiscoverySync.ts#selectPromotionBatch` is a pure,
two-tier stratified selection: fine strata are every non-club
`source_type` plus `club_member` sub-grouped **by the discovering club's
tag** — so one very large or highly connected club can never crowd out
players discovered via a different club; it gets exactly one promotion
slot per round-robin cycle, however many members it has waiting. Strata
are visited in ascending order of their coarse source type's **current
representation in the active crawl schedule**
(`getActiveCrawlCountsByStratumSource`) — a source type with fewer
currently-active players is drawn from first, directly satisfying
"promote underrepresented strata first." `runPlayerDiscovery` bounds the
candidate fetch to `batchSize × 4` and the promotion itself to exactly
`batchSize` (default 20, `MAX_BATCH_SIZE = 200` server-enforced) — never
unbounded growth in one run. Full region/trophy-bracket stratification is
honestly **not possible at this step** — a purely observed player's
profile hasn't been fetched yet, so their region/bracket is unknown until
Section 3's profile-fetch loop runs; region/bracket fairness for the
resulting pool is handled downstream by Section 6 once profile data
exists. Repeated observations of the same player are already deduped by
`observed_players`' existing unique key (`ON DUPLICATE KEY UPDATE
source_type = source_type`, a no-op update that avoids a duplicate insert
without changing the original observation).

## 9. Club ingestion behavior (4.6)

**Root cause of `normalizedClubCount: 0`:** `playerProfileSync.ts` only
ever performed a read-only club lookup with no fallback when the club
wasn't yet normalized — and, before this phase, nothing preserved that
unresolved reference anywhere, so it was silently discarded every time.
**Fix:** migration `0017` adds `normalized_players.pending_club_tag`
(nullable `VARCHAR(20)`, indexed). `playerProfileSync.ts` now sets it
whenever a player's profile references a club that isn't normalized yet,
and clears it via `backfillPendingClubLinks` the moment that club is
normalized. **Trigger conditions:** a club is fetched when (a) explicitly
requested via `/api/internal/cron/club-expansion` with a `clubTag`, or (b)
automatically via `player-crawl-batch`'s bounded auto-trigger (up to
`MAX_AUTO_CLUB_TRIGGERS_PER_REQUEST = 3` distinct `pendingClubTag`s per
request — deliberately small so one Hostinger-invoked request can't run
long fetching many clubs inline; the underlying `data_fetch_runs.request_context`
column, added in migration 0009 but previously completely unused, is now
wired up via `createFetchRun`'s new `requestContext` param specifically to
support this). **Repeated-fetch prevention:** `hasRecentFetchRunForContext`
+ a new `recently_fetched` outcome skip a club already fetched within
`RECENT_FETCH_GUARD_MS` (6 hours) — an idempotent, non-error 200 response,
not a failure. **Member discovery is bounded:**
`MAX_CLUB_MEMBERS_TO_DISCOVER = 150` caps how many members one club-fetch
records as `observed_players` per call, so a single very large club can
never explode the discovery/crawl population in one request — remaining
members are simply not observed from this fetch (no data loss for members
already known from elsewhere). Club changes/deletions/not-found reuse the
existing Phase 3 fetch-outcome/incident machinery (an unreachable-club
result records an incident, does not delete the club's prior normalized
data). Player-club linking is idempotent
(`backfillPendingClubLinks`'s `UPDATE ... WHERE pending_club_tag = ?` is
safe to run any number of times).

## 10. Invalid incident investigation and behavior (4.7)

**Honest limitation:** the exact real-world payload shape behind the 3
open production `invalid_value` incidents remains genuinely
**undiagnosed** — there is no production DB read access this session, so
the specific trigger could not be inspected. What this phase delivers
instead is the infrastructure to make future incidents diagnosable and to
stop them multiplying unboundedly: `lib/ingestion/incidents.ts#computeIncidentSignature`
hashes `(incidentType, dataCategory, relatedEntityType, reasonKey)` —
deliberately excluding anything that varies per occurrence of the *same*
underlying problem (fetch-run id, timestamps, exact counts). Migration
`0018` adds `signature`, `occurrence_count`, `last_seen_at` to
`data_incidents` plus a `UNIQUE KEY (incident_type, signature)`.
`createIncident` (`lib/catalog/repository.ts`) is now an upsert: a
recurrence of the same signature increments `occurrence_count` and — if
the incident had been marked `resolved` — reopens it to `open`, rather
than ever creating a duplicate row per occurrence. `battleLogCrawlSync.ts`'s
two incident-creation call sites (`unknown_entity` for an unresolved
Brawler reference, `invalid_value` for rejected battle-log items) and
`clubSync.ts`/`playerProfileSync.ts`'s `schema_mismatch` incidents now all
pass a computed signature. `lib/catalog/sync.ts`'s two pre-existing Phase 2
incident sites were deliberately left untouched (no signature) — the task
explicitly scopes this phase to reusing, not rebuilding, completed
systems, and `signature` is optional so this remains fully backward
compatible. A large-rejection-rate battle-log fetch is already tracked via
`battleLogCrawlSync.ts`'s existing per-run counts and folded into the
run's final workflow status; Section 12's `dataset-coverage` route now
also surfaces a rolling 7-day rejection/empty-log rate so a sustained high
rate is externally visible without needing to inspect individual
incidents. No payload percentage is ever silently discarded without
either an accepted row or a recorded incident.

## 11. Data retention and cleanup (4.8)

`lib/ingestion/retention.ts` centralizes every window (`RETENTION_DAYS`)
and the shared `RETENTION_BATCH_SIZE = 500`. Justification per category:
raw snapshots 90 days (Section 7.20's own example, and the cheapest data
to lose since normalized data already exists), normalized battles 180
days (the actual Phase 5 input plus a debugging buffer — never pruned
before raw snapshots, satisfying "normalized battles must not be deleted
prematurely" since raw snapshots retain a strictly shorter window),
fetch/workflow runs 365 days, resolved incidents 270 days (Section 7.20's
"6–12 months"), unpromoted observed players 60 days (Section 7.21).
**Unreachable/dead players are explicitly never deleted** —
`player_crawl_schedule.is_active = 0` (already implemented in Phase 3) is
itself the retention mechanism; deleting a `normalized_players` row would
also violate the battles-not-prematurely-deleted rule via
`battle_participants.player_id`. `lib/ingestion/retentionQueries.ts`
implements every deletion FK-safe (children before parents — battle
children → normalized battles → raw snapshots → fetch runs → workflow
steps → workflow runs → resolved incidents → unpromoted observed players →
name history) and bounded (`LIMIT` per statement, so no large-table lock
is ever held for a long period); `pruneFetchRunsOlderThan`/
`pruneWorkflowRunsOlderThan` are additionally `NOT EXISTS`-guarded against
every table that stores a "last/first fetch run" pointer, with the
database's own FK constraint as a final safety net if that guard ever
misses a case. `lib/ingestion/sync/retentionSweep.ts#runRetentionSweep`
orchestrates all 9 categories under the standard workflow lock, calling
each category's bounded delete repeatedly (up to
`MAX_ITERATIONS_PER_CATEGORY = 20`, so ≤10,000 rows/category/run) until it
returns 0. `dryRun: true` reports `countOlderThan` per category instead of
deleting anything — this **is** the dry-run/count capability the task
asks for, expressed in code via a request-body flag on the same protected
route (`/api/internal/cron/retention-sweep`), never an admin UI. No
auto-rollback exists or is intended; recommended rollback if a window
proves too aggressive is simply widening the constant in
`RETENTION_DAYS` and redeploying — deleted rows are not recoverable, which
is why every window above is deliberately on the generous/conservative
side.

## 12. Coverage metrics (4.9)

`/api/internal/test/dataset-coverage` (GET, protected, read-only): seed
players by region, active crawl players by region/by trophy bracket, due
backlog by region+bracket, normalized player/battle/participant totals,
battles per day (last 30 days), battles by region/trophy-bracket "where
derivable" (via the crawled player's own `player_crawl_schedule`
region/bracket — honestly caveated as approximate, since it's null for
most organically discovered players until Section 3's profile-fetch loop
resolves them), battles by game mode, battles by map (top 50), battles by
Brawler, Brawler zero-sample and below-minimum-threshold counts (threshold
30, configured not measured), oldest/newest battle timestamp, 7-day
battle-log crawl success/empty-log rate, an approximate deduplication rate
(`(observations − normalized battles) / observations`), and club coverage
(normalized club count, players with a club, players with a still-pending
club tag). Every query is either indexed (existing PKs/FKs, plus this
phase's new `idx_player_crawl_schedule_region_bracket`) or a bounded
aggregate — no full unindexed scan. Never returns a player tag, display
name, or any raw payload — verified in
`tests/phase4DbIntegration.test.ts` by asserting the response body never
matches `"player_tag"` or `"displayName"`.

## 13. Hostinger cron and automation plan (4.10)

**Not configured this session** — same production-access gap as every
prior phase (no Hostinger panel/SSH access). This is the exact
recommendation for whoever does have that access, expressed as real cron
entries against the routes already built and tested locally.

### 13.1 Cron table

| # | Job | Route | Method | Cadence | Minute stagger | Initial batch size | Expected runtime | Lock | Budget scope (ceiling) | Retry behavior | Failure threshold | Depends on |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Ranking seed refresh | `/api/internal/cron/ranking-seed-refresh` | POST | Daily | `0 2 * * *` | up to 10 regions (7 curated today) | low tens of seconds | `workflow_locks` (`ranking-seed-refresh`) | `rankings` (300/day) | per-region isolation; a failed region just waits for tomorrow's run | none — isolated per region | none (first job of the day) |
| 2 | Player discovery | `/api/internal/cron/player-discovery` | POST | Every 30 min | `5,35 * * * *` | `batchSize: 20` (default) | sub-second–few seconds (DB only) | `workflow_locks` (`player-discovery`) | none (no proxy call) | none needed | n/a | job 1 (seed pool) and job 4 (battle-log-discovered participants) |
| 3 | Player crawl batch (profile fetch) | `/api/internal/cron/player-crawl-batch` | POST | Every 15 min | `10,25,40,55 * * * *` | self-driving, ≤25 unprofiled players/run | tens of seconds (proxy-latency bound) | none dedicated today (idempotent upserts make this safe under overlap — see Section 22) | `player_profile` (500/hour); ≈100/hour at this cadence | in-request HTTP retry (`lib/ingestion/retry.ts`) then next scheduled run | n/a | job 2 (newly promoted players) |
| 4 | Battle-log crawl batch | `/api/internal/cron/battle-log-crawl-batch` | POST | Every 10 min | `0,10,20,30,40,50 * * * *` | `batchSize: 25` (default) | tens of seconds | `workflow_locks` (`battle-log-crawl`) + per-player `FOR UPDATE SKIP LOCKED` lease | `battle_log` (1000/hour); ≈150/hour at this cadence | crawl-schedule backoff (`cadence.ts`), never an in-request retry loop | `MAX_CONSECUTIVE_CRAWL_FAILURES = 5` deactivates a player | job 1/2 (populates `player_crawl_schedule`) |
| 5 | Club expansion | `/api/internal/cron/club-expansion` | POST | Not separately scheduled | — | n/a | n/a | none dedicated | `club` (200/day), shared with job 3's auto-trigger | `recently_fetched` 6h guard prevents re-fetch storms | n/a | driven automatically by job 3's ≤3-per-run `pendingClubTag` auto-trigger; keep available for manual/API backfill of a specific club |
| 6 | Retention sweep | `/api/internal/cron/retention-sweep` | POST | Daily | `30 3 * * *` | ≤10,000 rows/category (`RETENTION_BATCH_SIZE × MAX_ITERATIONS_PER_CATEGORY`) | seconds–low minutes depending on backlog | `workflow_locks` (`retention-sweep`) | none | idempotent — a partial sweep just resumes more next run | n/a | should run after the day's crawl jobs, before tomorrow's job 1 |
| — | Dataset coverage / Phase 5 readiness / ingestion health | `/api/internal/test/*` (GET) | GET | On-demand / optional external monitor ping only | — | n/a (read-only) | sub-second–low seconds | none (read-only) | none | n/a | n/a | none — not part of the write pipeline, safe to poll anytime |

### 13.2 Exact commands suitable for Hostinger

Hostinger's cron UI runs a shell command on schedule. Use `curl` against
the deployed domain, with the bearer secret supplied server-side in the
panel's command field (never in application code, never logged):

```bash
# Job 1 — daily 02:00
curl -fsS -m 60 -X POST "https://<your-domain>/api/internal/cron/ranking-seed-refresh" \
  -H "Authorization: Bearer $INTERNAL_CRON_SECRET" -H "Content-Type: application/json" -o /dev/null

# Job 2 — every 30 min at :05/:35
curl -fsS -m 60 -X POST "https://<your-domain>/api/internal/cron/player-discovery" \
  -H "Authorization: Bearer $INTERNAL_CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"batchSize":20}' -o /dev/null

# Job 3 — every 15 min at :10/:25/:40/:55 (self-driving — empty body)
curl -fsS -m 90 -X POST "https://<your-domain>/api/internal/cron/player-crawl-batch" \
  -H "Authorization: Bearer $INTERNAL_CRON_SECRET" -H "Content-Type: application/json" \
  -d '{}' -o /dev/null

# Job 4 — every 10 min
curl -fsS -m 90 -X POST "https://<your-domain>/api/internal/cron/battle-log-crawl-batch" \
  -H "Authorization: Bearer $INTERNAL_CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"batchSize":25}' -o /dev/null

# Job 6 — daily 03:30
curl -fsS -m 120 -X POST "https://<your-domain>/api/internal/cron/retention-sweep" \
  -H "Authorization: Bearer $INTERNAL_CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"dryRun":false}' -o /dev/null
```

If Hostinger's plan supports storing `INTERNAL_CRON_SECRET` as a masked
environment variable available to cron shell commands, prefer
`-H "Authorization: Bearer ${INTERNAL_CRON_SECRET}"` reading from that
variable over pasting the literal value into the panel's command field.

### 13.3 Safe initial batch sizes

Exactly the defaults shown in the table above
(`DEFAULT_CRAWL_BATCH_SIZE = 25`, `DEFAULT_DISCOVERY_PROMOTION_BATCH_SIZE = 20`,
`MAX_TAGS_PER_REQUEST = 25`) — deliberately conservative, well under every
route's own server-enforced ceiling (`MAX_BATCH_SIZE = 100` for
battle-log, `200` for discovery, `25` hard-capped for profile fetch) and
well under every consumed rate-budget ceiling, so first production
rollout has headroom before any budget-exhaustion or timeout risk.

### 13.4 Scale-up procedure

1. Run for at least 48 hours at the initial cadence/batch sizes above.
2. Check `/api/internal/test/dataset-coverage`'s `battleLogCrawlHealth`
   (success rate, empty-log rate) and rate-budget consumption — if success
   rate stays high and budget usage stays well under ceiling, increase
   `battleLogCrawlBatch`'s `batchSize` body param first (highest-value
   lever, largest configured ceiling), in increments of 25, re-checking
   coverage after each change.
3. Only after battle-log crawling is scaled and stable, increase
   `player-crawl-batch`'s cadence (e.g. every 10 min instead of 15) —
   profile fetches feed region/bracket diversity, which matters most once
   there's enough battle volume to stratify.
4. Never increase two jobs' batch size/cadence in the same rollout step —
   change one, observe, then change the next.

### 13.5 Rollback/disable procedure

Every job is a single Hostinger cron entry — disable one by removing or
commenting out its entry in the Hostinger panel; no code change, no
redeploy, no database change required. To pause the entire pipeline
without touching cron config, unset `INTERNAL_CRON_SECRET` in the
environment (every route immediately starts rejecting with `401
server_misconfigured`) — a fast, reversible kill switch, not a data
mutation. Retention sweeps are the one job with an actual side effect
beyond ingestion; if a retention window is later found to be too
aggressive, widen the constant in `lib/ingestion/retention.ts` and
redeploy — there is no auto-rollback of already-deleted rows, which is why
Section 11's windows are conservative by design.

### 13.6 Production validation checklist

Before enabling the full cron table: (1) apply migrations 0017–0019 via
`npm run migrate:up` and confirm with `npm run migrate:status`; (2) call
each route once manually with `curl` and the real bearer secret, confirm
a `200`/`ok: true` response; (3) call `/api/internal/test/dataset-coverage`
and `/api/internal/test/phase5-readiness`, confirm both return `200` with
plausible (non-error) numbers; (4) run `retention-sweep` once with
`{"dryRun": true}` and manually sanity-check the reported counts before
ever enabling a real (non-dry-run) scheduled sweep; (5) only then enable
the cron table above, starting with jobs 1–2, adding 3–4 a day later, and
6 last.

## 14. Rate-budget assumptions

Existing Phase 3 seeded ceilings (`scripts/seed-ingestion-budgets.mjs`,
unchanged this phase): `rankings` 300/day, `player_profile` 500/hour,
`battle_log` 1000/hour, `club` 200/day, `catalog` 50/day, `global_daily`
5000/day (200 reserved for priority callers). Section 13.1's recommended
cadences deliberately consume a small fraction of each (≈2% of `rankings`,
≈20% of `player_profile`, ≈15% of `battle_log`, well under `club`'s ceiling
even accounting for job 3's auto-trigger) — headroom for Section 13.4's
scale-up, and a safety margin against these being conservative guesses
rather than a verified real limit (no live proxy access this session, same
caveat as Phase 3's original seeding).

## 15. Hostinger-limit assumptions

No confirmed production request-timeout or execution-limit number exists
for this environment (no access this session). Every batch size in
Section 13 is sized so a single request should complete in low tens of
seconds even under real network latency to the proxy — conservative
against a commonly-seen 30–120s ceiling on shared/VPS Node hosting, not a
verified Hostinger-specific number. If production logs later show
requests running close to whatever the real ceiling is, reduce batch size
before increasing cadence.

## 16. Phase 5 readiness gates

`/api/internal/test/phase5-readiness` (GET, protected) computes real
counts against 5 **hard gates** (all must pass for `ready: true`): total
normalized battles ≥ 5,000, distinct regions with battles ≥ 2, distinct
trophy brackets with battles ≥ 2, battles in the last 30 days ≥ 500,
zero-sample-Brawler ratio ≤ 50%. And 5 **preferred targets** (reported as
non-blocking `warnings` when unmet): total battles ≥ 20,000, distinct
regions ≥ 5, distinct trophy brackets ≥ 3, below-minimum-sample-Brawler
ratio ≤ 20%, 7-day battle-log crawl success rate ≥ 90%. These are
**configured, reasoned defaults, not spec-mandated or empirically
verified numbers** — Section 7.28 leaves exact sample-size targets an
explicit open owner decision. **The last known production figure, 575
battles, fails the hard total-battles gate by roughly 9×** — stated
explicitly, not implied. Handling for edge cases: a rare/new Brawler
naturally shows as a `zeroSampleBrawlers`/below-threshold entry in
`dataset-coverage`, not a hard blocker on its own (only the aggregate
ratio gates); a rare mode/missing map is absorbed the same way (per-mode/
per-map breakdowns are visible in `dataset-coverage`, not separately
gated); a patch transition or new roster addition is expected to
temporarily depress Brawler coverage ratios — re-run readiness after the
next few crawl cycles rather than reading one snapshot as final. No
ranking, scoring, or weighting logic exists anywhere in this route or
phase.

## 17. Security review

- No secret string literal in the diff (grepped for `BRAWL_DB_SECRET_V1=`,
  `PROXY_SHARED_SECRET=`, `INTERNAL_CRON_SECRET=` followed by a non-empty
  quoted value — zero matches in new/modified files).
- No `.env`/`.env.local` staged or committed.
- Every new route (`retention-sweep`, `dataset-coverage`,
  `phase5-readiness`) uses the existing timing-safe
  `verifyInternalCronBearer`, checked first and before any DB access —
  verified directly in `tests/phase4RoutesAuth.test.ts` (missing header,
  wrong token, query-string-secret attempt, all `401`, and a malformed
  JSON body still returns `401` rather than a `500` from body-parsing
  running before auth).
- No route accepts an arbitrary proxy path or dynamic upstream URL — Phase
  3's fixed-template `lib/proxy.ts` is unchanged and is the only place any
  outbound fetch is constructed.
- No new route returns a raw payload, a full player profile, a tag, or a
  display name — `dataset-coverage` is asserted never to contain
  `"player_tag"`/`"displayName"` in `tests/phase4DbIntegration.test.ts`.
- Every player/club/country/numeric identifier is validated before use:
  `isValidCountryCodeShape` (regions), `trophyBracketFor`'s explicit
  non-finite/negative handling (brackets), `validateAndNormalizeTag`
  (every tag, now centrally enforced inside `recordObservedPlayer` itself
  rather than trusted at each call site).
- Every new/modified route's batch limits are enforced **server-side**
  (`MAX_REGIONS_PER_REQUEST`, `MAX_TAGS_PER_REQUEST`,
  `MAX_AUTO_CLUB_TRIGGERS_PER_REQUEST`, `MAX_CLUB_MEMBERS_TO_DISCOVER`,
  `RETENTION_BATCH_SIZE`/`MAX_ITERATIONS_PER_CATEGORY`), never only
  trusted from a client-supplied body value.
- No stack trace in any HTTP response — every route's `catch` block goes
  through `logSafeError` (server-side only) and returns a fixed safe error
  code via `errorBody`; spot-checked in
  `tests/phase4RoutesAuth.test.ts`'s "never leaks a stack trace" assertion.
- No raw API token, proxy secret, or internal secret is ever logged —
  `logSafeError` never receives a request header or secret value anywhere
  in the new/modified code.
- `data_incidents.detail`/`request_context` continue to carry only
  structured, non-secret diagnostic fields (reason strings, counts, tag
  parameters for traceability) — never a header or credential.

## 18. Test coverage

`npm run test`: **208 tests total — 183 passed, 0 failed, 25 skipped.**
Every skip is explicit and DB-credential-gated (`hasDbEnv` check,
identical pattern to every prior phase's DB-integration files) — never a
silently-passing placeholder. New Phase 4 test files, all added to
`package.json`'s `test` script:

- `tests/fairness.test.ts` — 12 tests: empty/zero-batch-size inputs, a
  large stratum never starving a one-candidate stratum, balanced 50/50
  round-robin split, within-stratum ordering (due-date, then priority,
  then id tie-break), full determinism across repeated calls, null-region
  strata, batch-size bounding, `candidateFetchLimit`'s floor/ceiling.
- `tests/trophyBracket.test.ts` — 7 tests: null/undefined/negative/NaN/
  Infinity all resolve to `unranked`, every declared boundary belongs to
  the next bracket, the top bracket is unbounded, determinism, a full
  gap/overlap sweep from 0–80,000, `isKnownTrophyBracket` on every real id
  plus an unknown string.
- `tests/regions.test.ts` — 8 tests: valid `global`/2-letter shapes,
  invalid shapes including a SQL-injection-shaped and an HTML-shaped
  string, normalization, curated-list self-consistency (no duplicates,
  every entry itself shape-valid), `global` present in the curated set.
- `tests/cadence.test.ts` — 6 tests: active vs. empty-log success delay,
  failure-backoff bounds at count=1, growth with increasing failure count,
  the 24h ceiling never exceeded even at count=1000, zero/negative input
  handled without throwing, the deliberate scale difference from the
  in-request HTTP-retry horizon.
- `tests/incidentSignature.test.ts` — 6 tests: identical input →
  identical signature, different `reasonKey`/`incidentType` → different
  signature, omitted-vs-explicit-null optional fields normalize the same,
  signature shape (64-char lowercase hex).
- `tests/playerDiscovery.test.ts` — 8 tests: empty/zero-batch-size inputs,
  a 100-member club never crowding out a lone non-club observation,
  two different clubs as two independent strata, underrepresented-coarse-
  type-first ordering, full determinism, no duplicates/overflow past
  `batchSize`, a null `clubTag` handled without throwing.
- `tests/phase4RoutesAuth.test.ts` — 13 tests (missing header / wrong
  token / query-string secret / no-stack-trace, across the 3 new routes,
  plus a malformed-JSON-body-still-401 case) — run directly against route
  handlers, no DB needed since auth is checked first.
- `tests/phase4DbIntegration.test.ts` — 13 tests (all DB-gated): sticky
  region/bracket assignment, stale-lease recovery and re-lease, malicious
  tag rejection at the `observed_players` boundary, incident-signature
  deduplication (`occurrence_count` increments, no duplicate row),
  resolved-incident reopening on recurrence, `pending_club_tag`
  resolution via `backfillPendingClubLinks`, retention dry-run
  (zero deletions, accurate counts), bounded/cutoff-correct
  `pruneUnpromotedObservedPlayersOlderThan`, `recordCrawlOutcome`'s
  priority floor never breached under repeated failures,
  `getUnprofiledPlayerTags`'s stub-vs-profiled distinction, both new GET
  routes' authorized-200 shape, and the retention-sweep route's safe
  fallback on a malformed (non-boolean) `dryRun` value.

## 19. Production rollout

**Not performed** — no production access this session (Section 2). The
exact steps for whoever does have access are Section 13.6's checklist,
verbatim.

## 20. Production smoke tests

Not run against real production this session — this is the exact set to
run once deployed, using the real `INTERNAL_CRON_SECRET`:

```bash
curl -s -X POST "https://<your-domain>/api/internal/cron/retention-sweep" \
  -H "Authorization: Bearer $INTERNAL_CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"dryRun":true}'

curl -s "https://<your-domain>/api/internal/test/dataset-coverage" \
  -H "Authorization: Bearer $INTERNAL_CRON_SECRET"

curl -s "https://<your-domain>/api/internal/test/phase5-readiness" \
  -H "Authorization: Bearer $INTERNAL_CRON_SECRET"

curl -s -X POST "https://<your-domain>/api/internal/cron/player-discovery" \
  -H "Authorization: Bearer $INTERNAL_CRON_SECRET" -H "Content-Type: application/json" -d '{"batchSize":5}'
```

Expect: `dryRun` sweep returns `200` with per-category `dryRunCount`
fields and `deleted: 0` everywhere; `dataset-coverage` returns `200` with
no `player_tag`/`displayName` anywhere in the body; `phase5-readiness`
returns `200` with `ready: false` and `blockers` including
`totalBattles` (expected, given 575 known battles); `player-discovery`
with a small `batchSize` returns `200` with a `promotedCount` ≥ 0 and does
not error even if there are currently zero unpromoted candidates.

## 21. Rollback/disable procedure

Identical to Section 13.5 — repeated here per the task's own section
list. Per-job: remove the cron entry in the Hostinger panel (no code
change). Whole-pipeline kill switch: unset `INTERNAL_CRON_SECRET` (every
route immediately 401s). Schema rollback: none of migrations 0017–0019
are destructive (two are additive nullable columns/indexes, one adds
dedup columns and a unique key) — no auto-rollback is implemented or
recommended; if a migration must be reverted, that is a manual, explicit,
forward-only follow-up migration, per this project's standing migration
rules, never an edit to 0017–0019 themselves.

## 22. Known limitations

- **No production verification whatsoever this phase** — every claim
  above is "implemented and locally tested," never "verified in
  production." Restated deliberately, not just in Section 19.
- **The 3 open `invalid_value` incidents' real root cause is still
  undiagnosed** (Section 10) — the infrastructure to aggregate/dedupe/
  reopen them now exists, but no production data was available to actually
  inspect the specific payload shape.
- **`player-crawl-batch` has no dedicated workflow lock.** Idempotent
  upserts (`upsertNormalizedPlayer`'s `ON DUPLICATE KEY UPDATE`,
  `backfillPendingClubLinks`'s conditional `UPDATE`) and the club
  `recently_fetched` guard make overlapping runs safe, but two overlapping
  runs could still both attempt the same never-profiled stub in the small
  window before the first run's `upsertNormalizedPlayer` commits — a
  harmless double-fetch (one extra `player_profile` budget unit consumed),
  not a correctness bug, but worth a dedicated lock in a future pass if
  cadence is ever increased enough to make overlap likely.
- **Battles-by-region/bracket in `dataset-coverage` are approximate**, not
  authoritative — they reflect the *crawled* player's own
  `player_crawl_schedule` region/bracket, not every participant's, and
  that field is null until Section 3's profile-fetch loop resolves an
  organically-discovered player. Documented as "where derivable" in the
  route itself, not overclaimed.
- **Rate-budget ceilings and Hostinger timeout assumptions are configured
  guesses**, not measurements (Sections 14–15) — no live proxy access or
  production request-timing data exists this session, same limitation
  every prior phase has carried forward honestly.
- **Retention windows are configured, not data-driven** — no real
  storage-pressure numbers exist to calibrate against.

## 23. Exact items deferred to Phase 5

Every ranking, scoring, weighting, or aggregation calculation; any
frontend/public page; any admin surface; applying migrations 0017–0019 to
production; configuring the Section 13 cron table in the real Hostinger
panel; running the Section 20 smoke tests against real production;
diagnosing the 3 open incidents' actual root cause once production data is
reachable; revisiting `RETENTION_DAYS`/rate-budget ceilings/
`phase5-readiness` thresholds once real usage data exists; deciding
whether `player-crawl-batch` needs a dedicated workflow lock once real
cadence is increased past what Section 22 currently judges safe without
one.
