/**
 * DATASET Phase 3 — MySQL 8.4 compatibility guards (no database required).
 *
 * These are the CI-runnable half of the Phase 3 compatibility proof. The
 * deeper proof — applying all migrations to a real MySQL 8.4 server and
 * exercising runtime semantics — lives in
 * scripts/dataset/mysql84-compat-test.mjs and is run against a disposable
 * container (documented in docs/dataset/phase3-mysql84-compat.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCompatibilityCheck } from "../scripts/dataset/compatibility-check.mjs";
import {
  ACCEPTED_PRIOR_CHECKSUMS,
  isAcceptedPriorChecksum,
  verifyNoChecksumDrift,
} from "../scripts/migrate.mjs";

const REPO_ROOT = path.join(__dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "migrations");

const OLD_0014_CHECKSUM =
  "aab4acd247747216c2a56ad2396d0c724d7fb74df02ba8b4fc36b075a4272302";

async function fileChecksum(filename: string): Promise<string> {
  const content = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

test("compat: static MariaDB->MySQL 8.4 check reports ZERO blockers", async () => {
  const report = await runCompatibilityCheck();
  const blockers = report.findings.filter((f: { severity: string }) => f.severity === "BLOCKER");
  assert.equal(
    blockers.length,
    0,
    `expected 0 blockers, got: ${blockers.map((b: { detail: string }) => b.detail).join(" | ")}`
  );
});

test("compat: battle_teams.rank is backtick-quoted in migration 0014", async () => {
  const content = await readFile(
    path.join(MIGRATIONS_DIR, "0014_create_battle_tables.sql"),
    "utf8"
  );
  // The executable column definition must quote the reserved word.
  assert.match(content, /`rank`\s+INT\s+NULL/i, "battle_teams.rank must be backtick-quoted");
  // And the unquoted reserved-word column definition must be gone.
  const sqlOnly = content.replace(/--.*$/gm, "");
  assert.ok(
    !/\n\s*rank\s+INT\s+NULL/i.test(sqlOnly),
    "no unquoted `rank INT NULL` column definition may remain"
  );
});

test("compat: 0014 checksum changed, and the old checksum is allowlisted", async () => {
  const current = await fileChecksum("0014_create_battle_tables.sql");
  assert.notEqual(current, OLD_0014_CHECKSUM, "0014 checksum must differ from the pre-quote value");
  assert.ok(
    ACCEPTED_PRIOR_CHECKSUMS["0014"] instanceof Set,
    "0014 must have an allowlist entry"
  );
  assert.ok(
    ACCEPTED_PRIOR_CHECKSUMS["0014"].has(OLD_0014_CHECKSUM),
    "the production (pre-quote) 0014 checksum must be allowlisted"
  );
});

test("reconciliation: isAcceptedPriorChecksum only accepts the exact allowlisted pair", () => {
  assert.equal(isAcceptedPriorChecksum("0014", OLD_0014_CHECKSUM), true);
  assert.equal(isAcceptedPriorChecksum("0014", "deadbeef".repeat(8)), false);
  assert.equal(isAcceptedPriorChecksum("0013", OLD_0014_CHECKSUM), false);
});

test("reconciliation: drift guard accepts allowlisted supersession, rejects unknown drift", async () => {
  const current = await fileChecksum("0014_create_battle_tables.sql");
  const files = [{ version: "0014", filename: "0014_create_battle_tables.sql", checksum: current }];

  // Exact match: no throw.
  assert.doesNotThrow(() =>
    verifyNoChecksumDrift(files, new Map([["0014", { checksum: current }]]))
  );

  // Allowlisted prior checksum: no throw (reviewed, schema-preserving).
  assert.doesNotThrow(() =>
    verifyNoChecksumDrift(files, new Map([["0014", { checksum: OLD_0014_CHECKSUM }]]))
  );

  // Unknown drift: must abort.
  assert.throws(
    () =>
      verifyNoChecksumDrift(
        files,
        new Map([["0014", { checksum: "0".repeat(64) }]])
      ),
    /Checksum drift detected/
  );
});
