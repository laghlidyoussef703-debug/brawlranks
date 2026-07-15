/**
 * Structural tests for the migration file set and checksum determinism —
 * exercises the same logic scripts/migrate.mjs uses for discovery and
 * drift detection, without needing a database connection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

test("migrations: every file matches the NNNN_name.sql naming pattern", async () => {
  const files = await listMigrationFiles();
  assert.ok(files.length > 0, "expected at least one migration file");
  for (const filename of files) {
    assert.match(filename, /^\d{4}_[a-z0-9_]+\.sql$/);
  }
});

test("migrations: versions are unique and sort in ascending numeric order", async () => {
  const files = await listMigrationFiles();
  const versions = files.map((f) => Number(f.slice(0, 4)));
  const sorted = [...versions].sort((a, b) => a - b);
  assert.deepEqual(versions, sorted);
  assert.equal(new Set(versions).size, versions.length);
});

test("migrations: no file uses CAST(? AS JSON) (unsupported on this MariaDB version)", async () => {
  const files = await listMigrationFiles();
  for (const filename of files) {
    const content = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
    // Header comments are allowed to explain why CAST(? AS JSON) is avoided
    // (see 0004's header) — only executable SQL is checked here.
    const sqlOnly = content.replace(/--.*$/gm, "");
    assert.ok(
      !/CAST\s*\(\s*\?\s+AS\s+JSON\s*\)/i.test(sqlOnly),
      `${filename} must not use CAST(? AS JSON) in executable SQL`
    );
  }
});

test("migrations: no file contains a bare JSON column type (LONGTEXT required for stored payloads)", async () => {
  const files = await listMigrationFiles();
  for (const filename of files) {
    const content = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
    assert.ok(!/\bJSON\b(?!\s+DEFAULT)/.test(content.replace(/--.*$/gm, "")), `${filename} unexpectedly declares a JSON column`);
  }
});

test("migrations: checksum is deterministic for identical content", async () => {
  const files = await listMigrationFiles();
  const content = await readFile(path.join(MIGRATIONS_DIR, files[0]), "utf8");
  const a = createHash("sha256").update(content, "utf8").digest("hex");
  const b = createHash("sha256").update(content, "utf8").digest("hex");
  assert.equal(a, b);
});

test("migrations: two different files produce different checksums", async () => {
  const files = await listMigrationFiles();
  assert.ok(files.length >= 2);
  const contentA = await readFile(path.join(MIGRATIONS_DIR, files[0]), "utf8");
  const contentB = await readFile(path.join(MIGRATIONS_DIR, files[1]), "utf8");
  const checksumA = createHash("sha256").update(contentA, "utf8").digest("hex");
  const checksumB = createHash("sha256").update(contentB, "utf8").digest("hex");
  assert.notEqual(checksumA, checksumB);
});

test("migrations: no file touches api_test_snapshots (out of scope for Phase 2)", async () => {
  const files = await listMigrationFiles();
  for (const filename of files) {
    const content = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
    assert.ok(!/api_test_snapshots/i.test(content), `${filename} must not reference api_test_snapshots`);
  }
});

test("migrations: workflow_runs.status column is wide enough for every value its own CHECK constraint allows", async () => {
  // Regression test for the bug fixed in 0016: migration 0002 declared
  // status VARCHAR(20) but its CHECK constraint already allowed
  // 'succeeded_with_warnings' (23 chars) — a value the column could never
  // actually store. This test reads the FINAL authoritative definition
  // (0016, the last migration to touch this column) and asserts the
  // widened column width is >= the longest allowed status literal, so this
  // class of bug can't silently reappear if the status vocabulary changes
  // again without widening the column to match.
  const content = await readFile(path.join(MIGRATIONS_DIR, "0016_widen_workflow_runs_status.sql"), "utf8");

  const columnMatch = /MODIFY COLUMN status VARCHAR\((\d+)\)/i.exec(content);
  assert.ok(columnMatch, "expected to find the widened status column definition in 0016");
  const columnWidth = Number(columnMatch![1]);

  const checkMatch = /chk_workflow_runs_status CHECK \(\s*status IN \(([^)]+)\)/i.exec(content);
  assert.ok(checkMatch, "expected to find the chk_workflow_runs_status CHECK constraint in 0016");
  const statusValues = checkMatch![1]
    .split(",")
    .map((v) => v.trim().replace(/^'|'$/g, ""));

  assert.ok(statusValues.includes("succeeded_with_warnings"), "expected the known-longest status value to be present");

  const longest = statusValues.reduce((max, v) => Math.max(max, v.length), 0);
  assert.ok(
    longest <= columnWidth,
    `longest allowed status value is ${longest} chars ("${statusValues.find((v) => v.length === longest)}"), but the column is only VARCHAR(${columnWidth})`
  );
});
