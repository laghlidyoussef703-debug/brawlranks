import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMigrationDbConfig } from "../scripts/migrate.mjs";

const legacy = { NODE_ENV: "test" as const, DB_HOST: "legacy", DB_NAME: "old", DB_USER: "app", BRAWL_DB_SECRET_V1: "legacy-secret" };

test("migration config: legacy DB_* remains the default fallback", () => {
  const cfg = resolveMigrationDbConfig(legacy);
  assert.equal(cfg.source, "legacy");
  assert.equal(cfg.host, "legacy");
  assert.equal(cfg.tls, null);
});

test("migration config: dedicated identity and verified CA take precedence", () => {
  const cfg = resolveMigrationDbConfig({ ...legacy, MIGRATION_DB_HOST: "managed-do",
    MIGRATION_DB_PORT: "25060", MIGRATION_DB_NAME: "brawlranks",
    MIGRATION_DB_USER: "migration_admin", MIGRATION_DB_SECRET: "migration-secret",
    MIGRATION_DB_CA_PATH: "/etc/brawlranks/ssl/ca-certificate.crt" });
  assert.equal(cfg.source, "migration");
  assert.equal(cfg.port, 25060);
  assert.deepEqual(cfg.tls, { caPath: "/etc/brawlranks/ssl/ca-certificate.crt", rejectUnauthorized: true });
});

test("migration config: partial dedicated config fails without secret disclosure", () => {
  const secret = "must-not-leak";
  assert.throws(() => resolveMigrationDbConfig({ NODE_ENV: "test", MIGRATION_DB_HOST: "managed-do", MIGRATION_DB_SECRET: secret }),
    (error: Error) => !error.message.includes(secret) && /MIGRATION_DB_NAME/.test(error.message));
});
