#!/usr/bin/env node
/**
 * DATASET unit-test runner.
 *
 * Runs the DATASET work-package unit tests (no database required) via the same
 * `tsx --test` harness the rest of the project uses. This exists as a
 * dedicated entrypoint so the DATASET tests have a single committed command
 * without modifying the shared package.json "test" script (which currently
 * carries unrelated in-progress frontend changes). Once that lands, these can
 * be folded into `npm test`.
 *
 * Usage:  node scripts/dataset/run-dataset-tests.mjs
 *
 * Database-backed proofs are NOT run here — they need disposable containers:
 *   - scripts/dataset/mysql84-compat-test.mjs   (mysql:8.4)
 *   - scripts/dataset/smoke-restored-db.ts      (restored copy)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");

const DATASET_UNIT_TESTS = [
  "tests/datasetMysql84Compat.test.ts",
  "tests/datasetDbRoles.test.ts",
  "tests/datasetDbRoleRouting.test.ts",
  "tests/datasetMigrationPhase8.test.ts",
  "tests/datasetArchive.test.ts",
  "tests/datasetArchiveRouteAuth.test.ts",
  "tests/migrationTlsConfig.test.ts",
];

// Only run tests that exist, so this stays green as the suite grows.
const existing = DATASET_UNIT_TESTS.filter((rel) => existsSync(path.join(REPO_ROOT, rel)));

// Use node's own --test with the tsx loader and EXPLICIT files. Passing files
// explicitly disables directory auto-discovery, so unrelated `*-test.mjs`
// helper scripts (e.g. the container-backed compat proof) are never run here.
const child = spawn(process.execPath, ["--import", "tsx", "--test", ...existing], {
  cwd: REPO_ROOT,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(`run-dataset-tests error: ${err.message}`);
  process.exit(1);
});
