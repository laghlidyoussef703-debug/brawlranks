# Phase 11 — Approving the first DigitalOcean published snapshot (held run)

The first DigitalOcean ranking run completed and was **held by the
mass-movement guard**, which is the *expected, correct* behavior: the candidate
is compared against the current snapshot, which is still the stale **Hostinger
snapshot from 2026-07-16**, so a large tier movement is unavoidable.

- `rankingRunId` = `f1330134-172f-4ed8-a0ae-e10198494c9c`
- `workflowRunId` = `40583e5c-abac-4e75-a9e8-2ad06bf4bc22`
- `outcome` = `held_mass_movement`, `hold_reason` = `mass_movement_guard`
- `tierMoveRatio` ≈ `0.64762` (guard threshold is `> 0.25` — see
  `lib/ranking/formulas.ts` `exceedsMassMovementGuard`)
- `brawlersEvaluated` = 106, `brawlersPublished` = 0

This is the **controlled bootstrap approval** the DATASET calls for
(`DATASET.md` → "Ranking sequence": *"On approval, verify exactly one current
snapshot, immutable prior snapshots, item counts, and no partial child set"*).
We do **not** rerun aggregation/ranking, change any threshold, or force-update
`published_snapshots` with SQL.

## Why the candidate was held, and why it is representative

The run passed **every quality gate except the mass-movement guard**. The guard
is a *diff* gate — it only fires because the baseline is a 7-day-old snapshot
from a different database, not because the candidate is bad. Representativeness
is confirmed by the repository's own gates (not an invented waiting period):

- All **106** active Brawlers have an overall candidate `ranking_results` row
  (`brawlers_evaluated` = active brawler count).
- The three referenced `aggregation_runs` (per_mode / overall / matchup) are all
  `succeeded` and belong to the completed aggregation workflow.
- The per-row sample floors (`meets_floor`) and confidence bands were applied by
  the engine; at least one Brawler is publishable with an assigned tier.
- `matchup_results` child rows exist (no partial child set).

The approval command re-runs all of these checks before publishing and refuses
if any fails.

## The mechanism

There was no prior approval mechanism, so this change adds the smallest safe one:

- `lib/ranking/approval.ts` `approveHeldRanking` — validates and publishes.
- `scripts/ranking/approve-held-ranking.ts` — the operator CLI.
- It publishes through the **same** transactional function the scheduled path
  uses (`lib/ranking/sync.ts` `publishRankingRunFromCandidates`): supersede +
  create snapshot + insert items + mark run succeeded, **all in one
  transaction**, so any failure preserves the old snapshot. Thresholds/formulas
  are never touched; it only bypasses the *pre-publish* hold (the point of an
  approval) and records an `operator_approval` audit step (who / reason /
  timestamp / evidence hash) inside that transaction.
- It is **idempotent**: `published_snapshots.UNIQUE(ranking_run_id)` means a run
  can only ever have one snapshot; a second attempt is a safe no-op.

## Exact commands (run on the DigitalOcean droplet, writer env present)

### 1. Pre-flight (validate + print evidence, publishes nothing)

```bash
sudo -u brawlworker bash -lc 'set -a; . /etc/brawlranks-worker/ranking.env; set +a; \
  cd /opt/brawlranks-worker/repo && \
  npx tsx scripts/ranking/approve-held-ranking.ts \
    --ranking-run-id=f1330134-172f-4ed8-a0ae-e10198494c9c \
    --approved-by="<your-name-or-email>" \
    --reason="Phase 11 bootstrap: first DigitalOcean snapshot; held only by mass_movement_guard vs stale 2026-07-16 Hostinger baseline" \
    --dry-run'
```

Expect `"event":"result","outcome":"validated"` with an `evidence` block:
`activeBrawlers:106`, `publishableBrawlers > 0`, `guardWouldHold:true`,
`massMovementThreshold:0.25`, and an `evidenceHash`.

### 2. Approve + publish (requires `--confirm`)

```bash
sudo -u brawlworker bash -lc 'set -a; . /etc/brawlranks-worker/ranking.env; set +a; \
  cd /opt/brawlranks-worker/repo && \
  npx tsx scripts/ranking/approve-held-ranking.ts \
    --ranking-run-id=f1330134-172f-4ed8-a0ae-e10198494c9c \
    --approved-by="<your-name-or-email>" \
    --reason="Phase 11 bootstrap: first DigitalOcean snapshot; held only by mass_movement_guard vs stale 2026-07-16 Hostinger baseline" \
    --confirm'
```

Expect `"event":"result","outcome":"published"` with a `snapshotId` and
`brawlersPublished > 0`, then `"event":"exit","code":0`.

**Exit codes:** `0` published / already_published / dry-run OK · `2`
operator/validation refusal (bad input, wrong state, incomplete candidate) · `1`
unexpected failure. Without `--confirm` (and without `--dry-run`) it refuses with
exit `2` and touches nothing.

Prefer a durable, disconnect-proof run:

```bash
sudo systemd-run --unit=ranking-approve --uid=brawlworker \
  --working-directory=/opt/brawlranks-worker/repo \
  --property=EnvironmentFile=/etc/brawlranks-worker/ranking.env \
  /usr/bin/npx tsx scripts/ranking/approve-held-ranking.ts \
    --ranking-run-id=f1330134-172f-4ed8-a0ae-e10198494c9c \
    --approved-by="<your-name-or-email>" --reason="Phase 11 bootstrap first snapshot" --confirm
journalctl -u ranking-approve -f
```

## Final DB validation queries (after approval)

```sql
-- exactly ONE current snapshot, and it points at the approved run:
SELECT id, ranking_run_id, is_current, published_at, superseded_at
FROM published_snapshots WHERE is_current = 1;
-- expect one row with ranking_run_id = 'f1330134-172f-4ed8-a0ae-e10198494c9c'

-- the prior Hostinger snapshot is now superseded (immutable, not deleted):
SELECT id, is_current, superseded_at FROM published_snapshots WHERE is_current = 0 ORDER BY published_at DESC LIMIT 3;

-- item counts (published brawler + matchup items exist, no partial set):
SELECT
  (SELECT COUNT(*) FROM published_snapshot_items WHERE published_snapshot_id = ps.id) AS brawler_items,
  (SELECT COUNT(*) FROM published_matchup_items WHERE published_snapshot_id = ps.id) AS matchup_items
FROM published_snapshots ps WHERE ps.is_current = 1;

-- the ranking_run is now succeeded with a published count (hold_reason preserved):
SELECT status, hold_reason, tier_move_ratio, brawlers_evaluated, brawlers_published, completed_at
FROM ranking_runs WHERE id = 'f1330134-172f-4ed8-a0ae-e10198494c9c';

-- the operator approval is recorded (who / reason / evidence hash), step_order 100:
SELECT step_name, status, completed_at, output_summary
FROM workflow_steps
WHERE workflow_run_id = '40583e5c-abac-4e75-a9e8-2ad06bf4bc22' AND step_name = 'operator_approval';

-- public read contract sanity (the route the site reads):
--   GET /api/public/tier-list should now return the new snapshot's publishedAt/id.
```

Only after this is Phase 12 (read cutover) unblocked.
