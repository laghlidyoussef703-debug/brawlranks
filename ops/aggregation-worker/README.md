# Phase 11 — statistical-aggregation worker (DigitalOcean)

Runs statistical aggregation **out of the Hostinger Next.js process**, on the
DigitalOcean droplet, under systemd. It connects directly to DigitalOcean MySQL
(writer role + TLS) and drives the existing workflow/cursor/lock engine
(`lib/aggregation/sync.ts`). No HTTP, no nginx, no Next.js fire-and-forget.

- Worker: `scripts/worker/aggregation-worker.ts` (run with `npx tsx`)
- Retired HTTP trigger: `POST /api/internal/cron/aggregation-run` now returns **410** and executes nothing.

> Keep the **aggregation and ranking timers DISABLED** during deployment and
> canary. Do not `enable --now` any timer until the canary reaches `completed`
> and you decide to resume steady state.

## 0. Prerequisites (1 GB droplet)

- Node.js 20 LTS + npm. Verify: `node -v`.
- Outbound access to the DO MySQL writer endpoint (port 25060).
- The DO MySQL CA cert saved at `/etc/brawlranks-worker/do-mysql-ca.crt`.
- Memory note: `npm ci` installs devDeps (incl. `tsx`); it fits in 1 GB. The
  worker process itself uses well under 100 MB. We do **not** run `next build`.

## 1. Install the code at /opt/brawlranks-worker

```bash
sudo mkdir -p /opt/brawlranks-worker
sudo chown "$USER":"$USER" /opt/brawlranks-worker
git clone https://github.com/laghlidyoussef703-debug/brawlranks.git /opt/brawlranks-worker
cd /opt/brawlranks-worker
git checkout dataset/phase8-phase9-incremental-sync   # branch carrying this fix
npm ci                                                # installs mysql2 + tsx
```

## 2. Service user + env + CA (no secrets printed)

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin brawlworker || true
sudo chown -R brawlworker:brawlworker /opt/brawlranks-worker

sudo mkdir -p /etc/brawlranks-worker
# Put the real DO MySQL CA here:
sudo install -o root -g brawlworker -m 0640 /path/to/do-mysql-ca.crt /etc/brawlranks-worker/do-mysql-ca.crt

# Create the env file from the example, then edit in the real writer secret.
sudo install -o root -g brawlworker -m 0640 \
  /opt/brawlranks-worker/ops/aggregation-worker/aggregation.env.example \
  /etc/brawlranks-worker/aggregation.env
sudo -e /etc/brawlranks-worker/aggregation.env      # edit; never `cat` it
```

The env file is `0640 root:brawlworker` — readable by the service, not
world-readable, and never echoed.

## 3. Install the systemd units (timer stays disabled)

```bash
sudo cp /opt/brawlranks-worker/ops/aggregation-worker/brawlranks-aggregation-worker.service /etc/systemd/system/
sudo cp /opt/brawlranks-worker/ops/aggregation-worker/brawlranks-aggregation-worker.timer   /etc/systemd/system/
sudo systemctl daemon-reload
# DO NOT enable the timer yet.
```

## 4. Phase 11 canary — drive the CURRENT workflow to completion

Run the driver ONCE, under systemd, so it survives SSH disconnects. It executes
bounded slices until `completed`:

```bash
sudo systemctl start brawlranks-aggregation-worker.service   # blocks until the run finishes
```

Watch it (in another shell, or after reconnecting):

```bash
journalctl -u brawlranks-aggregation-worker.service -f
sudo systemctl status brawlranks-aggregation-worker.service   # ExecMainStatus=0 on success
```

Prefer to run it detached without the unit? Equivalent one-off:

```bash
sudo systemd-run --unit=agg-canary --uid=brawlworker \
  --working-directory=/opt/brawlranks-worker \
  --property=EnvironmentFile=/etc/brawlranks-worker/aggregation.env \
  /usr/bin/npx tsx scripts/worker/aggregation-worker.ts --drive
journalctl -u agg-canary -f
```

Expected log tail ends with:
```json
{"worker":"aggregation","event":"completed","workflowRunId":"…","outcome":"succeeded",...}
{"worker":"aggregation","event":"exit","code":0,"status":"completed"}
```

## 5. Observe progress + workflow state (DB)

```sql
-- newest aggregation workflow run:
SELECT id, status, started_at, completed_at, error_summary
FROM workflow_runs
WHERE workflow_definition_id = (SELECT id FROM workflow_definitions WHERE slug='statistical-aggregation')
ORDER BY started_at DESC LIMIT 1;

-- its three scoped runs (all must be succeeded before ranking is eligible):
SELECT scope, status, brawlers_processed FROM aggregation_runs WHERE workflow_run_id = '<id>';

-- resume cursor / heartbeat (phase + last update):
SELECT step_name, status, completed_at, output_summary
FROM workflow_steps WHERE workflow_run_id='<id>' AND step_name='job_cursor';

-- no stuck lock after a run:
SELECT id, locked_by_run_id, locked_at, expires_at, released_at
FROM workflow_locks
WHERE workflow_definition_id=(SELECT id FROM workflow_definitions WHERE slug='statistical-aggregation')
ORDER BY locked_at DESC LIMIT 3;
```

A single manual slice (diagnostic, not the driver):

```bash
sudo -u brawlworker bash -lc 'set -a; . /etc/brawlranks-worker/aggregation.env; set +a; \
  cd /opt/brawlranks-worker && npx tsx scripts/worker/aggregation-worker.ts'
```

## 6. Resume steady state (ONLY when you decide to)

```bash
sudo systemctl enable --now brawlranks-aggregation-worker.timer   # every 8h (6–12h band)
systemctl list-timers brawlranks-aggregation-worker.timer
```

## 7. Rollback

```bash
# Stop and disable everything (safe: never edits workflow rows or deletes locks).
sudo systemctl disable --now brawlranks-aggregation-worker.timer 2>/dev/null || true
sudo systemctl stop brawlranks-aggregation-worker.service 2>/dev/null || true
sudo systemctl reset-failed brawlranks-aggregation-worker.service 2>/dev/null || true

# (optional) remove the units entirely:
sudo rm -f /etc/systemd/system/brawlranks-aggregation-worker.{service,timer}
sudo systemctl daemon-reload
```

Any run interrupted by the stop is reconciled automatically on the next
invocation (`reconcileStaleWorkflowRuns`, 15 min) — do **not** manually delete
locks or edit `workflow_runs`. Reverting the code change is `git revert 52e1a83`
plus this commit on the branch; the retired HTTP route and the worker are
additive/inert when unused.
