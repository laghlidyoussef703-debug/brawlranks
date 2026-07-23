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
      `INSERT INTO workflow_locks (id, workflow_definition_id, locked_by_run_id, locked_at, expires_at)
       VALUES (?, ?, ?, UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MICROSECOND))`,
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

// ---------------------------------------------------------------------------
// Resumable job-cursor + stale-run recovery (Phase 5 durable batched cron)
// ---------------------------------------------------------------------------
//
// A long-running aggregation/ranking job now spans MANY short HTTP calls
// (each does one bounded slice well under the ~60s Hostinger request limit),
// keeping its workflow_runs row in 'running' for the whole job. The job's
// resume cursor is persisted as JSON in a single workflow_steps row
// (step_order 0, step_name 'job_cursor') — no new table is introduced; the
// existing workflow tables carry all durable state. Each slice rewrites the
// cursor, which also advances that row's completed_at and so doubles as a
// liveness heartbeat: reconcileStaleWorkflowRuns uses it to distinguish a
// genuinely-resuming job (fresh heartbeat) from an abandoned one (a process
// that died mid-slice, leaving a 'running' row no future call would resume).

const JOB_CURSOR_STEP_NAME = "job_cursor";
const JOB_CURSOR_STEP_ORDER = 0;

export interface InProgressRun {
  id: string;
  startedAt: Date;
}

/**
 * The newest still-'running' workflow_run for a definition — the job a
 * resuming call should continue. Returns null when no job is in flight, in
 * which case the caller starts a fresh one. Call this only while holding the
 * workflow lock, so the fresh-vs-resume decision cannot race a concurrent
 * call.
 */
export async function findLatestRunningRun(
  db: Queryable,
  workflowDefinitionId: string
): Promise<InProgressRun | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, started_at
       FROM workflow_runs
      WHERE workflow_definition_id = ? AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1`,
    [workflowDefinitionId]
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id as string, startedAt: rows[0].started_at as Date };
}

/** Persists (upserts) a job's resume cursor as JSON in its dedicated workflow_steps row. Also advances that row's completed_at (the liveness heartbeat). */
export async function writeJobCursor(db: Queryable, workflowRunId: string, cursor: unknown): Promise<void> {
  await recordWorkflowStep(db, workflowRunId, JOB_CURSOR_STEP_NAME, JOB_CURSOR_STEP_ORDER, "running", cursor);
}

/** Reads a job's resume cursor, or null if none has been written yet (a run interrupted before its first slice). */
export async function readJobCursor<T>(db: Queryable, workflowRunId: string): Promise<T | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT output_summary FROM workflow_steps WHERE workflow_run_id = ? AND step_order = ?`,
    [workflowRunId, JOB_CURSOR_STEP_ORDER]
  );
  const raw = rows[0]?.output_summary;
  if (raw === undefined || raw === null) return null;
  return JSON.parse(raw as string) as T;
}

export interface StaleReclaimResult {
  reclaimedRunIds: string[];
}

/**
 * Marks abandoned in-flight jobs failed so a fresh job can start. A run is
 * "stale" when it is still 'running' but its heartbeat — the later of its
 * started_at and its cursor row's last update — is older than
 * `staleAfterSeconds`. A live resuming job rewrites its cursor every slice
 * (i.e. every scheduled call, minutes apart), so its heartbeat stays fresh
 * and it is never reclaimed; only a job whose process died mid-run goes
 * stale. Reclaimed runs' locks are left to expire via their own TTL (they
 * are short-lived, per-slice locks), and any partially-written append-only
 * aggregate/candidate rows remain harmlessly invisible — nothing reads rows
 * scoped to a non-succeeded run.
 */
export async function reconcileStaleWorkflowRuns(
  db: Queryable,
  workflowDefinitionId: string,
  staleAfterSeconds: number
): Promise<StaleReclaimResult> {
  const [staleRows] = await db.query<RowDataPacket[]>(
    `SELECT wr.id AS id
       FROM workflow_runs wr
      WHERE wr.workflow_definition_id = ?
        AND wr.status = 'running'
        AND COALESCE(
              (SELECT MAX(ws.completed_at) FROM workflow_steps ws WHERE ws.workflow_run_id = wr.id),
              wr.started_at
            ) < (NOW(3) - INTERVAL ? SECOND)`,
    [workflowDefinitionId, staleAfterSeconds]
  );
  const reclaimedRunIds = staleRows.map((r) => r.id as string);
  for (const runId of reclaimedRunIds) {
    await db.execute(
      `UPDATE workflow_runs
          SET status = 'failed', completed_at = NOW(3), error_summary = 'stale_reclaimed'
        WHERE id = ? AND status = 'running'`,
      [runId]
    );
  }
  return { reclaimedRunIds };
}
