/**
 * Bounded-concurrency query execution for Hostinger's deliberately
 * constrained mysql2 pool (`lib/mysql.ts`: `connectionLimit: 2`,
 * `queueLimit: 10`). Any route that needs to run several independent
 * queries must never fire more of them concurrently than this pool can
 * actually hold — a `Promise.all` over more simultaneous `pool.query()`
 * calls than `connectionLimit + queueLimit` (12) makes mysql2 reject the
 * excess calls immediately with `Error: Queue limit reached`, which is
 * exactly the confirmed production failure in
 * `/api/internal/test/dataset-coverage` (16 concurrent queries against a
 * 12-slot pool).
 *
 * `connectionLimit`/`queueLimit` themselves are intentionally NOT raised
 * to work around this — Hostinger's plan constrains total MySQL
 * connections regardless of what this app requests, so the fix is on the
 * calling side: never launch more than a small, fixed number of queries
 * at once, regardless of how many total queries a route needs to run.
 */

/**
 * Deliberately small and well under `connectionLimit` (2) so a single
 * route's own query burst can never come close to exhausting the pool
 * even if another request is concurrently using the other connection at
 * the same moment — the whole point is safety margin, not maximum
 * throughput.
 */
export const DB_QUERY_CONCURRENCY = 2;

/**
 * Runs `tasks` with at most `concurrency` in flight at any moment,
 * preserving input order in the returned array regardless of completion
 * order (result[i] always corresponds to tasks[i]) — callers can
 * destructure the result array exactly as they would a `Promise.all`
 * result. A worker-pool pattern, not a fixed-size-batch pattern: as soon
 * as any one task finishes, the next pending task starts immediately,
 * rather than waiting for a whole batch to finish before starting the
 * next batch.
 */
export async function runQueriesBounded<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number = DB_QUERY_CONCURRENCY
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  if (tasks.length === 0) return results;

  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= tasks.length) return;
      results[current] = await tasks[current]();
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
