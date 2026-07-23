# Phase 11 — ranking-rebuild worker (DigitalOcean)

Runs the ranking rebuild **out of the Hostinger Next.js process**, on the
DigitalOcean droplet, under systemd. It connects directly to DigitalOcean MySQL
(writer role + TLS) and drives the existing workflow/cursor/lock engine
(`lib/ranking/sync.ts` `stepRankingRebuild`) through every phase:
`brawlers -> matchups -> finalize -> publish -> completed`. No HTTP, no nginx, no
Next.js fire-and-forget. Ranking formulas, tier thresholds, hold rules,
publication safeguards, and snapshot semantics are unchanged — the worker only
*calls* the existing engine.

- Worker: `scripts/worker/ranking-worker.ts` (run with `npx tsx … --drive`)
- Retired HTTP trigger: `POST /api/internal/cron/ranking-rebuild` now returns **410** and executes nothing.

> **NO timer is shipped or enabled.** Ranking is a *gated* workflow: it must run
> only AFTER a fresh statistical aggregation has fully succeeded (all three
> scoped `aggregation_runs`). Start it deliberately, never on a blind clock.
> The unit `Conflicts=` the aggregation unit so the two never run together.

## 0. Prerequisites (1 GB droplet)

- Node.js 20 LTS + npm. Verify: `node -v`.
- Outbound access to the DO MySQL writer endpoint (port 25060).
- The DO MySQL CA cert saved at `/etc/brawlranks-worker/do-mysql-ca.crt`.
- A **completed** statistical aggregation (run the aggregation worker first).

## 1. Install the code at /opt/brawlranks-worker/repo

The systemd unit's `WorkingDirectory=/opt/brawlranks-worker/repo`, so the repo
checkout lives in the `repo/` subdirectory.

```bash
sudo mkdir -p /opt/brawlranks-worker/repo
sudo chown "$USER":"$USER" /opt/brawlranks-worker/repo
git clone https://github.com/laghlidyoussef703-debug/brawlranks.git /opt/brawlranks-worker/repo
cd /opt/brawlranks-worker/repo
git checkout dataset/phase8-phase9-incremental-sync   # branch carrying this fix
npm ci                                                # installs mysql2 + tsx
```

## 2. Service user + env + CA (no secrets printed)

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin brawlworker || true
sudo chown -R brawlworker:brawlworker /opt/brawlranks-worker/repo

sudo mkdir -p /etc/brawlranks-worker
# Put the real DO MySQL CA here (shared with the aggregation worker):
sudo install -o root -g brawlworker -m 0640 /path/to/do-mysql-ca.crt /etc/brawlranks-worker/do-mysql-ca.crt

# Create the ranking env file from the example, then edit in the real writer secret.
sudo install -o root -g brawlworker -m 0640 \
  /opt/brawlranks-worker/repo/ops/ranking-worker/ranking.env.example \
  /etc/brawlranks-worker/ranking.env
sudo -e /etc/brawlranks-worker/ranking.env          # edit; never `cat` it
```

The env file is `0640 root:brawlworker` — readable by the service, not
world-readable, and never echoed.

## 3. Install the systemd unit (no timer)

```bash
sudo cp /opt/brawlranks-worker/repo/ops/ranking-worker/brawlranks-ranking-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
# There is intentionally NO timer to enable.
```

## 4. Phase 11 — drive the CURRENT (stuck) ranking workflow to completion

Run the driver ONCE, under systemd, so it survives SSH disconnects. Its first
slice reconciles the stalled run (`workflowRunId=c789b82c-…`,
`rankingRunId=c15fc8bd-…`) via `reconcileStaleWorkflowRuns` once its heartbeat is
older than 15 min, then drives fresh bounded slices until `completed`:

```bash
sudo systemctl start brawlranks-ranking-worker.service   # blocks until the run finishes
```

Watch it (in another shell, or after reconnecting):

```bash
journalctl -u brawlranks-ranking-worker.service -f
sudo systemctl status brawlranks-ranking-worker.service   # ExecMainStatus=0 on success
```

Prefer to run it detached without the unit? Equivalent one-off:

```bash
sudo systemd-run --unit=ranking-canary --uid=brawlworker \
  --working-directory=/opt/brawlranks-worker/repo \
  --property=EnvironmentFile=/etc/brawlranks-worker/ranking.env \
  /usr/bin/npx tsx scripts/worker/ranking-worker.ts --drive
journalctl -u ranking-canary -f
```

Expected log tail ends with:
```json
{"worker":"ranking","event":"completed","workflowRunId":"…","rankingRunId":"…","outcome":"published",...}
{"worker":"ranking","event":"exit","code":0,"mode":"drive"}
```
(`outcome` may legitimately be `held_mass_movement` or `no_significant_change` —
those are safe, publish-nothing completions, still exit 0.)

## 5. Observe progress + workflow state (DB)

```sql
-- newest ranking workflow run:
SELECT id, status, started_at, completed_at, error_summary
FROM workflow_runs
WHERE workflow_definition_id = (SELECT id FROM workflow_definitions WHERE slug='ranking-rebuild')
ORDER BY started_at DESC LIMIT 1;

-- its ranking_runs row (status + counts once published/held):
SELECT id, status, hold_reason, tier_move_ratio, brawlers_evaluated, brawlers_published, completed_at
FROM ranking_runs WHERE workflow_run_id = '<id>';

-- resume cursor / heartbeat (phase + brawlerCursor + last update):
SELECT step_name, status, completed_at, output_summary
FROM workflow_steps WHERE workflow_run_id='<id>' AND step_name='job_cursor';

-- exactly one current published snapshot after a publish:
SELECT id, is_current, published_at FROM published_snapshots WHERE is_current = 1;

-- no stuck lock after a run:
SELECT id, locked_by_run_id, locked_at, expires_at, released_at
FROM workflow_locks
WHERE workflow_definition_id=(SELECT id FROM workflow_definitions WHERE slug='ranking-rebuild')
ORDER BY locked_at DESC LIMIT 3;
```

A single manual slice (diagnostic, not the driver):

```bash
sudo -u brawlworker bash -lc 'set -a; . /etc/brawlranks-worker/ranking.env; set +a; \
  cd /opt/brawlranks-worker/repo && npx tsx scripts/worker/ranking-worker.ts'
```

## 6. Rollback

```bash
sudo systemctl stop brawlranks-ranking-worker.service 2>/dev/null || true
sudo systemctl reset-failed brawlranks-ranking-worker.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/brawlranks-ranking-worker.service
sudo systemctl daemon-reload
```

Any run interrupted by the stop is reconciled automatically on the next
invocation (`reconcileStaleWorkflowRuns`, 15 min) — do **not** manually delete
locks or edit `workflow_runs` / `ranking_runs`. The retired HTTP route and the
worker are additive/inert when unused.
