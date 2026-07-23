/**
 * Regression tests for acquireWorkflowLock (lib/workflow.ts).
 *
 * Guards the Phase 10 production failure on DigitalOcean MySQL 8.4:
 *   "Field 'locked_at' doesn't have a default value"
 * workflow_locks.locked_at is DATETIME(3) NOT NULL with no default (migration
 * 0002), so under MySQL 8.4 strict mode every acquire INSERT must write
 * locked_at explicitly. MariaDB tolerated its omission; MySQL 8.4 does not.
 *
 * These require a reachable, migrated database (DB_HOST/DB_NAME/DB_USER/
 * BRAWL_DB_SECRET_V1) — they SKIP when unset, like every other *DbIntegration
 * test. The shared helper is exercised, so the coverage applies to ALL
 * workflows (player-discovery, ranking, aggregation, catalog, retention, club,
 * battle-log, ranking-seed) that call acquireWorkflowLock.
 */
import { test } from "node:test";
import { closeSharedDbPoolAfterTests } from "./helpers/closeDbPool";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

closeSharedDbPoolAfterTests();

async function activeLock(pool: Pool, defId: string): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, locked_by_run_id, locked_at, expires_at, released_at FROM workflow_locks WHERE workflow_definition_id = ? AND released_at IS NULL",
    [defId]
  );
  assert.ok(rows.length <= 1, "the unique active_flag slot must permit at most one active lock");
  return rows[0];
}

async function cleanup(pool: Pool, defId: string): Promise<void> {
  await pool.execute("DELETE FROM workflow_locks WHERE workflow_definition_id = ?", [defId]).catch(() => {});
  await pool.execute("DELETE FROM workflow_definitions WHERE id = ?", [defId]).catch(() => {});
}

test("db: a freshly acquired workflow lock persists a non-null locked_at (the Phase 10 8.4 fix)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { ensureWorkflowDefinition, acquireWorkflowLock } = await import("@/lib/workflow");
  const pool = getPool();
  const defId = await ensureWorkflowDefinition(pool, `lock-test-fresh-${randomUUID()}`, "scheduled_sync");
  try {
    const runId = randomUUID();
    const lock = await acquireWorkflowLock(pool, defId, runId);
    assert.equal(lock.acquired, true, "a fresh lock must be acquired (this INSERT is what failed on 8.4)");

    const row = await activeLock(pool, defId);
    assert.ok(row, "the active lock row must exist");
    assert.ok(row!.locked_at != null, "locked_at must be populated, not NULL/absent");
    assert.equal(row!.locked_by_run_id, runId, "locked_by_run_id linkage preserved");
    // locked_at is a real recent timestamp strictly before expiry.
    assert.ok(new Date(String(row!.locked_at)).getTime() > 0, "locked_at must be a real datetime");
    assert.ok(new Date(String(row!.expires_at)).getTime() > new Date(String(row!.locked_at)).getTime(), "expires_at must be after locked_at (expiry preserved)");
  } finally {
    await cleanup(pool, defId);
  }
});

test("db: acquiring over an EXPIRED lock takes it over and writes a fresh locked_at", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { ensureWorkflowDefinition, acquireWorkflowLock } = await import("@/lib/workflow");
  const pool = getPool();
  const defId = await ensureWorkflowDefinition(pool, `lock-test-expired-${randomUUID()}`, "scheduled_sync");
  try {
    const staleRunId = randomUUID();
    // Seed an EXPIRED, never-released active lock (locked_at 10m ago, expired 5m ago).
    await pool.execute(
      `INSERT INTO workflow_locks (id, workflow_definition_id, locked_by_run_id, locked_at, expires_at)
       VALUES (?, ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE), DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))`,
      [randomUUID(), defId, staleRunId]
    );

    const freshRunId = randomUUID();
    const lock = await acquireWorkflowLock(pool, defId, freshRunId);
    assert.equal(lock.acquired, true, "an expired lock must be reclaimable (takeover preserved)");

    const row = await activeLock(pool, defId);
    assert.ok(row, "there must be exactly one active lock after takeover");
    assert.equal(row!.locked_by_run_id, freshRunId, "the new run owns the lock");
    assert.notEqual(row!.locked_by_run_id, staleRunId, "the stale run no longer owns the active lock");
    // Fresh locked_at, not the 10-minute-old stale one — checked in SERVER time
    // (via SQL) so a host/container clock skew cannot make this flaky.
    assert.ok(row!.locked_at != null, "locked_at must be populated after takeover");
    const [[freshCheck]] = await pool.query<RowDataPacket[]>(
      "SELECT (locked_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE)) AS is_fresh FROM workflow_locks WHERE workflow_definition_id = ? AND released_at IS NULL",
      [defId]
    );
    assert.equal(Number(freshCheck.is_fresh), 1, "locked_at must be freshly written (within the last minute of server time), not the 10-min-old stale value");
  } finally {
    await cleanup(pool, defId);
  }
});

test("db: an ACTIVE (unexpired) lock cannot be stolen — the second acquire returns not-acquired", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { ensureWorkflowDefinition, acquireWorkflowLock } = await import("@/lib/workflow");
  const pool = getPool();
  const defId = await ensureWorkflowDefinition(pool, `lock-test-active-${randomUUID()}`, "scheduled_sync");
  try {
    const runA = randomUUID();
    const runB = randomUUID();
    const first = await acquireWorkflowLock(pool, defId, runA);
    assert.equal(first.acquired, true);

    const second = await acquireWorkflowLock(pool, defId, runB);
    assert.equal(second.acquired, false, "a live lock must not be stolen (idempotent ER_DUP_ENTRY -> acquired:false)");

    const row = await activeLock(pool, defId);
    assert.equal(row!.locked_by_run_id, runA, "the original holder still owns the lock");
  } finally {
    await cleanup(pool, defId);
  }
});
