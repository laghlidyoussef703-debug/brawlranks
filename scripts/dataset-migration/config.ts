import { readFileSync } from "node:fs";
import mysql, { type Pool, type PoolOptions } from "mysql2/promise";

type Env = Record<string, string | undefined>;

export interface EndpointConfig {
  role: "source" | "target";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
  ssl: NonNullable<PoolOptions["ssl"]>;
}

function integer(raw: string | undefined, fallback: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) throw new Error(`${label} must be a positive integer <= ${maximum}`);
  return value;
}

export function redactSecrets(value: string, env: Env = process.env): string {
  let redacted = value;
  for (const [name, secret] of Object.entries(env)) {
    if (!secret || !/(SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL)/i.test(name)) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(/(mysql(?:\+\w+)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}

export function resolveEndpoint(role: "source" | "target", env: Env = process.env): EndpointConfig {
  const prefix = role === "source" ? "SOURCE_DB_" : "TARGET_DB_";
  const required = ["HOST", "NAME", "USER", "SECRET"] as const;
  const missing = required.filter((key) => !env[`${prefix}${key}`]);
  if (missing.length > 0) throw new Error(`${role} database configuration is incomplete (missing ${missing.map((key) => `${prefix}${key}`).join(", ")})`);

  const caPath = env[`${prefix}CA_PATH`];
  const caInline = env[`${prefix}CA`];
  const sslEnabled = (env[`${prefix}SSL`] ?? "").toLowerCase() === "true" || Boolean(caPath || caInline);
  if (!sslEnabled) throw new Error(`${prefix}SSL=true or a ${prefix}CA_PATH/${prefix}CA is required; migration connections must use TLS`);
  const rejectUnauthorized = (env[`${prefix}SSL_REJECT_UNAUTHORIZED`] ?? "true").toLowerCase() !== "false";
  if (!rejectUnauthorized) throw new Error(`${prefix}SSL_REJECT_UNAUTHORIZED=false is refused for migration synchronization`);
  const ca = caInline ?? (caPath ? readFileSync(caPath, "utf8") : undefined);

  return {
    role,
    host: env[`${prefix}HOST`]!,
    port: integer(env[`${prefix}PORT`], 3306, `${prefix}PORT`, 65535),
    database: env[`${prefix}NAME`]!,
    user: env[`${prefix}USER`]!,
    password: env[`${prefix}SECRET`]!,
    connectionLimit: integer(env[`${prefix}POOL_SIZE`], 2, `${prefix}POOL_SIZE`, 8),
    ssl: { ...(ca ? { ca } : {}), rejectUnauthorized: true },
  };
}

export function safeIdentity(config: EndpointConfig): string {
  return `${config.host.toLowerCase()}:${config.port}/${config.database}@${config.user}`;
}

export function assertDifferentDatabases(source: EndpointConfig, target: EndpointConfig): void {
  if (source.host.toLowerCase() === target.host.toLowerCase() && source.port === target.port && source.database.toLowerCase() === target.database.toLowerCase()) {
    throw new Error("Source and target resolve to the same host, port, and database; refusing possible source/target reversal");
  }
}

export function createEndpointPool(config: EndpointConfig): Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    maxIdle: config.connectionLimit,
    queueLimit: 4,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    charset: "utf8mb4",
    timezone: "Z",
    decimalNumbers: false,
    dateStrings: true,
    multipleStatements: false,
  });
}

export function inspectConfig(env: Env = process.env): Record<string, unknown> {
  const source = resolveEndpoint("source", env);
  const target = resolveEndpoint("target", env);
  assertDifferentDatabases(source, target);
  return {
    source: { identity: safeIdentity(source), tls: true, verified: true, connectionLimit: source.connectionLimit },
    target: { identity: safeIdentity(target), tls: true, verified: true, connectionLimit: target.connectionLimit },
    sameDatabase: false,
    warnings: ["Source grant scope is checked by test-source. A SELECT-only source identity is recommended for least privilege but is not a DATASET.md Phase 8 completion condition; migration source SQL is runtime-restricted to SELECT and SHOW."],
  };
}
