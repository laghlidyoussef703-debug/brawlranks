# Phase 5 — Durable Batched Execution for Aggregation & Ranking

Companion to `PHASE2.md`–`PHASE4.md` and `BRAWLRANKS_WEBSITE_SPEC.md`
(Sections 7.8, 9, 11, 13, 24.6, 25.2, 26). Phase 5.1–5.3 (inferred patch
tracking, statistical aggregation, ranking calculation + atomic publication)
are **not re-scoped here**. This document covers only the production
**timeout fix**: reworking the two long-running Phase 5 cron jobs so each
HTTP request reliably completes below the hosting request limit, without
weakening any Phase 5.2/5.3 guarantee or changing the public snapshot
contract.

## 1. The production incident

- `POST /api/internal/cron/aggregation-run` began returning **HTTP 504 after
  ~55–57s**. It had succeeded historically; runtime grew with the dataset.
- `POST /api/internal/cron/ranking-rebuild` later returned **HTTP 500**.
- DigitalOcean `TimeoutStartSec` was already 180s and `curl --max-time 180`;
  the ~60s ceiling is enforced by the **Hostinger / application request
  layer**, not the DO scheduler.

### Root cause

Both jobs were single-request, unbounded, row-by-row workloads whose runtime
scaled with the dataset, and both had to finish inside one request:

- **Aggregation** ran three heavy `GROUP BY` scans (the matchup self-join of
  `battle_participants` being the fastest-growing term) and then executed
  **one `INSERT` round-trip per result row** inside a single transaction —
  tens of thousands of round-trips at scale. That insert loop was the
  dominant, dataset-proportional cost that pushed runtime past ~60s → 504.
- **Ranking** fetched every active brawler's raw participation rows
  sequentially and wrote every candidate/published row one at a time.

The **HTTP 500 on ranking** was a *thrown* error (the route maps every real
outcome to 200/409; only an exception yields 500). A 504 does **not** abort
the Node handler — the aggregation kept running server-side, holding one of
the pool's **two** connections (`connectionLimit: 2`, `queueLimit: 10`) for
its whole long transaction. Ranking, fired next, piled its many sequential
queries onto the one remaining connection; once the queue overflowed (or a
connect timeout tripped) mysql2 threw, and the route surfaced it as 500.

### What the 504 left behind

- **No partial aggregate rows** — every aggregate write was in one
  transaction, so an interrupted run rolled back cleanly.
- **A still-running server-side job** that most likely **committed later** —
  a completed DB transaction whose HTTP response was merely cut off.
- Only if the process was actually killed: a lock that self-heals after its
  5-minute TTL, **plus a `workflow_runs` row stuck in `running` forever** —
  a real gap this fix closes (stale-run reconciliation).

## 2. The durable design

Each job is now a **resumable, bounded-batch state machine** driven by
repeated scheduled calls. Every call does one small slice well under the
limit, persists progress, and returns an honest status; the next call
resumes. No Redis/queues/external workers/Supabase/second DB were introduced,
and **no additive migration was required** — durable state lives entirely in
the existing workflow tables.

### Phases

| Job | Phases |
|-----|--------|
| Aggregation | `mode` → `overall` → `matchup` → `finalize` → `done` |
| Ranking | `brawlers` → `matchups` → `finalize` → `publish` → `done` |

- Aggregation replaces the per-row insert loops with set-based
  `INSERT … SELECT … GROUP BY`, **partitioned by a bounded batch of
  brawler_ids** per call (default 8, configurable per request; the matchup
  self-join is restricted to that batch's first-side brawlers).
- Ranking processes a bounded batch of brawlers per call in the `brawlers`
  and `matchups` phases, writing partial candidate rows. `finalize` computes
  the pick-rate denominators and percentile tiers (which need the whole run)
  over the now-persisted, bounded candidate set. `publish` applies the
  mass-movement guard, no-significant-change rule, and atomic snapshot
  publication in a single transaction — semantics unchanged.

### Durable state (no new table)

The resume cursor is a JSON row in **`workflow_steps`** (`step_order 0`,
`step_name 'job_cursor'`) keyed to the job's `workflow_runs` row, which stays
`running` for the whole job. Each slice rewrites the cursor **inside the same
transaction as its writes**, so an interrupted slice rolls back atomically
and the next call re-runs exactly that batch — never a partial or double
write. Rewriting the cursor also advances its `completed_at`, doubling as a
liveness **heartbeat**.

### Locking, concurrency, recovery

- **Per-call mutex:** every slice acquires this workflow's existing
  `workflow_locks` entry (short 2-min TTL) and releases it at call end.
  Between calls no lock is held, so the next scheduled call resumes. An
  overlapping call that can't get the lock returns `lock_not_acquired` (409).
- **Stale-lock recovery:** unchanged TTL sweep in `acquireWorkflowLock`
  reclaims an expired lock left by a crashed process.
- **Stale-run recovery (new):** `reconcileStaleWorkflowRuns` marks a
  `running` job `failed` (`error_summary = 'stale_reclaimed'`) when its
  heartbeat is older than 15 min, so an abandoned job can never permanently
  block a fresh one. A genuinely-resuming job keeps a fresh heartbeat and is
  never reclaimed.
- **Two entry points per job:** `stepAggregation` / `stepRankingRebuild` (one
  bounded slice per HTTP call — used by the cron routes) and
  `runAggregation` / `runRankingRebuild` (a run-to-completion driver that
  holds the lock once and loops every slice — used by tests, manual, and CLI
  where no request limit applies). The driver's return shape is unchanged, so
  existing Phase 5.2/5.3 behavior and callers stay compatible.

### Honest statuses

`started` (fresh job's first slice) · `in_progress` (work remains) ·
`completed` (job done — see `outcome`) · `lock_not_acquired` (409). Terminal
safe-failures (`no_valid_aggregation`, `no_active_rule_set`) report
`completed` with the specific `outcome`.

## 3. Invariants preserved

- **Idempotency / append-only** — fresh run ids per job; resume continues the
  same run; unique keys make any re-run of a batch a no-op-or-reject rather
  than a duplicate.
- **Ranking never runs against an incomplete aggregation** —
  `getLatestSuccessfulAggregation` only returns an aggregation whose
  `workflow_run` is `succeeded`/`succeeded_with_warnings` **and** all three
  scoped `aggregation_runs` succeeded. A half-finished (`running`) aggregation
  is invisible; ranking only ever reads rows scoped to that succeeded run id.
- **Atomic publication, mass-movement guard, no-change rule, rollback** —
  the publish phase is one transaction reached only after the full candidate
  set is computed; the single-current-snapshot DB constraint is unchanged.
- **Reconciliation** — the per-row `reconcileCounts` check is now one
  set-based `COUNT` query per scope; `succeeded_with_warnings` is reported
  identically.
- **Public snapshot contract unchanged** — `published_snapshots` /
  `published_snapshot_items` / `published_matchup_items` shape and the
  read path are untouched.

## 4. Structured logs

Each slice emits a JSON `logSafeInfo` line — `job_started`, `batch_processed`
(phase, brawler count, cursor), `phase_advance`, `job_completed` (outcome +
counts), and failure markers (`job_failed_missing_cursor`, `stale_reclaimed`
via reconcile). No secrets are logged (same contract as `logSafeError`).

## 5. Production rollout

No DigitalOcean, systemd, curl, or Hostinger change is required by this fix;
the endpoints simply need to be **called repeatedly until `completed`**.

1. **Deploy** the app (migrations 0001–0025 already applied; this fix adds
   **no** migration).
2. **Schedule aggregation** to POST `/api/internal/cron/aggregation-run`
   (Bearer `INTERNAL_CRON_SECRET`) on a short interval (e.g. every 1–2 min).
   Each call returns `started` → `in_progress` … → `completed` in seconds.
   Optional body `{"batchSize": N}` (1–50, default 8) tunes work per call;
   the default is a safe margin under the limit.
3. **Schedule ranking** to POST `/api/internal/cron/ranking-rebuild` the same
   way. It self-gates: until a fully-successful aggregation exists it
   `completed`s with outcome `no_valid_aggregation`, harmlessly, and retries
   next tick.
4. **Cadence:** keep the Section 7.22 "every 6–12 hours" business cadence by
   gating *when a fresh job may start* upstream if desired; the resume ticks
   in between are cheap no-ops (`lock_not_acquired`/quick slices) once a job
   is done.
5. **Observability:** watch the structured logs for `job_completed`; a job
   that stops advancing for >15 min is auto-reclaimed and restarts cleanly.

### Verification checklist (run in a migrated environment)

`npm run lint`, `npm run typecheck`, `npm test` (DB-dependent suites run for
real with credentials present; they SKIP without), and `npm run build` — all
green. The new lifecycle is covered by `tests/aggregationResumable.test.ts`
and `tests/rankingResumable.test.ts` (interruption, resume, idempotency,
concurrency, stale-run recovery, incomplete-aggregation rejection, final
publication).
