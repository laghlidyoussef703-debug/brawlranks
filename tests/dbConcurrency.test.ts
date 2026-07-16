/**
 * Bounded-concurrency query execution (production fix: dataset-coverage
 * returned HTTP 500 with "Queue limit reached" because it fired 16
 * concurrent pool.query() calls against Hostinger's constrained mysql2
 * pool, connectionLimit: 2 / queueLimit: 10 — see lib/dbConcurrency.ts and
 * lib/mysql.ts). Pure/DB-free — no skip needed; the "constrained pool"
 * regression tests below use a fake pool that faithfully models mysql2's
 * own acquire/queue/reject semantics, not a real database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runQueriesBounded, DB_QUERY_CONCURRENCY } from "@/lib/dbConcurrency";
import { buildDatasetCoverageReport } from "@/app/api/internal/test/dataset-coverage/route";
import { buildIngestionHealthReport } from "@/app/api/internal/test/ingestion-health/route";

// ---------------------------------------------------------------------------
// runQueriesBounded — concurrency-cap proof
// ---------------------------------------------------------------------------

function trackedTask(activeCounter: { active: number; max: number }, delayMs: number, result: number) {
  return async () => {
    activeCounter.active += 1;
    activeCounter.max = Math.max(activeCounter.max, activeCounter.active);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    activeCounter.active -= 1;
    return result;
  };
}

test("runQueriesBounded never runs more than the configured concurrency at once", async () => {
  const counter = { active: 0, max: 0 };
  const tasks = Array.from({ length: 20 }, (_, i) => trackedTask(counter, 5, i));

  await runQueriesBounded(tasks, 2);

  assert.ok(counter.max <= 2, `observed max concurrency ${counter.max}, expected <= 2`);
});

test("runQueriesBounded with the default DB_QUERY_CONCURRENCY never exceeds it", async () => {
  const counter = { active: 0, max: 0 };
  const tasks = Array.from({ length: 16 }, (_, i) => trackedTask(counter, 5, i));

  await runQueriesBounded(tasks);

  assert.ok(counter.max <= DB_QUERY_CONCURRENCY, `observed max concurrency ${counter.max}, expected <= ${DB_QUERY_CONCURRENCY}`);
});

test("runQueriesBounded preserves input order in the result array regardless of completion order", async () => {
  const counter = { active: 0, max: 0 };
  // Earlier tasks take longer than later ones, so completion order is reversed relative to input order.
  const tasks = [
    trackedTask(counter, 30, 100),
    trackedTask(counter, 20, 200),
    trackedTask(counter, 10, 300),
    trackedTask(counter, 1, 400),
  ];

  const results = await runQueriesBounded(tasks, 4);
  assert.deepEqual(results, [100, 200, 300, 400]);
});

test("runQueriesBounded returns an empty array for an empty task list without throwing", async () => {
  const results = await runQueriesBounded([], 2);
  assert.deepEqual(results, []);
});

test("runQueriesBounded with a single task and concurrency > 1 still runs it exactly once", async () => {
  let callCount = 0;
  const results = await runQueriesBounded(
    [
      async () => {
        callCount += 1;
        return "done";
      },
    ],
    5
  );
  assert.equal(callCount, 1);
  assert.deepEqual(results, ["done"]);
});

test("runQueriesBounded processes more tasks than the concurrency cap without dropping any", async () => {
  const counter = { active: 0, max: 0 };
  const tasks = Array.from({ length: 37 }, (_, i) => trackedTask(counter, 1, i));
  const results = await runQueriesBounded(tasks, 3);
  assert.equal(results.length, 37);
  assert.deepEqual(results, Array.from({ length: 37 }, (_, i) => i));
  assert.ok(counter.max <= 3);
});

// ---------------------------------------------------------------------------
// Regression: a fake pool that faithfully models mysql2's real
// connectionLimit/queueLimit/"Queue limit reached" behavior, configured to
// match production's actual lib/mysql.ts settings (connectionLimit: 2,
// queueLimit: 10 — 12 total slots). Before the fix, dataset-coverage's
// 16-way Promise.all and ingestion-health's 12-way Promise.all would push
// this fake pool past capacity exactly like the real one did in production.
// ---------------------------------------------------------------------------

interface ConstrainedPoolStats {
  maxConcurrentInFlight: number;
  queueLimitErrors: number;
}

function createConstrainedFakePool(connectionLimit: number, queueLimit: number) {
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  const stats: ConstrainedPoolStats = { maxConcurrentInFlight: 0, queueLimitErrors: 0 };

  function acquire(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (inFlight < connectionLimit) {
        inFlight += 1;
        stats.maxConcurrentInFlight = Math.max(stats.maxConcurrentInFlight, inFlight);
        resolve();
        return;
      }
      if (waiters.length < queueLimit) {
        waiters.push(() => {
          inFlight += 1;
          stats.maxConcurrentInFlight = Math.max(stats.maxConcurrentInFlight, inFlight);
          resolve();
        });
        return;
      }
      stats.queueLimitErrors += 1;
      reject(new Error("Queue limit reached"));
    });
  }

  function release(): void {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  async function query(_sql: string, _params?: unknown[]): Promise<[unknown[], unknown[]]> {
    await acquire();
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [[], []];
    } finally {
      release();
    }
  }

  return { query, stats };
}

test("regression: a Promise.all burst of 16 concurrent queries against the real production pool shape (connectionLimit=2, queueLimit=10) fails with 'Queue limit reached' — reproduces the confirmed production bug", async () => {
  const fakePool = createConstrainedFakePool(2, 10);
  const tasks = Array.from({ length: 16 }, () => fakePool.query("SELECT 1"));

  await assert.rejects(Promise.all(tasks), /Queue limit reached/);
  assert.ok(fakePool.stats.queueLimitErrors > 0);
});

test("regression: buildDatasetCoverageReport no longer fails against the constrained production pool shape", async () => {
  const fakePool = createConstrainedFakePool(2, 10);
  const report = await buildDatasetCoverageReport(fakePool as never);

  assert.equal(report.ok, true);
  assert.equal(fakePool.stats.queueLimitErrors, 0, "must never trigger a Queue limit reached error");
  assert.ok(
    fakePool.stats.maxConcurrentInFlight <= DB_QUERY_CONCURRENCY,
    `observed max concurrent connections ${fakePool.stats.maxConcurrentInFlight}, expected <= ${DB_QUERY_CONCURRENCY}`
  );
});

test("regression: buildIngestionHealthReport no longer fails against the constrained production pool shape", async () => {
  const fakePool = createConstrainedFakePool(2, 10);
  const report = await buildIngestionHealthReport(fakePool as never);

  assert.equal(report.ok, true);
  assert.equal(fakePool.stats.queueLimitErrors, 0, "must never trigger a Queue limit reached error");
  assert.ok(
    fakePool.stats.maxConcurrentInFlight <= DB_QUERY_CONCURRENCY,
    `observed max concurrent connections ${fakePool.stats.maxConcurrentInFlight}, expected <= ${DB_QUERY_CONCURRENCY}`
  );
});
