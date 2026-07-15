import mysql, { type Pool } from "mysql2/promise";

/**
 * Server-only Hostinger MySQL connection pool.
 * Never import this file from a Client Component or expose it via any
 * client-reachable code path — see BRAWLRANKS_WEBSITE_SPEC.md Section 24.7.
 */

declare global {
  var __brawlranksMysqlPool: Pool | undefined;
}

function createPool(): Pool {
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306;
  const database = process.env.DB_NAME;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;

  if (!host || !database || !user || !password) {
    throw new Error(
      "MySQL connection is not configured (missing DB_HOST/DB_NAME/DB_USER/DB_PASSWORD)."
    );
  }

  return mysql.createPool({
    host,
    port,
    database,
    user,
    password,
    waitForConnections: true,
    connectionLimit: 5,
    maxIdle: 5,
    idleTimeout: 60_000,
    queueLimit: 0,
    dateStrings: false,
  });
}

/**
 * One shared pool per runtime process (module-level singleton), reused
 * across requests rather than re-created per request.
 */
export function getPool(): Pool {
  if (!global.__brawlranksMysqlPool) {
    global.__brawlranksMysqlPool = createPool();
  }
  return global.__brawlranksMysqlPool;
}
