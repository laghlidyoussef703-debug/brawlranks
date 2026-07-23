/**
 * DATASET Phase 3 (WP-C) — role-aware DB configuration.
 *
 * Pure unit tests of the config resolver in lib/mysql.ts: they never open a
 * connection. They prove the role/legacy fallback, read/write selection, TLS
 * intent, pool-size handling, and that no secret value can appear in an error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRoleDbConfig, parsePort } from "../lib/mysql";

const SECRET = "s3cr3t-do-not-leak-XYZ";

const legacyEnv = () => ({
  DB_HOST: "legacy.example",
  DB_PORT: "3306",
  DB_NAME: "brawl_legacy",
  DB_USER: "legacy_user",
  BRAWL_DB_SECRET_V1: SECRET,
});

test("roles: with no role vars, both roles fall back to the legacy DB_* config", () => {
  const env = legacyEnv();
  for (const role of ["read", "write"] as const) {
    const cfg = resolveRoleDbConfig(role, env);
    assert.equal(cfg.source, "legacy");
    assert.equal(cfg.host, "legacy.example");
    assert.equal(cfg.database, "brawl_legacy");
    assert.equal(cfg.user, "legacy_user");
    assert.equal(cfg.password, SECRET);
    assert.equal(cfg.connectionLimit, 2, "legacy pool limit unchanged");
    assert.equal(cfg.tls, null, "legacy path has no TLS");
  }
});

test("roles: READ_DB_* selects the read role while write stays legacy", () => {
  const env = {
    ...legacyEnv(),
    READ_DB_HOST: "reader.do",
    READ_DB_PORT: "25060",
    READ_DB_NAME: "brawl_ro",
    READ_DB_USER: "app_read",
    READ_DB_SECRET: "read-secret",
  };
  const read = resolveRoleDbConfig("read", env);
  assert.equal(read.source, "role");
  assert.equal(read.host, "reader.do");
  assert.equal(read.port, 25060);
  assert.equal(read.user, "app_read");
  assert.equal(read.password, "read-secret");

  const write = resolveRoleDbConfig("write", env);
  assert.equal(write.source, "legacy", "write role untouched when only READ_DB_* is set");
  assert.equal(write.host, "legacy.example");
});

test("roles: WRITE_DB_* selects the write role while read stays legacy", () => {
  const env = {
    ...legacyEnv(),
    WRITE_DB_HOST: "writer.do",
    WRITE_DB_NAME: "brawl_rw",
    WRITE_DB_USER: "ingest_write",
    WRITE_DB_SECRET: "write-secret",
  };
  const write = resolveRoleDbConfig("write", env);
  assert.equal(write.source, "role");
  assert.equal(write.host, "writer.do");
  assert.equal(write.port, 3306, "defaults to 3306 when WRITE_DB_PORT unset");
  assert.equal(write.user, "ingest_write");

  assert.equal(resolveRoleDbConfig("read", env).source, "legacy");
});

test("roles: read and write can point at independent endpoints simultaneously", () => {
  const env = {
    ...legacyEnv(),
    READ_DB_HOST: "reader.do",
    READ_DB_NAME: "ro",
    READ_DB_USER: "app_read",
    READ_DB_SECRET: "r",
    WRITE_DB_HOST: "writer.do",
    WRITE_DB_NAME: "rw",
    WRITE_DB_USER: "ingest_write",
    WRITE_DB_SECRET: "w",
  };
  assert.equal(resolveRoleDbConfig("read", env).host, "reader.do");
  assert.equal(resolveRoleDbConfig("write", env).host, "writer.do");
});

test("roles: a partial role config is refused, and the error never leaks the secret", () => {
  const env = {
    ...legacyEnv(),
    WRITE_DB_HOST: "writer.do",
    WRITE_DB_SECRET: SECRET, // present, but NAME and USER are missing
  };
  assert.throws(
    () => resolveRoleDbConfig("write", env),
    (err: Error) => {
      assert.match(err.message, /WRITE_DB_NAME/);
      assert.match(err.message, /WRITE_DB_USER/);
      assert.ok(!err.message.includes(SECRET), "error message must not contain the secret value");
      return true;
    }
  );
});

test("roles: missing legacy config throws with variable NAMES only, no secret", () => {
  assert.throws(
    () => resolveRoleDbConfig("read", { BRAWL_DB_SECRET_V1: SECRET }),
    (err: Error) => {
      assert.match(err.message, /DB_HOST\/DB_PORT\/DB_NAME\/DB_USER\/BRAWL_DB_SECRET_V1/);
      assert.ok(!err.message.includes(SECRET), "error message must not contain the secret value");
      return true;
    }
  );
});

test("tls: CA path enables TLS with certificate verification by default", () => {
  const env = {
    ...legacyEnv(),
    READ_DB_HOST: "reader.do",
    READ_DB_NAME: "ro",
    READ_DB_USER: "app_read",
    READ_DB_SECRET: "r",
    READ_DB_CA_PATH: "/etc/ssl/do-ca.crt",
  };
  const cfg = resolveRoleDbConfig("read", env);
  assert.deepEqual(cfg.tls, { caPath: "/etc/ssl/do-ca.crt", rejectUnauthorized: true });
});

test("tls: SSL=true without a CA still requires verification against system CAs", () => {
  const env = {
    ...legacyEnv(),
    WRITE_DB_HOST: "writer.do",
    WRITE_DB_NAME: "rw",
    WRITE_DB_USER: "ingest_write",
    WRITE_DB_SECRET: "w",
    WRITE_DB_SSL: "true",
  };
  assert.deepEqual(resolveRoleDbConfig("write", env).tls, { rejectUnauthorized: true });
});

test("tls: verification can be explicitly disabled only via SSL_REJECT_UNAUTHORIZED=false", () => {
  const env = {
    ...legacyEnv(),
    READ_DB_HOST: "reader.do",
    READ_DB_NAME: "ro",
    READ_DB_USER: "app_read",
    READ_DB_SECRET: "r",
    READ_DB_CA_PATH: "/etc/ssl/do-ca.crt",
    READ_DB_SSL_REJECT_UNAUTHORIZED: "false",
  };
  assert.equal(resolveRoleDbConfig("read", env).tls?.rejectUnauthorized, false);
});

test("pool limits: role pool size is configurable and defaults to 2; invalid is rejected", () => {
  const base = {
    ...legacyEnv(),
    READ_DB_HOST: "reader.do",
    READ_DB_NAME: "ro",
    READ_DB_USER: "app_read",
    READ_DB_SECRET: "r",
  };
  assert.equal(resolveRoleDbConfig("read", base).connectionLimit, 2);
  assert.equal(resolveRoleDbConfig("read", { ...base, READ_DB_POOL_SIZE: "5" }).connectionLimit, 5);
  assert.throws(() => resolveRoleDbConfig("read", { ...base, READ_DB_POOL_SIZE: "0" }), /positive integer/);
  assert.throws(() => resolveRoleDbConfig("read", { ...base, READ_DB_POOL_SIZE: "abc" }), /positive integer/);
});

test("parsePort: unset -> 3306, valid -> number, invalid -> throws", () => {
  assert.equal(parsePort(undefined), 3306);
  assert.equal(parsePort(""), 3306);
  assert.equal(parsePort("25060"), 25060);
  assert.throws(() => parsePort("-1"), /valid port/);
  assert.throws(() => parsePort("nope"), /valid port/);
});
