import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applySimulated, advanceReadiness, childCountHash, compositePage, fixedWatermark, overlapStart, PageCursorSimulation, reconcileEphemeral } from "../scripts/dataset-migration/simulation";
import { FAMILY_ORDER, plansFor, TABLE_PLANS } from "../scripts/dataset-migration/model";
import { assertDifferentDatabases, redactSecrets, resolveEndpoint } from "../scripts/dataset-migration/config";

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
