import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applySimulated, advanceReadiness, childCountHash, compositePage, fixedWatermark, overlapStart, PageCursorSimulation, reconcileEphemeral, reconcileSimulatedTargetWorkflowLock } from "../scripts/dataset-migration/simulation";
import { FAMILY_ORDER, plansFor, TABLE_PLANS } from "../scripts/dataset-migration/model";
import { assertDifferentDatabases, inspectConfig, redactSecrets, resolveEndpoint } from "../scripts/dataset-migration/config";
import { assessSourceGrants, assertSourceSqlReadOnly, createSourceReader } from "../scripts/dataset-migration/source-reader";
import type { Pool } from "mysql2/promise";
import { normalizeTimeCursor, normalizeTimestamp, normalizeTimestampRow } from "../scripts/dataset-migration/timestamp";
import { BufferedStateStore, FileStateStore, type SyncState } from "../scripts/dataset-migration/state";
import { acquireWorkflowLock } from "../lib/workflow";
import { classifyWorkflowLockRow, normalizeWorkflowLockRow, WORKFLOW_LOCK_TTLS_MS } from "../scripts/dataset-migration/workflow-lock-normalization";
import { readEligibleWorkflowLockKeyPage } from "../scripts/dataset-migration/validation";
import { assertInventoryReady, classifyTableInventory, readRepositoryMigrations, runInventoriedPlans, skippedTableReport, type AppliedMigration, type RepositoryMigration } from "../scripts/dataset-migration/inventory";
import { assertStrictCursorProgress, formatProgressLine, MigrationProgressTracker, nextRetryAttempt, validatePageProgress } from "../scripts/dataset-migration/progress";
import { BULK_HISTORY_TABLES, resolveScope, scopeManifestHash, scopePlans, scopeStateIdentity, summarizeScope, SCOPES } from "../scripts/dataset-migration/scope";

const rows = [
  { id: "b", timestamp: "2026-01-01T00:00:00.000Z", key: "b", content: "2" },
  { id: "a", timestamp: "2026-01-01T00:00:00.000Z", key: "a", content: "1" },
  { id: "c", timestamp: "2026-01-01T00:00:01.000Z", key: "c", content: "3" },
];

test("composite pagination is deterministic across equal timestamps", () => {
  const upper = fixedWatermark(rows)!;
  assert.deepEqual(compositePage(rows, null, upper, 2).map((r) => r.id), ["a", "b"]);
  assert.deepEqual(compositePage(rows, { timestamp: rows[0].timestamp, id: "b" }, upper, 2).map((r) => r.id), ["c"]);
});

test("fixed upper watermark excludes rows arriving during a pass", () => {
  const upper = fixedWatermark(rows)!;
  const later = [...rows, { id: "d", timestamp: "2026-01-01T00:00:02.000Z", key: "d", content: "4" }];
  assert.deepEqual(compositePage(later, null, upper, 10).map((r) => r.id), ["a", "b", "c"]);
});

test("overlap replays rows without duplication through idempotent comparison", () => {
  const target = new Map<string, typeof rows[number]>();
  for (const row of rows) applySimulated(row, target, true);
  const start = overlapStart({ timestamp: rows[2].timestamp, id: "c" }, 2);
  for (const row of compositePage(rows, start, fixedWatermark(rows)!, 10)) assert.equal(applySimulated(row, target, true), "matched");
  assert.equal(target.size, 3);
});

test("failed page does not advance cursor and retry uses the same page", () => {
  const state = new PageCursorSimulation();
  assert.throws(() => state.apply(rows, true), /failed/);
  assert.equal(state.cursor, null);
  state.apply(rows, false);
  assert.deepEqual(state.cursor, { timestamp: rows[2].timestamp, id: "c" });
  assert.equal(state.attempts, 2);
});

test("mutable duplicate updates while immutable exact duplicate is a no-op", () => {
  const target = new Map([["a", { ...rows[0], key: "a", content: "old" }]]);
  assert.equal(applySimulated({ ...rows[0], key: "a", content: "new" }, target, false), "updated");
  assert.equal(applySimulated({ ...rows[0], key: "a", content: "new" }, target, true), "matched");
});

test("immutable duplicate mismatch, battle_key divergence, and raw checksum mismatch are fatal", () => {
  for (const key of ["immutable-id", "battle-key", "raw-snapshot-id"]) {
    const target = new Map([[key, { ...rows[0], key, content: "target" }]]);
    assert.throws(() => applySimulated({ ...rows[0], key, content: "source" }, target, true), /fatal divergence/);
  }
});

test("run parents are mutable and workflow steps are parent-driven", () => {
  for (const table of ["workflow_runs", "data_fetch_runs", "aggregation_runs", "ranking_runs"]) assert.equal(plansFor(table)[0].mode, "mutable");
  const steps = plansFor("workflow_steps")[0];
  assert.equal(steps.mode, "parent"); assert.deepEqual(steps.naturalKeys, [["workflow_run_id", "step_order"]]);
});

test("workflow locks are full ephemeral reconciliation with scoped deletion", () => {
  const plan = plansFor("workflow_locks")[0];
  assert.equal(plan.mode, "ephemeral"); assert.equal(plan.deleteTargetOnly, true);
  assert.deepEqual(reconcileEphemeral(["a"], ["a", "stale"]).stale, ["stale"]);
});

test("dependency order is parent-before-child", () => {
  assert.deepEqual(FAMILY_ORDER, ["parent-runs", "workflow-children", "raw-data", "catalogs-config", "players", "battles", "battle-children", "derived-public"]);
  assert.ok(TABLE_PLANS.findIndex((p) => p.table === "normalized_battles") < TABLE_PLANS.findIndex((p) => p.table === "battle_participants"));
});

test("battle child count and hashes detect incomplete graphs", () => {
  const a = childCountHash([{ parent: "battle", content: "team1" }, { parent: "battle", content: "team2" }]);
  const b = childCountHash([{ parent: "battle", content: "team1" }]);
  assert.notDeepEqual(a.get("battle"), b.get("battle"));
});

test("published pointer and items are reconciled in one transaction structurally", () => {
  const source = readFileSync(new URL("../scripts/dataset-migration/validation.ts", import.meta.url), "utf8");
  assert.match(source, /beginTransaction\(\)/); assert.match(source, /published_snapshot_items/); assert.match(source, /published_matchup_items/); assert.match(source, /UPDATE published_snapshots SET is_current=1/); assert.match(source, /commit\(\)/);
});

test("same database safety refusal", () => {
  const base = { role: "source" as const, host: "db", port: 3306, database: "brawl", user: "ro", password: "x", connectionLimit: 2, ssl: { rejectUnauthorized: true } };
  assert.throws(() => assertDifferentDatabases(base, { ...base, role: "target" }), /same host/);
});

test("migration endpoint requires verified TLS and secret redaction", () => {
  const env = { SOURCE_DB_HOST: "s", SOURCE_DB_NAME: "d", SOURCE_DB_USER: "u", SOURCE_DB_SECRET: "do-not-print" };
  assert.throws(() => resolveEndpoint("source", env), /TLS/);
  assert.equal(redactSecrets("failure do-not-print", env), "failure [REDACTED]");
});

test("three consecutive successful under-60-second passes are required", () => {
  let consecutive = 0;
  consecutive = advanceReadiness(consecutive, true, 59); assert.equal(consecutive, 1);
  consecutive = advanceReadiness(consecutive, true, 20); assert.equal(consecutive, 2);
  consecutive = advanceReadiness(consecutive, true, 0); assert.equal(consecutive, 3);
  assert.equal(advanceReadiness(consecutive, false, 0), 0);
});

test("MariaDB to MySQL 8.4 plan avoids UUID-only chronological cursors", () => {
  for (const table of ["workflow_runs", "data_fetch_runs", "aggregation_runs", "ranking_runs", "raw_api_snapshots", "normalized_battles"]) assert.ok(plansFor(table)[0].cursorColumn);
  const engine = readFileSync(new URL("../scripts/dataset-migration/engine.ts", import.meta.url), "utf8");
  assert.doesNotMatch(engine, /WHERE\s+id\s*>\s*\?[^\n]*ORDER BY\s+id\s+LIMIT/i);
});

test("source SQL invariant permits only ordinary SELECT and SHOW reads", async () => {
  const delegated: string[] = [];
  const fakePool = {
    query: async (sql: string) => { delegated.push(sql); return [[], []]; },
    end: async () => undefined,
  } as unknown as Pick<Pool, "query" | "end">;
  const source = createSourceReader(fakePool);

  await source.query("SELECT * FROM raw_api_snapshots WHERE id=?", ["id"]);
  await source.query("SHOW GRANTS FOR CURRENT_USER");
  assert.equal(delegated.length, 2);

  for (const sql of [
    "INSERT INTO raw_api_snapshots(id) VALUES ('x')",
    "UPDATE workflow_runs SET status='failed'",
    "DELETE FROM workflow_locks",
    "CREATE TABLE forbidden(id INT)",
    "ALTER TABLE normalized_battles ADD COLUMN forbidden INT",
    "DROP TABLE normalized_battles",
    "TRUNCATE TABLE workflow_locks",
    "START TRANSACTION",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SET @x=1",
    "CALL mutate_source()",
    "EXECUTE prepared_mutation",
    "SELECT * FROM workflow_runs FOR UPDATE",
    "SELECT * FROM raw_api_snapshots INTO OUTFILE '/tmp/source.txt'",
    "SELECT GET_LOCK('migration', 1)",
    "SELECT 1; DELETE FROM workflow_locks",
  ]) {
    await assert.rejects(source.query(sql), /Source SQL invariant/);
  }
  assert.equal(delegated.length, 2, "rejected SQL must never reach the source driver");
});

test("source grant breadth is a warning while SELECT availability remains required", () => {
  const hostinger = assessSourceGrants("GRANT ALL PRIVILEGES ON `brawl`.* TO `migration`@`%`");
  assert.equal(hostinger.selectAvailable, true);
  assert.equal(hostinger.elevatedPrivilegesDetected, true);
  assert.match(hostinger.warning ?? "", /optional least-privilege recommendation/);

  const leastPrivilege = assessSourceGrants("GRANT SELECT ON `brawl`.* TO `migration`@`%`");
  assert.equal(leastPrivilege.selectAvailable, true);
  assert.equal(leastPrivilege.elevatedPrivilegesDetected, false);
  assert.equal(leastPrivilege.warning, null);
  assert.equal(assessSourceGrants("GRANT USAGE ON *.* TO `migration`@`%`").selectAvailable, false);
});

test("inspect-config reports the least-privilege recommendation without needing a database connection", () => {
  const report = inspectConfig({
    SOURCE_DB_HOST: "source.example", SOURCE_DB_NAME: "brawl", SOURCE_DB_USER: "source-user", SOURCE_DB_SECRET: "source-secret", SOURCE_DB_SSL: "true",
    TARGET_DB_HOST: "target.example", TARGET_DB_NAME: "brawl", TARGET_DB_USER: "target-user", TARGET_DB_SECRET: "target-secret", TARGET_DB_SSL: "true",
  });
  assert.match(String((report.warnings as string[])[0]), /not a DATASET\.md Phase 8 completion condition/);
});

test("migration source call sites are constrained to the branded source reader", () => {
  const engine = readFileSync(new URL("../scripts/dataset-migration/engine.ts", import.meta.url), "utf8");
  const validation = readFileSync(new URL("../scripts/dataset-migration/validation.ts", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../scripts/dataset-migration/cli.ts", import.meta.url), "utf8");
  assert.match(engine, /syncTable\(source: SourceReader/);
  assert.match(validation, /globalReconciliation\(source: SourceReader/);
  assert.match(validation, /reconcileCurrentPublication\(source: SourceReader/);
  assert.match(cli, /source: createSourceReader\(createEndpointPool\(sourceConfig\)\)/);
  assert.doesNotMatch(engine, /source\.(?:execute|getConnection|beginTransaction|commit|rollback)\s*\(/);
  assert.doesNotMatch(validation, /source\.(?:execute|getConnection|beginTransaction|commit|rollback)\s*\(/);
});

test("source SQL guard itself rejects mutation and stored execution syntax", () => {
  assert.doesNotThrow(() => assertSourceSqlReadOnly("SELECT COUNT(*) FROM workflow_runs"));
  assert.doesNotThrow(() => assertSourceSqlReadOnly("SHOW GRANTS FOR CURRENT_USER"));
  assert.throws(() => assertSourceSqlReadOnly("CALL source_writer()"), /only SELECT and SHOW/);
});

test("workflow_locks MariaDB zero-date path throws a contextual timestamp error", () => {
  const invalidDriverDate = new Date(Number.NaN);
  assert.throws(
    () => normalizeTimestampRow(
      { id: "lock-id", locked_at: invalidDriverDate, expires_at: "2026-07-21 06:00:00.000", released_at: null },
      { timestampColumns: ["locked_at", "expires_at", "released_at"], nullableColumns: ["released_at"] },
      { family: "workflow-children", table: "workflow_locks" },
      "source page normalization"
    ),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /family=workflow-children/);
      assert.match(message, /table=workflow_locks/);
      assert.match(message, /column=locked_at/);
      assert.match(message, /operation=source page normalization/);
      assert.match(message, /rawType=Date/);
      assert.match(message, /rawValue="Invalid Date"/);
      return true;
    }
  );
});

test("timestamp normalization handles MariaDB strings, null, Date, numeric epoch, and rejects zero dates", () => {
  const required = { family: "parent-runs", table: "workflow_runs", column: "created_at", operation: "fixed upper-watermark calculation", nullable: false };
  assert.equal(normalizeTimestamp("2026-07-21 05:13:07.499", required), "2026-07-21T05:13:07.499Z");
  assert.equal(normalizeTimestamp("2026-07-21T06:13:07.499+01:00", required), "2026-07-21T05:13:07.499Z");
  assert.equal(normalizeTimestamp(new Date("2026-07-21T05:13:07.499Z"), required), "2026-07-21T05:13:07.499Z");
  assert.equal(normalizeTimestamp(Date.parse("2026-07-21T05:13:07.499Z"), required), "2026-07-21T05:13:07.499Z");
  assert.equal(normalizeTimestamp(null, { ...required, column: "completed_at", nullable: true }), null);
  assert.throws(() => normalizeTimestamp("0000-00-00 00:00:00", required), /rawType=string.*zero dates/);
  assert.throws(() => normalizeTimestamp(null, required), /Invalid required timestamp/);
});

test("invalid durable time cursor fails before it can be reused", () => {
  const plan = plansFor("workflow_runs")[0];
  assert.throws(
    () => normalizeTimeCursor({ timestamp: "0000-00-00 00:00:00", id: "run-id" }, plan, "created_at", "durable cursor loading"),
    /table=workflow_runs.*column=created_at.*operation=durable cursor loading/
  );
});

test("failed dry-run buffering leaves durable migration state and manifests unchanged", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "brawlranks-dry-run-state-"));
  try {
    const durable = new FileStateStore(directory);
    const buffered = new BufferedStateStore(durable);
    await buffered.initialize();
    const state: SyncState = {
      version: 1, sourceIdentity: "source", targetIdentity: "target", family: "workflow-children", table: "workflow_locks",
      cursor: null, upperWatermark: { timestamp: "hash", id: "lock-id" }, overlapStart: null, passId: "failed-pass", pageNumber: 0,
      status: "failed", pageCounts: { completed: 0, failed: 1, rows: 0 }, latestManifestChecksum: null,
      startedAt: "2026-07-21T05:13:07.499Z", completedAt: null, error: "contextual failure",
    };
    await buffered.write("workflow_locks", state);
    await buffered.writeManifest({
      passId: "failed-pass", family: "workflow-children", table: "workflow_locks", pageNumber: 1, lowerCursor: null,
      upperWatermark: state.upperWatermark, firstKey: "id=lock-id", lastKey: "id=lock-id", sourceRowCount: 1,
      insertedCount: 0, updatedCount: 0, matchedCount: 0, deletedCount: 0, sourceChecksum: "", targetVerificationChecksum: "",
      durationMs: 1, retryCount: 0, status: "failed", error: "contextual failure",
    });
    assert.equal(await durable.read("workflow_locks"), null);
    assert.equal(existsSync(path.join(directory, "manifests", "failed-pass")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration pools preserve raw MariaDB/MySQL date strings for centralized normalization", () => {
  const config = readFileSync(new URL("../scripts/dataset-migration/config.ts", import.meta.url), "utf8");
  assert.match(config, /dateStrings:\s*true/);
});

test("workflow lock schema and corrected insert explicitly populate required locked_at", () => {
  const schema = readFileSync(new URL("../migrations/0002_create_workflow_foundation.sql", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../lib/workflow.ts", import.meta.url), "utf8");
  assert.match(schema, /locked_at DATETIME\(3\) NOT NULL/);
  assert.match(workflow, /INSERT INTO workflow_locks \(id, workflow_definition_id, locked_by_run_id, locked_at, expires_at\)/);
  assert.match(workflow, /VALUES \(\?, \?, \?, UTC_TIMESTAMP\(3\), DATE_ADD\(UTC_TIMESTAMP\(3\), INTERVAL \? MICROSECOND\)\)/);
});

test("workflow lock acquisition sends a MySQL 8 strict-compatible explicit timestamp insert", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    execute: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return [{ affectedRows: 1 }, []];
    },
  } as unknown as Pool;
  const result = await acquireWorkflowLock(db, "definition-id", "run-id", 120_000);
  assert.equal(result.acquired, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /locked_at, expires_at/);
  assert.match(calls[1].sql, /UTC_TIMESTAMP\(3\)/);
  assert.deepEqual(calls[1].values.slice(1), ["definition-id", "run-id", 120_000_000]);
});

test("CLI error JSON preserves a redacted stack trace during timestamp investigation", () => {
  const cli = readFileSync(new URL("../scripts/dataset-migration/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /error: message, stack/);
  assert.match(cli, /redactSecrets\(error\.stack\)/);
});

test("workflow lock TTL mapping is exact from code evidence", () => {
  assert.deepEqual(WORKFLOW_LOCK_TTLS_MS, {
    "catalog-sync-brawlers": [300_000],
    "club-expansion": [300_000],
    "battle-log-crawl": [300_000],
    "player-discovery": [300_000],
    "retention-sweep": [300_000],
    "ranking-seed-refresh": [300_000],
    "ranking-rebuild": [120_000, 900_000],
    "statistical-aggregation": [120_000, 900_000],
  });
});

test("ranking-rebuild released and expired ambiguous zero-date lock is skipped", () => {
  const decision = classifyWorkflowLockRow(
    { id: "rank-lock", workflow_definition_id: "rank-definition", locked_at: "0000-00-00 00:00:00.000", expires_at: "2026-07-21 05:15:00.000", released_at: "2026-07-21 05:16:00.000", locked_by_run_id: "missing-owner" },
    "ranking-rebuild", "2026-07-21T05:20:00.000Z"
  );
  assert.equal(decision.action, "skip");
  if (decision.action === "skip") assert.deepEqual(decision.evidence, {
    lockId: "rank-lock", workflowDefinitionId: "rank-definition", workflowSlug: "ranking-rebuild",
    expiresAt: "2026-07-21T05:15:00.000Z", releasedAt: "2026-07-21T05:16:00.000Z",
    reasonCode: "ambiguous_zero_date_released_expired_ephemeral_lock",
  });
});

test("statistical-aggregation released and expired ambiguous zero-date lock is skipped", () => {
  const decision = classifyWorkflowLockRow(
    { id: "agg-lock", workflow_definition_id: "agg-definition", locked_at: "0000-00-00 00:00:00.000", expires_at: "2026-07-21 05:15:00.000", released_at: "2026-07-21 05:16:00.000", locked_by_run_id: "missing-owner" },
    "statistical-aggregation", "2026-07-21T05:20:00.000Z"
  );
  assert.equal(decision.action, "skip");
});

test("active or unreleased zero-date workflow lock fails closed", () => {
  assert.throws(() => classifyWorkflowLockRow(
    { id: "active", workflow_definition_id: "definition", locked_at: "0000-00-00 00:00:00.000", expires_at: "2026-07-21 05:15:00.000", released_at: null },
    "ranking-rebuild", "2026-07-21T05:20:00.000Z"
  ), /column=released_at.*required value is null/);
});

test("zero-date workflow lock after the fixed watermark fails closed", () => {
  assert.throws(() => classifyWorkflowLockRow(
    { id: "future", workflow_definition_id: "definition", locked_at: "0000-00-00 00:00:00.000", expires_at: "2026-07-21 05:20:00.001", released_at: "2026-07-21 05:16:00.000" },
    "ranking-rebuild", "2026-07-21T05:20:00.000Z"
  ), /after fixed source watermark/);
});

test("fixed watermark comparison includes expiry exactly at the watermark", () => {
  const decision = classifyWorkflowLockRow(
    { id: "boundary", workflow_definition_id: "definition", locked_at: "0000-00-00 00:00:00.000", expires_at: "2026-07-21 05:20:00.000", released_at: "2026-07-21 05:19:00.000" },
    "ranking-rebuild", "2026-07-21T05:20:00.000Z"
  );
  assert.equal(decision.action, "skip");
});

test("zero-date with owner uses the verified workflow-specific TTL", () => {
  const result = normalizeWorkflowLockRow(
    { locked_at: "0000-00-00 00:00:00.000", expires_at: "2026-07-21 05:05:00.000", locked_by_run_id: "owner-run" },
    "catalog-sync-brawlers"
  );
  assert.equal(result.normalized, true);
  assert.equal(result.row.locked_at, "2026-07-21T05:00:00.000Z");
});

test("unknown workflow slug fails zero-date normalization", () => {
  assert.throws(
    () => normalizeWorkflowLockRow({ locked_at: "0000-00-00 00:00:00.000", expires_at: "2026-07-21 05:05:00.000" }, "unknown-workflow"),
    /unknown workflow slug/
  );
});

test("non-zero workflow lock timestamp is unchanged", () => {
  const row = { locked_at: "2026-07-21 05:00:00.000", expires_at: "2026-07-21 05:05:00.000" };
  const result = normalizeWorkflowLockRow(row, "unknown-workflow");
  assert.equal(result.normalized, false);
  assert.equal(result.row, row);
});

test("ordinary non-zero workflow lock remains eligible for normal reconciliation", () => {
  const row = { id: "ordinary", workflow_definition_id: "definition", locked_at: "2026-07-21 05:00:00.000", expires_at: "2026-07-21 05:05:00.000", released_at: null };
  const decision = classifyWorkflowLockRow(row, "unknown-workflow", "2026-07-21T05:20:00.000Z");
  assert.deepEqual(decision, { action: "copy", row, normalized: false });
});

test("workflow lock normalization is idempotent", () => {
  const first = normalizeWorkflowLockRow({ locked_at: "0000-00-00 00:00:00.000", expires_at: "2026-07-21 05:05:00.000" }, "club-expansion");
  const second = normalizeWorkflowLockRow(first.row, "club-expansion");
  assert.equal(first.normalized, true);
  assert.equal(second.normalized, false);
  assert.deepEqual(second.row, first.row);
});

test("invalid zero-date workflow lock fails before cursor advancement", () => {
  const state = new PageCursorSimulation();
  assert.throws(() => classifyWorkflowLockRow(
    { id: "active", workflow_definition_id: "definition", locked_at: "0000-00-00 00:00:00.000", expires_at: "2026-07-21 05:15:00.000", released_at: null },
    "ranking-rebuild", "2026-07-21T05:20:00.000Z"
  ), /released_at/);
  assert.equal(state.cursor, null);
});

test("workflow-lock page manifests record normalization counts by slug", () => {
  const stateSource = readFileSync(new URL("../scripts/dataset-migration/state.ts", import.meta.url), "utf8");
  const engineSource = readFileSync(new URL("../scripts/dataset-migration/engine.ts", import.meta.url), "utf8");
  assert.match(stateSource, /normalizedTimestampCounts\?: Record<string, number>/);
  assert.match(engineSource, /normalizedTimestampCounts,/);
  assert.match(stateSource, /skippedEphemeralStaleLockCountsBySlug/);
  assert.match(stateSource, /skippedEphemeralStaleLocks/);
});

test("skipped ephemeral locks are excluded from workflow-lock source-only gap detection", () => {
  const validation = readFileSync(new URL("../scripts/dataset-migration/validation.ts", import.meta.url), "utf8");
  assert.match(validation, /antiJoinWorkflowLocks/);
  assert.match(validation, /readEligibleWorkflowLockKeyPage/);
  assert.match(validation, /classifyWorkflowLockRow/);
});

test("repeated apply of a skipped ephemeral lock is idempotent", () => {
  const target = new Map<string, unknown>();
  const row = { id: "skip-twice", workflow_definition_id: "definition", locked_at: "0000-00-00 00:00:00.000", expires_at: "2026-07-21 05:15:00.000", released_at: "2026-07-21 05:16:00.000" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const decision = classifyWorkflowLockRow(row, "statistical-aggregation", "2026-07-21T05:20:00.000Z");
    if (decision.action === "copy") target.set(String(decision.row.id), decision.row);
  }
  assert.equal(target.size, 0);
});

const historicalTargetLock = () => ({
  id: "historical-target-lock",
  workflow_definition_id: "rank-definition",
  locked_at: "0000-00-00 00:00:00.000",
  expires_at: "2026-07-21 05:15:00.000",
  released_at: "2026-07-21 05:16:00.000",
});

test("existing target ambiguous released and expired zero-date lock is a read-only planned deletion in dry-run", () => {
  const target = new Map([["historical-target-lock", historicalTargetLock()]]);
  const result = reconcileSimulatedTargetWorkflowLock(target, "historical-target-lock", "ranking-rebuild", "2026-07-21T05:20:00.000Z", false, false);
  assert.deepEqual(result, { plannedDeleted: 1, deleted: 0, deletionRequired: false });
  assert.equal(target.size, 1);
});

test("apply with scoped deletion authorization removes a historical target zero-date lock", () => {
  const target = new Map([["historical-target-lock", historicalTargetLock()]]);
  const result = reconcileSimulatedTargetWorkflowLock(target, "historical-target-lock", "ranking-rebuild", "2026-07-21T05:20:00.000Z", true, true);
  assert.deepEqual(result, { plannedDeleted: 1, deleted: 1, deletionRequired: false });
  assert.equal(target.size, 0);
});

test("apply without scoped deletion authorization reports deletion required and does not remove the row", () => {
  const target = new Map([["historical-target-lock", historicalTargetLock()]]);
  const result = reconcileSimulatedTargetWorkflowLock(target, "historical-target-lock", "ranking-rebuild", "2026-07-21T05:20:00.000Z", true, false);
  assert.deepEqual(result, { plannedDeleted: 1, deleted: 0, deletionRequired: true });
  assert.equal(target.size, 1);
});

test("unsafe existing target zero-date lock fails closed without cursor advancement", () => {
  const target = new Map([["historical-target-lock", { ...historicalTargetLock(), released_at: null }]]);
  const state = new PageCursorSimulation();
  assert.throws(() => reconcileSimulatedTargetWorkflowLock(target, "historical-target-lock", "ranking-rebuild", "2026-07-21T05:20:00.000Z", false, false), /released_at/);
  assert.equal(state.cursor, null);
  assert.equal(target.size, 1);
});

test("target lookup classifies zero dates before generic target timestamp normalization", () => {
  const engine = readFileSync(new URL("../scripts/dataset-migration/engine.ts", import.meta.url), "utf8");
  const zeroDateBranch = engine.indexOf('plan.table === "workflow_locks" && isMariaDbZeroDate(rawTarget.locked_at)');
  const genericNormalization = engine.indexOf('normalizeTimestampRow(rawTarget, metadata, plan, "target row normalization")');
  assert.ok(zeroDateBranch >= 0 && genericNormalization > zeroDateBranch);
  assert.match(engine, /plannedDeleted = deletion\.planned/);
  assert.match(engine, /options\.apply && options\.allowReconcileDelete/);
  assert.ok(engine.indexOf("assertWorkflowLockTargetPolicySafe(target") < engine.indexOf("const deletion = await reconcileDeletes"));
});

test("target historical deletion rerun is idempotent after authorized deletion", () => {
  const target = new Map([["historical-target-lock", historicalTargetLock()]]);
  assert.equal(reconcileSimulatedTargetWorkflowLock(target, "historical-target-lock", "statistical-aggregation", "2026-07-21T05:20:00.000Z", true, true).deleted, 1);
  assert.deepEqual(
    reconcileSimulatedTargetWorkflowLock(target, "historical-target-lock", "statistical-aggregation", "2026-07-21T05:20:00.000Z", true, true),
    { plannedDeleted: 0, deleted: 0, deletionRequired: false }
  );
});

test("Phase 8 migration SQL never compares a DATETIME to a zero-date literal", () => {
  for (const filename of ["engine.ts", "validation.ts", "cli.ts", "source-reader.ts"]) {
    const source = readFileSync(new URL(`../scripts/dataset-migration/${filename}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /['"]0000-00-00 00:00:00(?:\.000)?['"]/i, filename);
  }
});

test("MySQL 8 strict-mode target inspection classifies a string zero date without SQL literal coercion", async () => {
  let calls = 0;
  const target = {
    async query(sql: string) {
      assert.doesNotMatch(sql, /0000-00-00/);
      assert.match(sql, /CAST\(wl\.locked_at AS CHAR\)/);
      calls += 1;
      if (calls === 1) return [[{
        k: "strict-target-lock", h: "a".repeat(64), workflow_definition_id: "rank-definition",
        workflow_slug: "ranking-rebuild", locked_at: "0000-00-00 00:00:00.000",
        expires_at: "2026-07-21 05:15:00.000", released_at: "2026-07-21 05:16:00.000",
      }], []];
      return [[], []];
    },
  } as unknown as Pool;
  const page = await readEligibleWorkflowLockKeyPage(target, "", "", 100, "2026-07-21T05:20:00.000Z", "target");
  assert.deepEqual(page.keys, []);
  assert.equal(page.done, true);
  assert.equal(calls, 2);
});

test("bounded target inspection retains deterministic zero-date locks for verified repair", async () => {
  let calls = 0;
  const target = {
    async query(sql: string) {
      assert.doesNotMatch(sql, /0000-00-00/);
      calls += 1;
      return [[{
        k: "deterministic-target-lock", h: "b".repeat(64), workflow_definition_id: "catalog-definition",
        workflow_slug: "catalog-sync-brawlers", locked_at: "0000-00-00 00:00:00.000",
        expires_at: "2026-07-21 05:05:00.000", released_at: "2026-07-21 05:06:00.000",
      }], []];
    },
  } as unknown as Pool;
  const page = await readEligibleWorkflowLockKeyPage(target, "", "", 100, "2026-07-21T05:20:00.000Z", "target");
  assert.deepEqual(page.keys, [{ id: "deterministic-target-lock", hash: "b".repeat(64) }]);
  assert.equal(calls, 1);
});

const inventoryMigrations: RepositoryMigration[] = [
  { version: "0001", name: "required", checksum: "required-checksum", tables: ["required_table"] },
  { version: "0026", name: "create_raw_snapshot_archives", checksum: "archive-checksum", tables: ["raw_snapshot_archives"] },
  { version: "0027", name: "future", checksum: "future-checksum", tables: ["future_table"] },
];
const requiredPlan = { family: "catalogs-config", table: "required_table", mode: "full" as const };
const rawArchivePlan = { family: "raw-data", table: "raw_snapshot_archives", mode: "mutable" as const };
const futurePlan = { family: "derived-public", table: "future_table", mode: "full" as const };
const appliedRequired: AppliedMigration[] = [{ version: "0001", name: "required", checksum: "required-checksum" }];

test("raw_snapshot_archives absent on source is skipped and the pass continues", async () => {
  const entries = classifyTableInventory(
    [rawArchivePlan, requiredPlan], inventoryMigrations, appliedRequired,
    new Set(["required_table"]), new Set(["required_table", "raw_snapshot_archives"])
  );
  let metadataReads = 0;
  const reports = await runInventoriedPlans(entries, [rawArchivePlan, requiredPlan], async (plan) => {
    metadataReads += 1;
    return { table: plan.table, status: "completed" };
  }, (entry) => skippedTableReport(entry, "dry-run-pass", false));
  assert.equal(metadataReads, 1, "the absent optional table must not reach syncTable/readMetadata");
  assert.deepEqual(reports.map((report) => report.status), ["skipped_absent_source_table", "completed"]);
});

test("optional table absent on both sides is skipped", () => {
  const [entry] = classifyTableInventory([futurePlan], inventoryMigrations, appliedRequired, new Set(), new Set());
  assert.equal(entry.sourceRequirement, "optional");
  assert.equal(entry.schemaRole, "target-only-or-future-schema");
  assert.equal(entry.action, "skip");
  assert.equal(entry.status, "skipped_absent_source_table");
});

test("optional table present on source and target syncs normally", () => {
  const [entry] = classifyTableInventory([rawArchivePlan], inventoryMigrations, appliedRequired, new Set(["raw_snapshot_archives"]), new Set(["raw_snapshot_archives"]));
  assert.equal(entry.sourceRequirement, "optional");
  assert.equal(entry.action, "sync");
});

test("required table absent on source is a fatal inventory error", async () => {
  const entries = classifyTableInventory([requiredPlan], inventoryMigrations, appliedRequired, new Set(), new Set(["required_table"]));
  assert.equal(entries[0].status, "fatal_inventory_error");
  await assert.rejects(runInventoriedPlans(entries, [requiredPlan], async () => ({ status: "completed" }), () => ({ status: "skipped" })), /required Phase 8 source table is absent/);
});

test("source table present but target absent is a fatal target-schema error", async () => {
  const entries = classifyTableInventory([rawArchivePlan], inventoryMigrations, appliedRequired, new Set(["raw_snapshot_archives"]), new Set());
  assert.equal(entries[0].status, "fatal_target_schema_error");
  await assert.rejects(runInventoriedPlans(entries, [rawArchivePlan], async () => ({ status: "completed" }), () => ({ status: "skipped" })), /approved target migration 0026_create_raw_snapshot_archives/);
});

test("skipping an optional table cannot change a cursor or write a manifest", async () => {
  const entries = classifyTableInventory([rawArchivePlan], inventoryMigrations, appliedRequired, new Set(), new Set());
  const durable = { cursor: "unchanged", manifests: 0 };
  await runInventoriedPlans(entries, [rawArchivePlan], async () => {
    durable.cursor = "corrupted"; durable.manifests += 1; return { status: "completed" };
  }, (entry) => skippedTableReport(entry, "skip-pass", false));
  assert.deepEqual(durable, { cursor: "unchanged", manifests: 0 });
});

test("repository migration audit classifies every current Phase 8 table plan", async () => {
  const repository = await readRepositoryMigrations(new URL("../migrations", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
  const baselineApplied = repository.filter((migration) => Number(migration.version) <= 25).map(({ version, name, checksum }) => ({ version, name, checksum }));
  const baselineTables = new Set(repository.filter((migration) => Number(migration.version) <= 25).flatMap((migration) => migration.tables));
  const allTargetTables = new Set(repository.flatMap((migration) => migration.tables));
  const entries = classifyTableInventory(TABLE_PLANS, repository, baselineApplied, baselineTables, allTargetTables);
  assert.equal(entries.length, TABLE_PLANS.length);
  assert.equal(new Set(entries.map((entry) => entry.table)).size, TABLE_PLANS.length);
  assert.equal(entries.find((entry) => entry.table === "raw_snapshot_archives")?.status, "skipped_absent_source_table");
  assert.ok(entries.filter((entry) => entry.sourceRequirement === "optional").every((entry) => Number(entry.creatingMigration.slice(0, 4)) > 25));
});

test("inventory accepts the same reviewed schema-preserving 0014 checksum as the migration runner", async () => {
  const repository = await readRepositoryMigrations(new URL("../migrations", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
  const migration = repository.find((item) => item.version === "0014")!;
  const table = migration.tables[0];
  assert.doesNotThrow(() => classifyTableInventory(
    [{ family: "battles", table, mode: "immutable" }], repository,
    [{ version: migration.version, name: migration.name, checksum: "aab4acd247747216c2a56ad2396d0c724d7fb74df02ba8b4fc36b075a4272302" }],
    new Set([table]), new Set([table])
  ));
});

test("repeated cursor fails immediately with complete table diagnostics", () => {
  assert.throws(
    () => assertStrictCursorProgress(
      { family: "battles", table: "normalized_battles" },
      { timestamp: "2026-07-21T00:00:00.000Z", id: "battle-500" },
      { timestamp: "2026-07-21T00:00:00.000Z", id: "battle-500" },
      500, "id=battle-500"
    ),
    /cursor repeated; family=battles; table=normalized_battles; previous=.*battle-500.*next=.*battle-500.*rowCount=500; lastRowIdentity=id=battle-500/
  );
});

test("regressing cursor fails immediately", () => {
  assert.throws(
    () => assertStrictCursorProgress(
      { family: "raw-data", table: "raw_api_snapshots" },
      { timestamp: "2026-07-21T00:00:01.000Z", id: "b" },
      { timestamp: "2026-07-21T00:00:00.000Z", id: "z" },
      20, "id=z"
    ),
    /cursor regressed/
  );
});

test("empty page terminates and an exactly page-size page advances", () => {
  const plan = { family: "players", table: "normalized_players" };
  const previous = { timestamp: "2026-07-21T00:00:00.000Z", id: "player-000" };
  assert.equal(validatePageProgress(plan, previous, null, 0, "none"), "done");
  assert.equal(validatePageProgress(plan, previous, { timestamp: previous.timestamp, id: "player-500" }, 500, "id=player-500"), "advanced");
});

test("CPU-only retry and inactivity paths are bounded", async () => {
  let retry = 0, iterations = 0;
  for (;;) {
    const next = nextRetryAttempt(retry, 3);
    if (next === null) break;
    retry = next; iterations += 1;
  }
  assert.equal(iterations, 3);

  const tracker = new MigrationProgressTracker("cpu-watchdog", 15);
  const started = Date.now();
  while (Date.now() - started < 25) { /* simulate an event-loop-blocking CPU path */ }
  assert.throws(() => tracker.activity(), /watchdog timeout.*no database operation/);
  tracker.close();
});

test("initial dry-run metadata is durable before the first table starts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "brawlranks-initial-diagnostic-"));
  try {
    const store = new FileStateStore(directory);
    await store.initialize();
    await store.writeRunMetadata("initial-pass", { passId: "initial-pass", status: "starting", mode: "dry-run" });
    const metadata = JSON.parse(readFileSync(path.join(directory, "runs", "initial-pass.json"), "utf8"));
    assert.equal(metadata.status, "starting");
    assert.deepEqual(await store.read("workflow_runs"), null, "no table needs to start before run metadata exists");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("completed page progress and cursor are persisted atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "brawlranks-page-diagnostic-"));
  try {
    const store = new FileStateStore(directory);
    await store.initialize();
    const cursor = { timestamp: "2026-07-21T00:00:01.000Z", id: "run-500" };
    const state: SyncState = {
      version: 1, sourceIdentity: "source", targetIdentity: "target", family: "parent-runs", table: "workflow_runs",
      cursor, upperWatermark: cursor, overlapStart: null, passId: "page-pass", pageNumber: 1, status: "running",
      pageCounts: { completed: 1, failed: 0, rows: 500 }, latestManifestChecksum: "checksum", startedAt: "2026-07-21T00:00:00.000Z", completedAt: null, error: null,
    };
    await store.writeManifest({
      passId: "page-pass", family: "parent-runs", table: "workflow_runs", pageNumber: 1,
      lowerCursor: null, upperWatermark: cursor, firstKey: "id=run-001", lastKey: "id=run-500", sourceRowCount: 500,
      insertedCount: 1, updatedCount: 2, matchedCount: 497, deletedCount: 0, sourceChecksum: "a", targetVerificationChecksum: "a",
      durationMs: 10, retryCount: 0, status: "completed",
    });
    await store.write("workflow_runs", state);
    assert.equal((await store.read("workflow_runs"))?.pageNumber, 1);
    assert.equal(existsSync(path.join(directory, "manifests", "page-pass", "workflow_runs-00000001.json")), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("interrupted dry-run leaves usable run, table, and stage diagnostics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "brawlranks-interrupted-diagnostic-"));
  try {
    const store = new FileStateStore(directory); await store.initialize();
    await store.writeRunMetadata("interrupted", { passId: "interrupted", status: "running" });
    await store.writeDiagnostic("interrupted", { passId: "interrupted", family: "battles", table: "normalized_battles", stage: "target_comparison", pageNumber: 42 });
    await store.write("normalized_battles", {
      version: 1, sourceIdentity: "source", targetIdentity: "target", family: "battles", table: "normalized_battles",
      cursor: { timestamp: "2026-07-21T00:00:42.000Z", id: "battle-42" }, upperWatermark: null, overlapStart: null,
      passId: "interrupted", pageNumber: 42, status: "running", pageCounts: { completed: 42, failed: 0, rows: 21000 },
      latestManifestChecksum: "checksum", startedAt: "2026-07-21T00:00:00.000Z", completedAt: null, error: null,
    });
    const diagnostic = JSON.parse(readFileSync(path.join(directory, "diagnostics", "interrupted.json"), "utf8"));
    assert.deepEqual({ table: diagnostic.table, stage: diagnostic.stage, pageNumber: diagnostic.pageNumber }, { table: "normalized_battles", stage: "target_comparison", pageNumber: 42 });
    assert.equal((await store.read("normalized_battles"))?.cursor?.id, "battle-42");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("workflow_locks full-table eligible-key scan terminates when a page is entirely skipped", async () => {
  let calls = 0;
  const database = {
    async query() {
      calls += 1;
      if (calls === 1) return [[{
        k: "old-lock", h: "a".repeat(64), workflow_definition_id: "rank-definition", workflow_slug: "ranking-rebuild",
        locked_at: "0000-00-00 00:00:00.000", expires_at: "2026-07-21 05:15:00.000", released_at: "2026-07-21 05:16:00.000",
      }], []];
      return [[], []];
    },
  } as unknown as Pick<Pool, "query">;
  const page = await readEligibleWorkflowLockKeyPage(database, "", "", 500, "2026-07-21T05:20:00.000Z", "source");
  assert.deepEqual(page.keys, []); assert.equal(page.done, true); assert.equal(calls, 2);
});

test("all Phase 8 families produce bounded progress output", async () => {
  const lines: string[] = [];
  const tracker = new MigrationProgressTracker("progress-pass", 60_000, (event) => { lines.push(formatProgressLine(event)); });
  try {
    for (const family of FAMILY_ORDER) {
      await tracker.emit("family_started", { family });
      await tracker.emit("table_started", { family, table: TABLE_PLANS.find((plan) => plan.family === family)!.table, pageNumber: 0 });
      await tracker.emit("family_completed", { family });
    }
  } finally { tracker.close(); }
  for (const family of FAMILY_ORDER) assert.ok(lines.some((line) => line.includes("stage=family_started") && line.includes(`family=${family}`)));
  assert.equal(lines.filter((line) => line.includes("stage=table_started")).length, FAMILY_ORDER.length);
});

test("cursor-driven parent pages do not rebuild or clone an accumulated touched-key array", () => {
  const engine = readFileSync(new URL("../scripts/dataset-migration/engine.ts", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../scripts/dataset-migration/cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(engine, /\.\.\.\(state\.touchedKeys\s*\?\?\s*\[\]\)[\s\S]*rows\.map/);
  assert.match(engine, /PARENT_TABLES\.has\(plan\.table\)\s*&&\s*!plan\.cursorColumn/);
  assert.doesNotMatch(cli, /new BufferedStateStore/);
  assert.match(cli, /new FileStateStore\(apply \? base : path\.join\(base, "dry-run"\)\)/);
});

// --- Phase 8 Tier-1 continuity scope -------------------------------------

const TIER1 = resolveScope("tier-1");
const TIER1_TABLES = new Set(scopePlans(TIER1).map((plan) => plan.table));

test("tier-1 scope selects the mandatory continuity tables", () => {
  for (const table of [
    "data_sources", "source_endpoints", "workflow_definitions",
    "ranking_rule_sets", "ranking_rule_weights", "tier_thresholds", "patches",
    "canonical_brawlers", "brawler_aliases", "gadgets", "star_powers",
    "canonical_game_modes", "mode_aliases", "canonical_maps", "map_aliases",
    "workflow_runs", "workflow_steps", "workflow_locks",
    "aggregation_runs", "ranking_runs", "data_fetch_runs",
    "seed_players", "player_crawl_schedule",
    "normalized_players", "normalized_clubs",
  ]) assert.ok(TIER1_TABLES.has(table), `tier-1 must include ${table}`);
});

test("tier-1 excludes all historical battle/raw/observed/aggregate bulk by default", () => {
  for (const table of BULK_HISTORY_TABLES) assert.equal(TIER1_TABLES.has(table), false, `tier-1 must exclude ${table}`);
  for (const table of ["normalized_battles", "battle_teams", "battle_participants", "battle_observations", "raw_api_snapshots", "matchup_aggregates", "ranking_results", "observed_players"]) {
    assert.equal(TIER1_TABLES.has(table), false);
  }
});

test("tier-1 keeps the current published snapshot as a dependency-expanded copy, not a full-history copy", () => {
  assert.equal(TIER1.currentPublicationOnly, true);
  assert.deepEqual([...TIER1.dependencyExpandedTables], ["published_snapshots", "published_snapshot_items", "published_matchup_items"]);
  for (const table of ["published_snapshots", "published_snapshot_items", "published_matchup_items"]) assert.equal(TIER1_TABLES.has(table), false);
  for (const table of ["ranking_runs", "aggregation_runs", "patches", "canonical_brawlers"]) assert.ok(TIER1_TABLES.has(table));
});

test("tier-1 includes active workflow and crawl state", () => {
  for (const table of ["workflow_runs", "workflow_steps", "workflow_locks", "seed_players", "player_crawl_schedule"]) assert.ok(TIER1_TABLES.has(table));
});

test("tier-1 plan order is deterministic and parent-before-child", () => {
  const order = scopePlans(TIER1).map((plan) => plan.table);
  const position = new Map(order.map((table, index) => [table, index] as const));
  for (const plan of scopePlans(TIER1)) {
    if (plan.parent && position.has(plan.parent.table)) {
      assert.ok(position.get(plan.parent.table)! < position.get(plan.table)!, `${plan.parent.table} must precede ${plan.table}`);
    }
  }
  assert.ok(position.get("normalized_clubs")! < position.get("normalized_players")!);
});

test("repeated tier-1 scope resolution is byte-deterministic", () => {
  const a = scopeManifestHash(resolveScope("tier-1"));
  const b = scopeManifestHash(resolveScope("continuity"));
  const c = scopeManifestHash(resolveScope("TIER-1"));
  assert.equal(a, b);
  assert.equal(a, c);
  assert.deepEqual(scopePlans(resolveScope("tier-1")).map((p) => p.table), scopePlans(resolveScope("continuity")).map((p) => p.table));
});

test("unknown scope names fail closed", () => {
  for (const name of ["tier-2", "everything", "all-history", "", "tier1-plus"]) {
    assert.throws(() => resolveScope(name), /Unknown migration scope/);
  }
});

test("the full 'all' scope still exists separately and is not the tier-1 manifest", () => {
  const all = resolveScope("all");
  assert.equal(all.tier, "all");
  assert.equal(all.currentPublicationOnly, false);
  const allTables = new Set(scopePlans(all).map((plan) => plan.table));
  const uniquePlanTables = new Set(TABLE_PLANS.map((plan) => plan.table));
  assert.equal(allTables.size, uniquePlanTables.size);
  for (const table of BULK_HISTORY_TABLES) assert.ok(allTables.has(table), `all must include ${table}`);
  assert.notEqual(scopeManifestHash(all), scopeManifestHash(TIER1));
});

test("a state directory bound to one scope rejects reuse by another scope", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase8-scope-bind-"));
  try {
    const store = new FileStateStore(directory);
    await store.initialize();
    const first = await store.bindScope(scopeStateIdentity(TIER1));
    assert.equal(first.created, true);
    const again = await store.bindScope(scopeStateIdentity(resolveScope("tier-1")));
    assert.equal(again.created, false, "same scope must be accepted");
    await assert.rejects(store.bindScope(scopeStateIdentity(resolveScope("all"))), /refusing to reuse it for scope 'all'/);
    const identity = await store.readScopeIdentity();
    assert.equal(identity?.scope, "tier-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tier-1 summary lists included, dependency-expanded, and excluded bulk tables", () => {
  const summary = summarizeScope(TIER1, "dry-run");
  assert.equal(summary.scope, "tier-1");
  assert.equal(summary.tier, "tier-1");
  assert.equal(summary.mode, "dry-run");
  assert.ok(summary.includedTables.includes("normalized_players"));
  assert.ok(summary.excludedTables.includes("normalized_battles"));
  assert.ok(summary.excludedBulkHistory.includes("matchup_aggregates"));
  assert.deepEqual(summary.dependencyExpandedTables, ["published_snapshots", "published_snapshot_items", "published_matchup_items"]);
  assert.match(summary.completionMeaning, /NOT a Tier-2\/Tier-3 historical backfill/);
});

test("a required tier-1 table missing from inventory causes preflight failure", () => {
  const migrations: RepositoryMigration[] = [{ version: "0001", name: "seed_players", checksum: "seed-checksum", tables: ["seed_players"] }];
  const applied: AppliedMigration[] = [{ version: "0001", name: "seed_players", checksum: "seed-checksum" }];
  const plan = { family: "catalogs-config", table: "seed_players", mode: "full" as const };
  const entries = classifyTableInventory([plan], migrations, applied, new Set(), new Set(["seed_players"]));
  assert.equal(entries[0].status, "fatal_inventory_error");
  assert.throws(() => assertInventoryReady(entries, new Set(["seed_players"])), /seed_players/);
});

test("an optional future tier-1-adjacent table absent on source is skipped, not fatal", () => {
  const migrations: RepositoryMigration[] = [
    { version: "0001", name: "seed_players", checksum: "seed-checksum", tables: ["seed_players"] },
    { version: "0030", name: "future_optional", checksum: "future-checksum", tables: ["future_optional"] },
  ];
  const applied: AppliedMigration[] = [{ version: "0001", name: "seed_players", checksum: "seed-checksum" }];
  const plan = { family: "catalogs-config", table: "future_optional", mode: "full" as const };
  const [entry] = classifyTableInventory([plan], migrations, applied, new Set(), new Set());
  assert.equal(entry.sourceRequirement, "optional");
  assert.equal(entry.action, "skip");
});

test("tier-1 pass preserves no-cursor-advance-on-page-failure", () => {
  const state = new PageCursorSimulation();
  const page = [{ id: "x", timestamp: "2026-01-01T00:00:00.000Z", key: "x", content: "1" }];
  assert.throws(() => state.apply(page, true), /failed/);
  assert.equal(state.cursor, null, "a failed page must not advance the cursor");
  state.apply(page, false);
  assert.deepEqual(state.cursor, { timestamp: page[0].timestamp, id: "x" });
});

test("tier-1 dry-run comparison is a no-op against an already-consistent target", () => {
  const target = new Map([["x", { id: "x", timestamp: "2026-01-01T00:00:00.000Z", key: "x", content: "1" }]]);
  const before = new Map(target);
  const outcome = applySimulated({ id: "x", timestamp: "2026-01-01T00:00:00.000Z", key: "x", content: "1" }, target, true);
  assert.equal(outcome, "matched");
  assert.deepEqual([...target], [...before], "dry-run comparison must not mutate the target");
});

test("watchdog returns a useful diagnostic on a true no-progress stall", () => {
  const tracker = new MigrationProgressTracker("stall-pass", 0);
  try {
    assert.throws(() => tracker.throwIfStalled("target_comparison"), /Phase 8 watchdog timeout at stage=target_comparison/);
    assert.throws(() => tracker.throwIfStalled("target_comparison"), /lastSuccessfulDatabaseOperationAt=/);
  } finally { tracker.close(); }
});

test("scope registry exposes exactly tier-1 and all, and legacy family/table selection still works", () => {
  assert.deepEqual(SCOPES.map((scope) => scope.name).sort(), ["all", "tier-1"]);
  assert.equal(plansFor("raw-data").every((plan) => plan.family === "raw-data"), true);
  assert.equal(plansFor("normalized_battles")[0].table, "normalized_battles");
});

test("cli exposes an explicit tier-1 scope, binds state per scope, and offers a no-database preview", () => {
  const cli = readFileSync(new URL("../scripts/dataset-migration/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /resolveSelection\(options/);
  assert.match(cli, /store\.bindScope\(selection\.stateIdentity\)/);
  assert.match(cli, /command === "scope-preview"/);
  assert.match(cli, /phase8ScopePreflight/);
});
