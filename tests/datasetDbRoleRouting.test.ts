import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeDbRole, resolveRoleDbConfig, rolesReuseLegacyPool } from "../lib/mysql";

const legacy = { DB_HOST: "hostinger", DB_NAME: "brawl", DB_USER: "app", BRAWL_DB_SECRET_V1: "secret" };

test("role pools reuse the same legacy fallback configuration when neither role is populated", () => {
  assert.equal(rolesReuseLegacyPool(legacy), true);
  assert.deepEqual(
    { ...resolveRoleDbConfig("read", legacy), role: "write" },
    resolveRoleDbConfig("write", legacy)
  );
});

test("read and write roles are distinct when configured independently", () => {
  const env = { ...legacy, READ_DB_HOST: "reader", READ_DB_NAME: "brawl", READ_DB_USER: "ro", READ_DB_SECRET: "r", WRITE_DB_HOST: "writer", WRITE_DB_NAME: "brawl", WRITE_DB_USER: "rw", WRITE_DB_SECRET: "w" };
  assert.equal(rolesReuseLegacyPool(env), false);
  assert.notEqual(resolveRoleDbConfig("read", env).host, resolveRoleDbConfig("write", env).host);
});

test("any partial role variable fails clearly, even without HOST", () => {
  assert.throws(() => resolveRoleDbConfig("read", { ...legacy, READ_DB_USER: "ro" }), /READ_DB_HOST.*READ_DB_NAME.*READ_DB_SECRET/);
});

test("safe role description contains no password", () => {
  const description = describeDbRole("read", legacy);
  assert.equal("password" in description, false);
  assert.doesNotMatch(JSON.stringify(description), /secret/);
});

test("public route uses read pool and preserves its response builder", () => {
  const route = readFileSync(new URL("../app/api/public/tier-list/route.ts", import.meta.url), "utf8");
  assert.match(route, /getReadPool\(\)/);
  assert.doesNotMatch(route, /getPool\(\)/);
  assert.match(route, /buildPublicTierListResponse/);
});

test("mixed read-before-write workflows stay entirely on the write pool", () => {
  for (const file of ["catalog/sync.ts", "aggregation/sync.ts", "ranking/sync.ts", "ingestion/sync/battleLogCrawlSync.ts"]) {
    const source = readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8");
    assert.match(source, /getWritePool\(\)/, file);
    assert.doesNotMatch(source, /getReadPool\(\)/, file);
  }
});

test("role TLS parsing remains verified by default", () => {
  const config = resolveRoleDbConfig("read", { ...legacy, READ_DB_HOST: "reader", READ_DB_NAME: "brawl", READ_DB_USER: "ro", READ_DB_SECRET: "r", READ_DB_SSL: "true" });
  assert.deepEqual(config.tls, { rejectUnauthorized: true });
});
