import { after } from "node:test";

/**
 * Test-only teardown for DB integration suites.
 *
 * The application's mysql2 pool is a process-wide singleton on globalThis
 * (see lib/mysql.ts::getPool). It is created lazily on first getPool() and
 * kept open with idle keep-alive sockets. A suite that opens it but never
 * closes it leaves those sockets as active libuv handles, so `node --test`
 * (which does not force-exit) can never drain the event loop and the process
 * hangs after all assertions pass.
 *
 * This registers a single `after` hook that closes the shared pool and clears
 * the singleton. It is the exact, proven pattern already inlined in
 * tests/datasetArchiveDbIntegration.test.ts, extracted here so the six other
 * DB integration suites reuse one correct implementation instead of copies.
 *
 * Properties:
 *   - Idempotent / safe when the pool was never opened: when DB env is absent
 *     the suite's tests SKIP, getPool() is never called, and this hook returns
 *     early — it never fabricates a connection just to close it.
 *   - Clearing the globalThis singleton lets a LATER DB test file in the SAME
 *     process (a combined run) rebuild a fresh pool via getPool() rather than
 *     receive the already-ended one.
 *   - Uses no forced-exit flag and no process.exit(); it removes the open
 *     handle rather than hiding it.
 *   - Touches no runtime application code — lib/mysql is only imported inside
 *     the hook, and only when a pool could actually exist.
 */
export function closeSharedDbPoolAfterTests(): void {
  const hasDbEnv = Boolean(
    process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
  );
  after(async () => {
    if (!hasDbEnv) return;
    const { getPool } = await import("@/lib/mysql");
    await getPool().end().catch(() => {});
    (globalThis as Record<string, unknown>).__brawlranksMysqlPool = undefined;
  });
}
