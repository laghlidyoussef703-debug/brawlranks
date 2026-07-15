/**
 * Rate-limit budget enforcement (BRAWLRANKS_WEBSITE_SPEC.md Section 7.23).
 *
 * Backed by the `ingestion_rate_budgets` table (migration 0015) — one row
 * per named scope, combining the configured ceiling with a live counter.
 * Consumption is a single atomic conditional UPDATE (no SELECT ... FOR
 * UPDATE needed — MySQL/MariaDB's row-level UPDATE is itself atomic), so
 * concurrent callers can never both succeed past the ceiling.
 *
 * The numeric defaults seeded by scripts/seed-ingestion-budgets.mjs are
 * CONSERVATIVE, CONFIGURED VALUES — not a verified measurement of the
 * official API's real rate limit (no live proxy access this session, see
 * PHASE3.md "Known limitations"). They exist so the ingestion pipeline has
 * a safe, non-zero, non-invented-as-fact starting point, and are meant to
 * be tightened or loosened once real usage against the live proxy is
 * observed and measured.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

type Queryable = Pool | PoolConnection;

export type BudgetScope = "global_daily" | "catalog" | "rankings" | "player_profile" | "battle_log" | "club";

export interface BudgetState {
  scope: BudgetScope;
  requestCeiling: number;
  reservedForPriority: number;
  requestsUsed: number;
  windowStartedAt: Date;
  windowSeconds: number;
}

async function getBudgetRow(db: Queryable, scope: BudgetScope): Promise<(BudgetState & { id: string }) | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, budget_scope, request_ceiling, reserved_for_priority, requests_used, window_started_at, window_seconds
       FROM ingestion_rate_budgets
      WHERE budget_scope = ?`,
    [scope]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    scope: row.budget_scope,
    requestCeiling: row.request_ceiling,
    reservedForPriority: row.reserved_for_priority,
    requestsUsed: row.requests_used,
    windowStartedAt: row.window_started_at,
    windowSeconds: row.window_seconds,
  };
}

/** Resets requests_used to 0 and window_started_at to now if the current window has elapsed. Idempotent. */
async function resetWindowIfExpired(db: Queryable, scope: BudgetScope, state: BudgetState): Promise<void> {
  const windowEndsAt = state.windowStartedAt.getTime() + state.windowSeconds * 1000;
  if (Date.now() < windowEndsAt) return;

  await db.execute(
    `UPDATE ingestion_rate_budgets
        SET requests_used = 0, window_started_at = NOW(3)
      WHERE budget_scope = ? AND window_started_at = ?`,
    [scope, state.windowStartedAt]
  );
}

export interface ConsumeResult {
  allowed: boolean;
  reason?: "not_configured" | "exhausted";
}

/**
 * Attempts to consume one request slot from the named budget. `priority`
 * callers (catalog sync, health checks — Section 7.23's "emergency
 * reserve") may consume up to the full request_ceiling; non-priority
 * callers are capped at (request_ceiling - reserved_for_priority).
 */
export async function tryConsumeBudget(
  db: Queryable,
  scope: BudgetScope,
  priority: boolean = false
): Promise<ConsumeResult> {
  const state = await getBudgetRow(db, scope);
  if (!state) return { allowed: false, reason: "not_configured" };

  await resetWindowIfExpired(db, scope, state);

  const effectiveCeiling = priority ? state.requestCeiling : state.requestCeiling - state.reservedForPriority;

  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE ingestion_rate_budgets
        SET requests_used = requests_used + 1
      WHERE budget_scope = ? AND requests_used < ?`,
    [scope, effectiveCeiling]
  );

  return result.affectedRows > 0 ? { allowed: true } : { allowed: false, reason: "exhausted" };
}

export async function recordRateLimitResponse(db: Queryable, scope: BudgetScope): Promise<void> {
  await db.execute(`UPDATE ingestion_rate_budgets SET last_429_at = NOW(3) WHERE budget_scope = ?`, [scope]);
}

export async function getBudgetState(db: Queryable, scope: BudgetScope): Promise<BudgetState | null> {
  return getBudgetRow(db, scope);
}

export async function ensureBudgetSeed(
  db: Queryable,
  scope: BudgetScope,
  requestCeiling: number,
  windowSeconds: number,
  reservedForPriority: number = 0
): Promise<void> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO ingestion_rate_budgets (id, budget_scope, window_seconds, request_ceiling, reserved_for_priority)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       window_seconds = VALUES(window_seconds),
       request_ceiling = VALUES(request_ceiling),
       reserved_for_priority = VALUES(reserved_for_priority)`,
    [id, scope, windowSeconds, requestCeiling, reservedForPriority]
  );
}
