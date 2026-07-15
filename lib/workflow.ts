/**
 * Reusable workflow_definitions / workflow_runs / workflow_steps /
 * workflow_locks helpers (BRAWLRANKS_WEBSITE_SPEC.md Section 25.2's
 * workflow tables; Section 26.4 for the MariaDB locking pattern).
 *
 * Every function takes an explicit connection (Pool or PoolConnection) so
 * callers control transaction boundaries — this module never opens its own
 * connection or transaction.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

type Queryable = Pool | PoolConnection;

const DEFAULT_LOCK_TTL_MS = 5 * 60_000;

export async function ensureWorkflowDefinition(
  db: Queryable,
  slug: string,
  workflowType: string
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO workflow_definitions (id, slug, workflow_type, is_enabled)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE workflow_type = VALUES(workflow_type)`,
    [id, slug, workflowType]
  );

  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id FROM workflow_definitions WHERE slug = ?",
    [slug]
  );
  return rows[0].id as string;
}

export interface AcquiredLock {
  acquired: boolean;
  lockId?: string;
}

/**
 * Attempts to acquire the single active lock slot for a workflow
 * definition. Any previously expired (but never released) lock is cleared
 * first, so a crashed run cannot permanently wedge future runs. Returns
 * { acquired: false } — never throws — when another run currently holds
 * the lock, so callers can fail the workflow run cleanly instead of
 * crashing.
 */
export async function acquireWorkflowLock(
  db: Queryable,
  workflowDefinitionId: string,
  runId: string,
  ttlMs: number = DEFAULT_LOCK_TTL_MS
): Promise<AcquiredLock> {
  await db.execute(
    `UPDATE workflow_locks
       SET released_at = NOW(3)
     WHERE workflow_definition_id = ?
       AND released_at IS NULL
       AND expires_at < NOW(3)`,
    [workflowDefinitionId]
  );

  const lockId = randomUUID();
  try {
    await db.execute(
      `INSERT INTO workflow_locks (id, workflow_definition_id, locked_by_run_id, expires_at)
       VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? MICROSECOND))`,
      [lockId, workflowDefinitionId, runId, ttlMs * 1000]
    );
    return { acquired: true, lockId };
  } catch (error) {
    if (isDuplicateEntryError(error)) {
      return { acquired: false };
    }
    throw error;
  }
}

export async function releaseWorkflowLock(
  db: Queryable,
  workflowDefinitionId: string,
  runId: string
): Promise<void> {
  await db.execute(
    `UPDATE workflow_locks
       SET released_at = NOW(3)
     WHERE workflow_definition_id = ?
       AND locked_by_run_id = ?
       AND released_at IS NULL`,
    [workflowDefinitionId, runId]
  );
}

function isDuplicateEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ER_DUP_ENTRY"
  );
}

export type TriggeredBy = "schedule" | "event" | "manual";
export type WorkflowRunStatus =
  | "running"
  | "succeeded"
  | "succeeded_with_warnings"
  | "held"
  | "failed"
  | "rolled_back";

export async function startWorkflowRun(
  db: Queryable,
  workflowDefinitionId: string,
  triggeredBy: TriggeredBy,
  triggeredByActor?: string
): Promise<string> {
  const id = randomUUID();
  await db.execute<ResultSetHeader>(
    `INSERT INTO workflow_runs
       (id, workflow_definition_id, status, triggered_by, triggered_by_actor, started_at)
     VALUES (?, ?, 'running', ?, ?, NOW(3))`,
    [id, workflowDefinitionId, triggeredBy, triggeredByActor ?? null]
  );
  return id;
}

export async function completeWorkflowRun(
  db: Queryable,
  runId: string,
  status: Exclude<WorkflowRunStatus, "running">,
  errorSummary?: string
): Promise<void> {
  await db.execute(
    `UPDATE workflow_runs
       SET status = ?, completed_at = NOW(3), error_summary = ?
     WHERE id = ?`,
    [status, errorSummary ?? null, runId]
  );
}

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export async function recordWorkflowStep(
  db: Queryable,
  workflowRunId: string,
  stepName: string,
  stepOrder: number,
  status: StepStatus,
  outputSummary?: unknown,
  errorDetail?: string
): Promise<void> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO workflow_steps
       (id, workflow_run_id, step_name, step_order, status, started_at, completed_at, output_summary, error_detail)
     VALUES (?, ?, ?, ?, ?, NOW(3), NOW(3), ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       completed_at = VALUES(completed_at),
       output_summary = VALUES(output_summary),
       error_detail = VALUES(error_detail)`,
    [
      id,
      workflowRunId,
      stepName,
      stepOrder,
      status,
      outputSummary !== undefined ? JSON.stringify(outputSummary) : null,
      errorDetail ?? null,
    ]
  );
}
