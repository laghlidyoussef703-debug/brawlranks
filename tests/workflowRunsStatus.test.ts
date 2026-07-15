/**
 * Regression coverage for the migration 0016 fix: workflow_runs.status
 * must actually be able to store 'succeeded_with_warnings' (23 chars),
 * which its own CHECK constraint has always allowed but the original
 * VARCHAR(20) column could not.
 *
 * Requires real MySQL/MariaDB credentials — same pattern as every other
 * *DbIntegration.test.ts file in this suite: SKIP (not a fabricated pass)
 * when DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 are unset locally.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

test(
  "db: a workflow_runs row can be INSERTed and UPDATEd to status = 'succeeded_with_warnings'",
  { skip: skip ? skipReason : false },
  async () => {
    const { getPool } = await import("@/lib/mysql");
    const { randomUUID } = await import("node:crypto");
    const pool = getPool();

    const definitionId = randomUUID();
    await pool.execute(
      `INSERT INTO workflow_definitions (id, slug, workflow_type)
       VALUES (?, ?, 'scheduled_sync')`,
      [definitionId, `test-workflow-runs-status-${definitionId}`]
    );

    const runId = randomUUID();
    await pool.execute(
      `INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at)
       VALUES (?, ?, 'succeeded_with_warnings', 'manual', NOW(3))`,
      [runId, definitionId]
    );

    const [[insertedRow]] = await pool.query<import("mysql2").RowDataPacket[]>(
      "SELECT status FROM workflow_runs WHERE id = ?",
      [runId]
    );
    assert.equal(insertedRow.status, "succeeded_with_warnings");

    // Also confirm the UPDATE path (a run that starts 'running' and is
    // later marked 'succeeded_with_warnings', the real-world lifecycle
    // this bug was actually hit through).
    const secondRunId = randomUUID();
    await pool.execute(
      `INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at)
       VALUES (?, ?, 'running', 'manual', NOW(3))`,
      [secondRunId, definitionId]
    );
    await pool.execute("UPDATE workflow_runs SET status = 'succeeded_with_warnings' WHERE id = ?", [secondRunId]);

    const [[updatedRow]] = await pool.query<import("mysql2").RowDataPacket[]>(
      "SELECT status FROM workflow_runs WHERE id = ?",
      [secondRunId]
    );
    assert.equal(updatedRow.status, "succeeded_with_warnings");
  }
);
