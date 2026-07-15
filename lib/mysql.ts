import mysql, { type Pool } from "mysql2/promise";

/**
 * Server-only Hostinger MySQL connection pool.
 * Never import this file from a Client Component or expose it via any
 * client-reachable code path — see BRAWLRANKS_WEBSITE_SPEC.md Section 24.7.
 *
 * This is the ONLY MySQL pool/connection definition in the project. Every
 * route that needs the database imports `getPool()` from this file — there
 * is no second pool, no `createConnection`, and no alternate config source.
 */

declare global {
  var __brawlranksMysqlPool: Pool | undefined;
}

/**
 * Parses DB_PORT safely. Falls back to 3306 only when the variable is
 * genuinely unset — an unparsable value (not a number) fails fast instead
 * of silently falling back, since a typo there should surface immediately
 * rather than mask a misconfiguration.
 */
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 3306;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`DB_PORT is set but is not a valid port number: "${raw}"`);
  }
  return parsed;
}

function createPool(): Pool {
  const host = process.env.DB_HOST;
  const port = parsePort(process.env.DB_PORT);
  const database = process.env.DB_NAME;
  const user = process.env.DB_USER;
  // MYSQL_PASSWORD_20260715 is read once, verbatim, and passed straight to
  // mysql2. It is never trimmed, re-encoded, quoted, concatenated, or
  // otherwise transformed — any such transformation would silently change
  // the credential the driver authenticates with. There is no fallback to
  // DB_PASSWORD, DB_PASSWORD_V2, or any other variable.
  const password = process.env.MYSQL_PASSWORD_20260715;

  if (!host || !database || !user || !password) {
    throw new Error(
      "MySQL connection is not configured (missing DB_HOST/DB_NAME/DB_USER/MYSQL_PASSWORD_20260715)."
    );
  }

  return mysql.createPool({
    host,
    port,
    database,
    user,
    password,
    waitForConnections: true,
    connectionLimit: 2,
    maxIdle: 2,
    idleTimeout: 60_000,
    queueLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: 10_000,
    charset: "utf8mb4",
  });
}

/**
 * One shared pool per Node.js process (module-level singleton via
 * globalThis), reused across requests — never created per request, and
 * never via `createConnection`.
 */
export function getPool(): Pool {
  if (!globalThis.__brawlranksMysqlPool) {
    globalThis.__brawlranksMysqlPool = createPool();
  }
  return globalThis.__brawlranksMysqlPool;
}

/**
 * Reports whether the singleton pool already existed in this process
 * before `getPool()` would create it — used only for safe runtime
 * fingerprinting (Section 5 of the diagnostic endpoint), never for
 * anything security-sensitive.
 */
export function isPoolSingletonActive(): boolean {
  return globalThis.__brawlranksMysqlPool !== undefined;
}
