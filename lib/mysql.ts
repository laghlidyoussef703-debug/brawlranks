import { readFileSync } from "node:fs";
import mysql, { type Pool, type PoolOptions } from "mysql2/promise";

/**
 * Server-only Hostinger MySQL connection pool(s).
 * Never import this file from a Client Component or expose it via any
 * client-reachable code path — see BRAWLRANKS_WEBSITE_SPEC.md Section 24.7.
 *
 * BACKWARD COMPATIBILITY (DATASET Phase 9):
 *   `getPool()` remains the legacy singleton built from DB_HOST/DB_PORT/
 *   DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 with connectionLimit 2. Operational
 *   callers use getWritePool() and public snapshot callers use getReadPool();
 *   both role getters return this exact legacy singleton until their role
 *   variables are deliberately populated.
 *
 *   `getReadPool()` / `getWritePool()` are additive and role-aware. Each
 *   resolves from READ_DB_* / WRITE_DB_* respectively, and FALLS BACK to the
 *   legacy DB_* config when the role variables are not set. When a role is not
 *   configured, the role getter returns the SAME legacy singleton getPool()
 *   returns — so no extra pool and no extra connections are created until an
 *   operator deliberately populates the role variables. Behavior, connection
 *   count, and public contracts are identical until then.
 *
 * Secrets (BRAWL_DB_SECRET_V1, READ_DB_SECRET, WRITE_DB_SECRET) are read
 * verbatim and passed straight to mysql2. They are never trimmed, re-encoded,
 * hashed, concatenated, or logged. No error message in this file includes a
 * secret value — only variable NAMES.
 */

declare global {
  var __brawlranksMysqlPool: Pool | undefined;
  var __brawlranksReadPool: Pool | undefined;
  var __brawlranksWritePool: Pool | undefined;
}

export type DbRole = "read" | "write";

/**
 * TLS intent, resolved from env without touching the filesystem, so it can be
 * unit-tested. `caPath` is materialized (file read) only when a pool is built.
 */
export interface DbTlsIntent {
  caPath?: string;
  caInline?: string;
  rejectUnauthorized: boolean;
}

/**
 * A fully-resolved connection configuration. `source` records whether the
 * role-specific variables were used or the legacy DB_* fallback — useful for
 * diagnostics and never secret-bearing. `password` is present but must never
 * be logged.
 */
export interface ResolvedDbConfig {
  role: DbRole;
  source: "role" | "legacy";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
  tls: DbTlsIntent | null;
}

export interface SafeDbRoleDescription {
  role: DbRole;
  source: "role" | "legacy";
  host: string;
  port: number;
  database: string;
  user: string;
  connectionLimit: number;
  tlsEnabled: boolean;
  tlsVerified: boolean;
}

type Env = Record<string, string | undefined>;

/**
 * Parses a DB port. Falls back to 3306 only when genuinely unset — an
 * unparsable value fails fast instead of silently masking a misconfiguration.
 */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 3306;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`DB port is set but is not a valid port number: "${raw}"`);
  }
  return parsed;
}

function parsePoolSize(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`pool size is set but is not a positive integer: "${raw}"`);
  }
  return parsed;
}

/**
 * Resolves TLS intent for a role prefix. Enabled when a CA (path or inline) is
 * provided, or when `${prefix}SSL=true`. `rejectUnauthorized` defaults to true
 * and can only be turned off with an explicit `${prefix}SSL_REJECT_UNAUTHORIZED=false`
 * (discouraged; certificate verification protects against MITM).
 */
function resolveTls(prefix: string, env: Env): DbTlsIntent | null {
  const caPath = env[`${prefix}CA_PATH`];
  const caInline = env[`${prefix}CA`];
  const sslFlag = (env[`${prefix}SSL`] ?? "").toLowerCase() === "true";
  if (!caPath && !caInline && !sslFlag) return null;

  const rejectUnauthorized = (env[`${prefix}SSL_REJECT_UNAUTHORIZED`] ?? "true").toLowerCase() !== "false";
  return {
    ...(caPath ? { caPath } : {}),
    ...(caInline ? { caInline } : {}),
    rejectUnauthorized,
  };
}

const LEGACY_KEYS = "DB_HOST/DB_PORT/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1";

function resolveLegacyConfig(role: DbRole, env: Env): ResolvedDbConfig {
  const host = env.DB_HOST;
  const port = parsePort(env.DB_PORT);
  const database = env.DB_NAME;
  const user = env.DB_USER;
  const password = env.BRAWL_DB_SECRET_V1;

  if (!host || !database || !user || !password) {
    throw new Error(`MySQL connection is not configured (missing ${LEGACY_KEYS}).`);
  }

  return {
    role,
    source: "legacy",
    host,
    port,
    database,
    user,
    password,
    connectionLimit: 2,
    tls: null,
  };
}

/**
 * Resolves the connection config for a role. Pure (no filesystem, no network),
 * so it is fully unit-testable.
 *
 * A role is "active" when any of its own `${PREFIX}*` variables is set. When active, ALL of
 * HOST/NAME/USER/SECRET for that role must be present — a partial role config
 * fails fast rather than silently borrowing legacy values (which could point
 * writes at the wrong database). When the role is not active, the legacy DB_*
 * config is returned unchanged, so callers keep today's behavior.
 */
export function resolveRoleDbConfig(role: DbRole, env: Env = process.env): ResolvedDbConfig {
  const prefix = role === "read" ? "READ_DB_" : "WRITE_DB_";

  const host = env[`${prefix}HOST`];
  const roleKeys = ["HOST", "PORT", "NAME", "USER", "SECRET", "POOL_SIZE", "CA_PATH", "CA", "SSL", "SSL_REJECT_UNAUTHORIZED"];
  const roleIsPresent = roleKeys.some((key) => (env[`${prefix}${key}`] ?? "") !== "");
  if (!roleIsPresent) {
    // Role not configured — fall back to the legacy single-DB config.
    return resolveLegacyConfig(role, env);
  }

  const database = env[`${prefix}NAME`];
  const user = env[`${prefix}USER`];
  const password = env[`${prefix}SECRET`];
  const missing: string[] = [];
  if (!host) missing.push(`${prefix}HOST`);
  if (!database) missing.push(`${prefix}NAME`);
  if (!user) missing.push(`${prefix}USER`);
  if (!password) missing.push(`${prefix}SECRET`);
  if (missing.length > 0) {
    throw new Error(
      `The ${role} role is incompletely configured (missing ${missing.join(", ")}). ` +
        "A partial role configuration is refused so writes/reads cannot silently target the wrong database."
    );
  }

  return {
    role,
    source: "role",
    host: host!,
    port: parsePort(env[`${prefix}PORT`]),
    database: database!,
    user: user!,
    password: password!,
    connectionLimit: parsePoolSize(env[`${prefix}POOL_SIZE`], 2),
    tls: resolveTls(prefix, env),
  };
}

/** A credential-free description suitable for startup diagnostics and operator reports. */
export function describeDbRole(role: DbRole, env: Env = process.env): SafeDbRoleDescription {
  const config = resolveRoleDbConfig(role, env);
  return {
    role,
    source: config.source,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    connectionLimit: config.connectionLimit,
    tlsEnabled: config.tls !== null,
    tlsVerified: config.tls?.rejectUnauthorized ?? false,
  };
}

/** Pure diagnostic used by deployment checks: only two legacy fallbacks share one pool. */
export function rolesReuseLegacyPool(env: Env = process.env): boolean {
  return resolveRoleDbConfig("read", env).source === "legacy" && resolveRoleDbConfig("write", env).source === "legacy";
}

/** Materializes a mysql2 `ssl` option from TLS intent (reads a CA file here). */
function materializeSsl(tls: DbTlsIntent | null): PoolOptions["ssl"] | undefined {
  if (!tls) return undefined;
  const ca = tls.caInline ?? (tls.caPath ? readFileSync(tls.caPath, "utf8") : undefined);
  return {
    ...(ca ? { ca } : {}),
    rejectUnauthorized: tls.rejectUnauthorized,
  };
}

function buildPool(config: ResolvedDbConfig): Pool {
  const ssl = materializeSsl(config.tls);
  return mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    maxIdle: config.connectionLimit,
    idleTimeout: 60_000,
    queueLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: 10_000,
    charset: "utf8mb4",
    ...(ssl ? { ssl } : {}),
  });
}

/**
 * Legacy pool builder — UNCHANGED. Kept identical so getPool() behaves exactly
 * as before (connectionLimit 2, no TLS, legacy DB_* + BRAWL_DB_SECRET_V1).
 * There is no
 * fallback to DB_PASSWORD or any other variable.
 */
function createPool(): Pool {
  return buildPool(resolveLegacyConfig("write", process.env));
}

/**
 * One shared LEGACY pool per Node.js process (module-level singleton via
 * globalThis), reused across requests — never created per request, and never
 * via `createConnection`. This is the pool every existing caller uses.
 */
export function getPool(): Pool {
  if (!globalThis.__brawlranksMysqlPool) {
    globalThis.__brawlranksMysqlPool = createPool();
  }
  return globalThis.__brawlranksMysqlPool;
}

/**
 * Read-role pool. Returns a dedicated pool built from READ_DB_* when that role
 * is configured; otherwise returns the legacy getPool() so no extra pool or
 * connections are created. Intended for public snapshot reads once a separate
 * read endpoint exists (DATASET Phase 12) — no existing caller is switched now.
 */
export function getReadPool(): Pool {
  const config = resolveRoleDbConfig("read", process.env);
  if (config.source === "legacy") return getPool();
  if (!globalThis.__brawlranksReadPool) {
    globalThis.__brawlranksReadPool = buildPool(config);
  }
  return globalThis.__brawlranksReadPool;
}

/**
 * Write-role pool. Returns a dedicated pool built from WRITE_DB_* when that
 * role is configured; otherwise returns the legacy getPool(). Operational
 * writes/workflows call this now, but fallback makes that routing inert until
 * an operator deliberately configures a separate endpoint.
 */
export function getWritePool(): Pool {
  const config = resolveRoleDbConfig("write", process.env);
  if (config.source === "legacy") return getPool();
  if (!globalThis.__brawlranksWritePool) {
    globalThis.__brawlranksWritePool = buildPool(config);
  }
  return globalThis.__brawlranksWritePool;
}

export function getPoolForRole(role: DbRole): Pool {
  return role === "read" ? getReadPool() : getWritePool();
}

/** Connection-only role health check. It does not inspect or mutate application data. */
export async function checkDbRoleConnection(role: DbRole): Promise<SafeDbRoleDescription & { ok: true }> {
  const description = describeDbRole(role);
  const connection = await getPoolForRole(role).getConnection();
  try {
    await connection.query("SELECT 1");
    return { ...description, ok: true };
  } finally {
    connection.release();
  }
}

/**
 * Reports whether the legacy singleton pool already existed in this process
 * before `getPool()` would create it — used only for safe runtime
 * fingerprinting (Section 5 of the diagnostic endpoint), never for anything
 * security-sensitive.
 */
export function isPoolSingletonActive(): boolean {
  return globalThis.__brawlranksMysqlPool !== undefined;
}
