# Phase 3 — Official Brawl Stars API Ingestion System

This document covers what Phase 3 added on top of Phase 2's production
database foundation and canonical Brawler catalog: rankings/player/club
ingestion, player sampling and crawl scheduling, the battle-log pipeline
(deterministic identity, deduplication, quarantine), rate-limit budgeting,
retry/backoff, and the internal execution/health routes that drive it.

This document does not restate the specification. `BRAWLRANKS_WEBSITE_SPEC.md`
is the single source of truth — in particular Sections 6, 7.1–7.6, 7.14,
7.15, 7.19–7.24, 7.26, 15, 24.2–24.6, 25, 29, 30, 38, 43, 44, 51, 52. Where
this document and the spec ever disagree, the spec wins. `PHASE2.md` covers
everything this phase reuses unchanged (migration runner, workflow
foundation, canonical Brawler catalog, `lib/mysql.ts`/`lib/auth.ts`/
`lib/hash.ts`/`lib/errors.ts`/`lib/proxy.ts`'s original `/v1/brawlers`
client).

## Endpoint verification

**No live authenticated call was made to the official API or through the
DigitalOcean proxy this session** — no local proxy credentials exist in
this environment (only `.env.example`; same constraint documented in
Phase 2). Every endpoint below was instead cross-referenced against
multiple independent third-party mirrors/wrappers of the official
documentation, which is the closest available substitute to a live
verification without production access:

- A JS wrapper's published endpoint reference (`Nick-Gabe/brawlstars-api`'s `docs.md`)
- A typed Rust client's struct definitions (`PgBiel/rust-brawl-api`, via docs.rs and raw GitHub source — code-level, not prose, so field names are exact)
- A Python wrapper's method signatures (`SharpBit/brawlstats`)

| Endpoint category | Path (base `https://api.brawlstars.com/v1`) | Confidence | Registered as |
|---|---|---|---|
| Brawler catalog | `GET /brawlers` | High (3 sources, already live in production since Phase 2) | enabled |
| Player profile | `GET /players/{tag}` | High (2+ sources) | enabled |
| Player battle log | `GET /players/{tag}/battlelog` | High (2+ sources incl. typed struct definitions) | enabled |
| Club profile (+ embedded members) | `GET /clubs/{tag}` | High (2+ sources incl. typed struct definitions) | enabled |
| Club members (standalone) | `GET /clubs/{tag}/members` | Medium (1 source) — not called separately; club-profile's embedded `members` array is used instead | not registered |
| Player rankings | `GET /rankings/{countryCode}/players` | High (2+ sources incl. typed struct definitions) | enabled |
| Club rankings | `GET /rankings/{countryCode}/clubs` | High (2+ sources incl. typed struct definitions) | enabled |
| Brawler-scoped rankings | `GET /rankings/{countryCode}/brawlers/{brawlerId}` | Medium (1 source; reuses the player-ranking entry shape) | enabled |
| Events/rotation | `GET /events` | **Low (1 source only)** | **disabled** — registered but not called by any Phase 3 workflow |

`{tag}` is always percent-encoded (`#` → `%23`) before being placed in the
path — confirmed consistently across every source checked
(`lib/ingestion/tags.ts#encodeTagForPath`).

**Critical finding for Section 7.14 (Build Data Limitation):** a battle-log
participant's `brawler` object contains only `{id, name, power, trophies}`
— confirmed via the Rust client's exact typed struct (`BattleBrawler`),
cross-checked against two other independent sources. **Gadget/Star
Power/Gear selection is confirmed NOT present in battle-log data.**
`battle_participants` (migration 0014) therefore has no
`gadget_id`/`star_power_id`/`gear_ids` columns — adding them would be
inventing data the source doesn't provide. The build-recommendation engine
(out of scope for this phase) will need to operate on the fallback ladder
described in spec Section 7.14 (catalog + editorial seed, or a later
approved external source) rather than real usage statistics, for as long
as this remains true.

No `gears` field or endpoint was found in any source checked (mirrors the
same finding already documented in Phase 2's `migrations/0006` — Gears
remain unmodeled).

**This verification method is not a substitute for a live authenticated
call.** The very first production catalog/rankings/player/battle-log sync
should be manually spot-checked against its stored `raw_api_snapshots` row
before the shapes above are treated as fully confirmed.

## The DigitalOcean proxy gap (important known limitation)

Per spec Section 24.4, the proxy exposes only specific, purpose-built
endpoints — never a generic pass-through. `lib/proxy.ts` was extended with
one function per new endpoint (`fetchPlayerFromProxy`,
`fetchPlayerBattleLogFromProxy`, `fetchClubFromProxy`,
`fetchRankingsFromProxy`), each targeting a fixed, hardcoded path template
mirroring the existing `/v1/brawlers` pattern.

**The DigitalOcean proxy's own codebase is a separate deployment outside
this repository** (confirmed in Phase 1 — the proxy rebuild saga is
closed/out of scope). Whether that separate service has actually been
extended to expose `/v1/players/*`, `/v1/clubs/*`, and `/v1/rankings/*` was
**not verified this session** and is **not something this repo's code can
fix** — it requires a separate deployment to the DigitalOcean service. A
live call through any new `lib/proxy.ts` function will fail (404/transport
error) until that happens. This is the single biggest reason live
end-to-end ingestion could not be exercised this session, independent of
the local-credentials gap described below.

## Milestone A — current-state verification (performed)

- `git status`: clean, branch `main`, local HEAD == `origin/main` HEAD ==
  `4345035bb341cdc8235af1623330719618675624` (the confirmed Phase 2
  production commit).
- Hostinger MCP: confirmed unavailable (`ToolSearch("hostinger")` — no
  results; tool-search for "hostinger deploy ssh" returned only unrelated
  Higgsfield tools).
- SSH: an SSH client exists locally and `~/.ssh/known_hosts` shows prior
  connections to `46.101.221.5` (the known DigitalOcean proxy IP) and
  `147.93.93.11:65002` (a non-standard SSH port consistent with Hostinger
  shared/business hosting) — but **no private key file and no running
  ssh-agent exist in this environment**, so this agent session cannot
  authenticate to either host. This is a genuine, verified external
  blocker for this session, not a fabricated one.
- Phase 2 migrations/tables/routes inspected and left unmodified except for
  the two additive `ALTER TABLE` statements in `migrations/0009` (below) —
  no Phase 2 migration file's content or checksum was changed.

## Migrations (0009–0015)

Extends the migration sequence after 0008; every file is new, none of
0001–0008 was edited.

| Migration | Change |
|---|---|
| `0009_extend_fetch_run_and_incident_columns.sql` | `ALTER TABLE data_fetch_runs` adds `request_context`, `next_attempt_at`, `retry_reason`, `retry_of_fetch_run_id` (self-FK) and widens `status` to add `'dead'`. `ALTER TABLE data_incidents` adds `data_category` and widens `incident_type` to add `'rate_limit_exhausted'`/`'stuck_lease'`. |
| `0010_create_game_mode_and_map_catalog.sql` | `canonical_game_modes`, `mode_aliases`, `canonical_maps`, `map_aliases`. |
| `0011_create_seed_and_observed_players.sql` | `seed_players`, `observed_players`. |
| `0012_create_player_crawl_schedule.sql` | `player_crawl_schedule` (due-selection/lease/backoff fields). |
| `0013_create_normalized_players_and_clubs.sql` | `normalized_clubs`, `normalized_players`, `player_name_history`. |
| `0014_create_battle_tables.sql` | `normalized_battles`, `battle_teams`, `battle_participants`, `battle_observations`. |
| `0015_create_rate_budgets.sql` | `ingestion_rate_budgets`, `crawl_batches`. |

Structural checks (`tests/migrations.test.ts`) verify: `NNNN_name.sql`
naming, ascending unique version numbers, no `CAST(? AS JSON)` in
executable SQL, no bare `JSON` column type, and no reference to
`api_test_snapshots` — all pass for the full 0001–0015 set. **Live
"migrations apply cleanly against a fresh MariaDB" execution was not
verified this session** (no reachable database — a local MySQL 8.0 Windows
service exists but its root password is unknown and was not guessed or
probed, consistent with the standing rule against password fingerprinting).
Every `ALTER TABLE ... DROP CONSTRAINT x, ADD CONSTRAINT x` statement in
`0009` uses syntax supported since MariaDB 10.2.6+ (well below the
production 11.8.8), and every `CREATE TABLE` follows the exact
InnoDB/utf8mb4_unicode_ci/`CHAR(36)`/generated-column-pattern conventions
already proven working in Phase 2's production deployment.

### Key design decisions

- **`request_context` on `data_fetch_runs`** (generic `LONGTEXT` JSON,
  e.g. `{"countryCode":"US"}`, `{"playerTag":"#ABC"}`) gives per-region/
  per-player/per-club fetch traceability through ONE existing table rather
  than a near-duplicate table per ingestion domain. Never contains a
  secret.
- **`battle_key` (not `id`) is the deterministic dedup identity** on
  `normalized_battles` — `id` stays a normal application-generated UUID
  (consistent with every other table), `battle_key` is the SHA-256 hex of
  the canonicalized battle identity (see below), UNIQUE-constrained at the
  database level.
- **`battle_observations`** is the multi-observation mechanism: one row per
  `(battle_id, data_fetch_run_id)`, so the same real battle can be linked
  to many different players' crawl runs without ever duplicating the
  battle/team/participant rows.
- **`ingestion_rate_budgets`** is one table, one row per named scope,
  combining configured ceiling with a live atomic counter — deliberately
  not Redis or an external queue (no verified MariaDB blocker justified
  introducing one).

## Source/endpoint and workflow registration

- `scripts/seed-ingestion-sources.mjs` — idempotently registers the 8
  Phase 3 `source_endpoints` rows on the existing `official-brawl-stars-api`
  data source (requires Phase 2's `scripts/seed-catalog-source.mjs` to have
  already run). `events_rotation` is registered `is_enabled = 0` (low
  verification confidence — see above).
- `scripts/seed-ingestion-budgets.mjs` — idempotently seeds
  `ingestion_rate_budgets` with conservative, **configured-not-measured**
  defaults (`global_daily`: 5000/day with 200 reserved; `catalog`: 50/day;
  `rankings`: 300/day; `player_profile`: 500/hour; `battle_log`: 1000/hour;
  `club`: 200/day).
- Workflow definitions are created lazily and idempotently by
  `ensureWorkflowDefinition` (reused from Phase 2's `lib/workflow.ts`) the
  first time each sync module runs — no separate seed script needed, since
  the workflow-definition upsert is already idempotent by design. The five
  new workflow slugs: `ranking-seed-refresh`, `player-discovery`,
  `player-crawl-batch` (no dedicated workflow row — ad hoc profile batches
  don't own a workflow_run per Section 6.3's lighter-weight categorization),
  `battle-log-crawl`, `club-expansion`.

## Rankings, players, clubs, catalog expansion

- **Rankings** (`lib/ingestion/sync/rankingSeedSync.ts`): fetches the
  `player_rankings` leaderboard for a curated initial region set
  (`INITIAL_RANKING_REGIONS = ["global"]`, Section 7.28's "curated initial
  subset" recommendation), validates, upserts `seed_players`, and enters
  each seed player directly into `player_crawl_schedule` (seed players are
  the deliberately-chosen set — Section 7.3 — so they skip the promotion
  gate observed players go through). A failed region is recorded and
  skipped; it never blocks other regions and never deletes existing
  `seed_players` rows.
- **Players** (`lib/ingestion/sync/playerProfileSync.ts`): fetches one
  profile by tag, upserts `normalized_players`, records a
  `player_name_history` row on a detected rename, and marks a player
  `is_reachable = 0` only on a confirmed 404 — never on a transient
  failure.
- **Clubs** (`lib/ingestion/sync/clubSync.ts`): fetches one club profile
  (embedded members included), upserts `normalized_clubs`, and records
  every member as an `observed_players` row (`source_type =
  'club_member'`) — never directly promoted to the active crawl set.
- **Catalog expansion**: Brawler/Gadget/Star Power sync from Phase 2 is
  unchanged and untouched. Game modes and maps (`canonical_game_modes`,
  `canonical_maps`) are populated opportunistically as they're encountered
  in battle-log ingestion (`getOrCreateGameMode`/`getOrCreateMap` in
  `lib/ingestion/repository.ts`) rather than through a dedicated catalog
  endpoint, since the official API does not expose a standalone
  modes/maps catalog endpoint independent of events (Section 7.1's
  "confirmed present" caveat) — this is the honest, verified-behavior path
  rather than inventing a sync workflow against an endpoint that wasn't
  corroborated. Gears remain unmodeled (see above).

## Sampling strategy implementation

- `seed_players` (deliberate) vs. `observed_players` (organic discovery,
  pending promotion) — exactly per Section 7.3.
- **Promotion rule** (`lib/ingestion/sync/playerDiscoverySync.ts`): a
  bounded batch (`DEFAULT_DISCOVERY_PROMOTION_BATCH_SIZE = 20`) is promoted
  per run, round-robining evenly across the `source_type` categories
  present in the backlog (`battle_participant`/`club_member`/
  `ranking_adjacent`). **Honestly documented simplification:** true
  region/trophy-bracket stratified fairness at promotion time is not
  possible — a purely-observed player's region/bracket isn't known until
  their profile is actually fetched, which hasn't happened yet at
  promotion time. The round-robin-by-source addresses the specific risk
  Section 7.3 names (one social cluster, e.g. a single very active club,
  monopolizing discovery) without requiring a profile fetch per candidate.
  Full stratified rebalancing belongs at aggregation time (Section 7.10),
  out of this phase's scope.

## Crawl scheduling

`player_crawl_schedule` (migration 0012) drives due-player selection.
`lib/ingestion/repository.ts#selectAndLeaseDuePlayers` runs inside a
transaction and uses `SELECT ... FOR UPDATE SKIP LOCKED` (supported since
MariaDB 10.6, well below production's 11.8.8) so two concurrent batch
workers can never select the same row; leased rows get
`leased_by_run_id`/`lease_expires_at` set atomically in the same
transaction. Expired leases (a crashed worker) are cleared at the start of
every selection call — this is the stuck-lease recovery mechanism.
`recordCrawlOutcome` handles all three terminal states: `success` (reset
failure count, schedule next due time), `failure_retryable` (increment
failure count, set `backoff_until`), `failure_dead`
(`is_active = 0`, historical battle contributions untouched — Section
7.3's "inactive, not deleted" rule). A player is marked dead after
`MAX_CONSECUTIVE_CRAWL_FAILURES = 5` consecutive retryable failures, or
immediately on a confirmed 404.

## Battle-log pipeline

`lib/ingestion/sync/battleLogCrawlSync.ts` implements Section 7.4's 14
steps per due player: lease acquisition → fetch via the proxy → immutable
raw snapshot (`raw_api_snapshots`, reused from Phase 2) → validation
(`lib/ingestion/schemas.ts#validateBattleLogItems`) → per-battle
normalization → deterministic ID → dedup-or-insert (one DB transaction per
battle) → participant/team merge → observed-player recording → crawl
schedule update. The whole normalize→insert phase per battle runs in one
transaction; a failure rolls back that battle only, and the loop continues
to the next player (a poison battle doesn't take down the whole crawl
batch).

### Deterministic battle-ID algorithm (`lib/ingestion/battleId.ts`)

```
battle_key = SHA256(`${battleTimeRaw}|${mode}|${canonicalTeams}`)

canonicalTeams:
  1. within each team, sort participant tags (uppercased)
  2. join each team's sorted tags with ","
  3. sort the resulting list of team-strings
  4. join with "|"
```

`battleTimeRaw` is the **exact source string**, never reformatted before
hashing (Section 7.4 step 12's "battle time as reported by the source").
Deliberately excludes Brawler selection, result, and duration — those can
only differ between genuinely distinct battles, never between two
observations of the same real battle, so including them would be
redundant. **A battle observed with a different (e.g. smaller) participant
set than another observation at the same timestamp/mode intentionally
produces a different key** — an incomplete/truncated observation is a
data-quality question, not something silently merged on partial
information.

Tested against all 9 required scenarios plus two extras
(`tests/battleId.test.ts`, 11 tests, all passing): different observer/team
order, different within-team participant order, same time different mode,
same time/mode different participants, solo mode, duo mode, team mode,
draws (result is not part of the identity), incomplete participant payload
(produces a different key, by design), distinct-battle collision
resistance (200 battles, zero collisions), tag-case normalization.

### Deduplication

Enforced at two levels: the `battle_key` `UNIQUE` constraint (database),
and an explicit `getBattleIdByKey` check before insert (application). A
second observation inserts only a `battle_observations` row — the
`battle_participants` upsert (`ON DUPLICATE KEY UPDATE`) merges
power/trophies via `COALESCE` (never blanks a known value with a later
thinner observation) and `is_star_player` via `GREATEST` (never
un-flags a star player).

### Unknown-entity handling

- **Unknown Brawler:** the participant is excluded from the resolved team;
  if a team ends up with zero resolvable participants where the source
  reported some, the whole battle is quarantined (`unknown_entity`
  incident opened, battle NOT inserted, raw snapshot already preserved).
  No catalog resync is triggered inline (would contend for the same rate
  budget as the crawl itself) — this is logged as a known simplification,
  not silently solved.
- **Unknown mode/map:** never happens silently — `getOrCreateGameMode`/
  `getOrCreateMap` always create a canonical row from the source string
  itself (there is no "unresolvable" mode/map state for this endpoint,
  since the source always reports a string name, not a foreign-keyed ID
  that could fail to resolve).
- **Missing battle timestamp / malformed team structure:** rejected at
  validation (`validateBattleItem` returns `null`) before reaching the
  pipeline at all — counted in the run's `rejected` count and surfaced via
  an `invalid_value` incident when non-zero.

## Retry/backoff matrix

| Failure code | Retryable | Max attempts | Terminal status |
|---|---|---|---|
| timeout | yes | 3 | failed |
| network_failure | yes | 3 | failed |
| proxy_unavailable | yes | 3 | failed |
| rate_limited (429) | yes | 5 | failed |
| server_error (5xx) | yes | 3 | failed |
| unauthorized (401/403) | no | 1 | dead |
| not_found (404) | no | 1 | dead |
| schema_mismatch | no | 1 | dead |
| invalid_data | no | 1 | dead |
| transaction_failure | yes | 3 | failed |
| deadlock | yes | 3 | failed |
| lock_timeout | yes | 3 | failed |

Backoff is exponential with full jitter (`base=2s, cap=5min,
delay=random(0, min(cap, base*2^attempt))`), honoring `Retry-After`
exactly when present. **Retry for the battle-log/player crawl happens
across scheduled runs** (via `player_crawl_schedule.backoff_until`/
`next_due_at`), never as an in-process retry loop inside one cron-invoked
request — consistent with Section 24.6's "the trigger endpoint returns
quickly" rule.

## Rate-limit budget

`lib/ingestion/rateBudget.ts` + `ingestion_rate_budgets` (migration 0015).
Atomic consumption via a single conditional `UPDATE ... WHERE requests_used
< ceiling` (no separate lock needed — MySQL/MariaDB row UPDATE is itself
atomic). `reserved_for_priority` holds back budget for
catalog/health-check callers. **The seeded ceilings are conservative
configured defaults, not measured official-API limits** — no live proxy
access this session (see "The DigitalOcean proxy gap" above). They must be
tightened or loosened once real usage is observed.

## Concurrency/locking

Reuses Phase 2's `workflow_locks` (generated-column unique pattern) for
one-active-run-per-workflow-type. Adds a second, player-scoped locking
mechanism (`player_crawl_schedule.leased_by_run_id`/`lease_expires_at`,
`SELECT ... FOR UPDATE SKIP LOCKED`) for per-player crawl leases — a
different granularity than the workflow lock, since many players are
processed within one workflow run.

## Quarantine/incident behavior

Extends Phase 2's `data_incidents` (migration 0009 adds `data_category`
and two new `incident_type` values: `rate_limit_exhausted`, `stuck_lease`).
Record-level isolation is used wherever the endpoint's contract allows it
(one malformed battle/ranking-entry/club-member doesn't reject the whole
response); top-level integrity failures (missing `tag`/`name` on a
player/club) reject the whole record and open a `schema_mismatch`
incident. Raw snapshots are always preserved before validation runs.

## Retention/privacy

No new retention automation was built this phase (explicitly deferred per
the task's scope — "the safe metadata and dry-run/reporting foundation").
What's already in place: `normalized_players` stores only tag, display
name, name-color, trophies, exp level, and club reference — no real-world
identity fields exist anywhere in the schema. `battle_participants`
references players by internal UUID (`player_id`), never by raw tag.
`ingestion-health`'s read-only route never returns a raw payload, a full
player profile, or any tag list. Section 7.20's numeric retention windows
(90-day raw snapshot window, etc.) are **not yet enforced by an automated
purge job** — this is an explicit known limitation, not a silent gap.

## Internal execution routes

All Node runtime, all `verifyInternalCronBearer` (timing-safe Bearer,
`INTERNAL_CRON_SECRET`, no query-string fallback), all bounded batch sizes,
all reject malformed bodies with 400, none reachable from client code:

| Route | Method | Purpose | Batch bound |
|---|---|---|---|
| `/api/internal/cron/ranking-seed-refresh` | POST | Refresh the seed pool for up to 5 regions per call | `MAX_REGIONS_PER_REQUEST = 5` |
| `/api/internal/cron/player-discovery` | POST | Promote observed players into the active crawl set | `MAX_BATCH_SIZE = 200` |
| `/api/internal/cron/player-crawl-batch` | POST | Fetch profiles for an explicit, bounded tag list | `MAX_TAGS_PER_REQUEST = 25` |
| `/api/internal/cron/battle-log-crawl-batch` | POST | Run one battle-log crawl batch | `MAX_BATCH_SIZE = 100` |
| `/api/internal/cron/club-expansion` | POST | Fetch one club and record its members as observed players | one club per call |
| `/api/internal/test/ingestion-health` | GET | Read-only operational status (see below) | — |

No route accepts an arbitrary path/URL — every proxy call target is a
fixed, hardcoded template in `lib/proxy.ts`.

## Health/status output

`/api/internal/test/ingestion-health` returns: latest run per workflow
definition, recent failed runs (last 10), open incident counts by type,
rate-budget state per scope, due-player backlog count, active/stale lease
counts, seed-player counts by region, unpromoted observed-player count,
active crawl-player count, normalized player/club/battle counts, battle
participant count, latest battle `occurred_at`, and raw snapshot counts by
endpoint category. Never returns a raw payload, a full player profile, a
tag list, or any secret.

## Test results

`npm run test`: **123 tests total — 112 passed, 0 failed, 11 skipped.**
Skipped tests are exclusively in `tests/dbIntegration.test.ts` (Phase 2)
and `tests/ingestionDbIntegration.test.ts` (Phase 3), explicitly and
honestly skipped because no DB credentials exist locally — never faked as
passing. New Phase 3 test files:

- `tests/battleId.test.ts` — 11 tests, the 9 required deterministic-ID
  scenarios plus 2 extras, all pure-function (no DB).
- `tests/ingestionSchemas.test.ts` — 20 tests covering player/club/
  rankings/battle-log validators: valid payloads, missing required fields,
  malformed nested items dropped without rejecting the parent, partial
  payloads, unrecognized result values normalized not rejected, and an
  explicit assertion that gadget/star-power/gear fields are never
  extracted.
- `tests/ingestionTagsAndRetry.test.ts` — 20 tests covering tag
  normalization/encoding and the full retry-classification/backoff matrix.
- `tests/ingestionRoutesAuth.test.ts` — 18 tests (3 per route × 6 routes):
  missing auth header, wrong bearer token, and a query-string secret
  attempt, all rejected with 401 — run directly against the route handlers,
  no DB needed since auth is checked first.
- `tests/ingestionDbIntegration.test.ts` — 6 tests (all skipped locally):
  atomic budget consumption at the ceiling, reserved-priority enforcement,
  concurrent lease non-overlap, the `battle_key` unique constraint,
  transaction rollback leaving prior battles untouched, and ranking-seed
  sync idempotency.

Lint: clean (`npm run lint`, exit 0). Typecheck: clean (`npm run
typecheck`, `tsc --noEmit`). Build: succeeds, all 6 new routes registered
alongside the 8 Phase 1/2 routes (`npm run build`).

## Production status

**Not attempted — blocked**, for two independently-verified reasons this
session: no Hostinger MCP (`ToolSearch` confirmed unavailable, same as
Phase 2), and no usable SSH credential path (`ssh` client present,
`known_hosts` shows prior connections, but no private key file and no
running `ssh-agent` exist in this environment). No migration was applied
to production, no production sync ran, `ingestion-health` was never called
against the real database, and idempotency was not verified against real
data. This work is **locally complete** and **not** database-migration-
complete, deployed-complete, or production-verified-complete — exactly the
same honest distinction Phase 2's report drew.

## Scheduling

Not configured this phase — blocked by the same production-access gap
above (Hostinger cron configuration requires access to the Hostinger
control panel/SSH, neither available this session). The code/route side is
ready: every route above accepts `Authorization: Bearer <INTERNAL_CRON_SECRET>`
only, matching Section 24.6's required pattern exactly, so a future session
with Hostinger access can wire cron entries directly to these routes
without further code changes. Recommended cadences per Section 7.22/15
(defaults, not yet configured anywhere): `ranking-seed-refresh` daily,
`player-discovery` every 6 hours, `battle-log-crawl-batch` queued/frequent
(cadence pending real rate-limit measurement), `ingestion-health` hourly.

## Security review

- No secret string literal anywhere in the diff (grepped for
  `BRAWL_DB_SECRET_V1=`, `PROXY_SHARED_SECRET=`, `INTERNAL_CRON_SECRET=`
  followed by a non-empty quoted value — zero matches in new/modified
  files).
- No `.env`/`.env.local` staged or committed.
- Every new route uses the existing timing-safe `verifyInternalCronBearer`
  — no query-string fallback (explicitly tested,
  `tests/ingestionRoutesAuth.test.ts`).
- No route accepts an arbitrary proxy path — every `lib/proxy.ts` function
  targets one fixed, hardcoded template.
- No direct call to the official Brawl Stars API anywhere in this repo —
  every fetch goes through `lib/proxy.ts`.
- `data_incidents.detail` and `request_context` never carry a header,
  credential, or Authorization value — only structural context (country
  code, tag, reason).
- `npm audit fix --force` was not run (pre-existing moderate advisories
  from Phase 2 remain unresolved, reported not silently fixed).

## Known limitations

1. No live authenticated call to the official API or proxy this session —
   endpoint/payload shapes are cross-referenced against third-party
   mirrors, not independently confirmed live (see "Endpoint verification").
2. The DigitalOcean proxy's own codebase (a separate deployment) has not
   been extended to expose the new Phase 3 endpoint paths — a genuine gap
   outside this repo's scope (see "The DigitalOcean proxy gap").
3. No production access this session (no Hostinger MCP, no SSH
   credentials) — nothing was deployed, migrated, or smoke-tested in
   production.
4. Rate-limit budget ceilings are conservative configured defaults, not
   measured values.
5. Player-discovery promotion fairness is source-type-based only, not
   region/trophy-bracket-stratified (documented simplification above).
6. No automated retention/purge job yet (Section 7.20's numeric windows
   are documented but not enforced by a scheduled job).
7. `events_rotation` endpoint registered but disabled (single-source
   verification confidence only).
8. Game-mode/map metadata (icons, official numeric IDs beyond the string
   name) is not modeled — only what's needed for battle normalization.

## Phase 4 (aggregation) prerequisites

Everything aggregation-related remains explicitly out of scope and
unstarted: win-rate/pick-rate calculation, bias correction, the ranking
engine, tier assignment, the build/matchup engines, AI explanations,
publication snapshots, and any public page. Phase 4 can build directly on
top of `normalized_battles`/`battle_teams`/`battle_participants` (the
layer-B input Section 7.8 requires) plus the canonical Brawler/mode/map
tables this phase populates — but real battle data will not exist until
the DigitalOcean proxy gap (above) is closed and a production battle-log
crawl actually runs.

## Rollback procedure

Same posture as Phase 2 — no automatic rollback command. To roll back
Phase 3 entirely, in strict reverse-dependency order, after confirming
nothing later depends on these tables:

```sql
DROP TABLE IF EXISTS crawl_batches;
DROP TABLE IF EXISTS ingestion_rate_budgets;
DROP TABLE IF EXISTS battle_observations;
DROP TABLE IF EXISTS battle_participants;
DROP TABLE IF EXISTS battle_teams;
DROP TABLE IF EXISTS normalized_battles;
DROP TABLE IF EXISTS player_name_history;
DROP TABLE IF EXISTS normalized_players;
DROP TABLE IF EXISTS normalized_clubs;
DROP TABLE IF EXISTS player_crawl_schedule;
DROP TABLE IF EXISTS observed_players;
DROP TABLE IF EXISTS seed_players;
DROP TABLE IF EXISTS map_aliases;
DROP TABLE IF EXISTS canonical_maps;
DROP TABLE IF EXISTS mode_aliases;
DROP TABLE IF EXISTS canonical_game_modes;

ALTER TABLE data_incidents
  DROP CONSTRAINT chk_data_incidents_type,
  ADD CONSTRAINT chk_data_incidents_type CHECK (
    incident_type IN (
      'schema_mismatch', 'invalid_value', 'unknown_entity',
      'volume_collapse', 'source_disagreement', 'partial_payload',
      'transaction_failure', 'checksum_inconsistency'
    )
  ),
  DROP COLUMN data_category;

ALTER TABLE data_fetch_runs
  DROP FOREIGN KEY fk_data_fetch_runs_retry_of,
  DROP CONSTRAINT chk_data_fetch_runs_status,
  ADD CONSTRAINT chk_data_fetch_runs_status CHECK (
    status IN ('pending', 'running', 'success', 'partial', 'failed', 'timeout')
  ),
  DROP COLUMN request_context,
  DROP COLUMN next_attempt_at,
  DROP COLUMN retry_reason,
  DROP COLUMN retry_of_fetch_run_id;

DELETE FROM schema_migrations WHERE version BETWEEN '0009' AND '0015';
```

`api_test_snapshots` and every Phase 2 table/row are never touched by this
procedure.

## Local commands reference

```bash
npm run migrate:status            # inspect applied/pending migrations
npm run migrate:up                # apply pending migrations (0009-0015)
npm run seed:catalog-source       # Phase 2 — must run first
npm run seed:ingestion-sources    # Phase 3 — registers rankings/player/club/battle-log endpoints
npm run seed:ingestion-budgets    # Phase 3 — seeds conservative rate budgets
npm run typecheck
npm run test                      # DB tests skip without credentials
npm run lint
npm run build
```
