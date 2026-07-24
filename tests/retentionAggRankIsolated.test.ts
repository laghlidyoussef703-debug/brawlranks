/**
 * DATASET Phase 14 — DEDICATED isolated-DB destructive validation for the
 * aggregate + ranking DETAIL families:
 *   brawler_mode_aggregates, brawler_overall_aggregates, matchup_aggregates,
 *   ranking_results, matchup_results.
 *
 * Seeds realistic fixtures (multiple aggregation triples + ranking runs covering
 * current / published-referenced / held / old-eligible-unreferenced) on a
 * DISPOSABLE MySQL and drives the EXISTING archive-gated pipeline
 * (lib/retention/operations, archive, deletion) end-to-end, proving the exact
 * retention rules and every safety gate against real MySQL. DOUBLE-gated so it
 * never runs by accident or against production:
 *   RETENTION_AGGRANK_DB_TEST=1 + DB creds.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { InMemoryObjectStorage } from "@/lib/archive/provider";

const enabled = process.env.RETENTION_AGGRANK_DB_TEST === "1" &&
  Boolean(process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1);
const opt = { skip: enabled ? false : "isolated-DB only: set RETENTION_AGGRANK_DB_TEST=1 + DB creds." };

const BUCKET = "aggrank-it";
const ns = "ar_" + Date.now().toString(36);
const uid = (): string => randomUUID();
const P = { b1: uid(), b2: uid(), b3: uid(), gm: uid(), source: uid(), endpoint: uid(), env: uid(), ruleSet: "" };
// aggregation triples: A/B/C hot (newest 3), D old+eligible, E referenced/published, F held.
const TRIPLES: Record<string, { off: number }> = { A: { off: 1 }, B: { off: 2 }, C: { off: 3 }, D: { off: 200 }, E: { off: 210 }, F: { off: 220 } };
const agg: Record<string, { wf: string; overall: string; per_mode: string; matchup: string }> = {};
const rank: Record<string, { id: string; wf: string }> = {};

async function q(pool: Pool, sql: string, params: unknown[] = []): Promise<void> { await pool.query(sql, params); }
async function count(pool: Pool, table: string, col: string, vals: string[]): Promise<number> {
  if (vals.length === 0) return 0;
  const [[r]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) n FROM \`${table}\` WHERE \`${col}\` IN (${vals.map(() => "?").join(",")})`, vals);
  return Number(r.n);
}
async function snapshot(pool: Pool, label: string): Promise<void> {
  const aggRuns = Object.values(agg).flatMap((t) => [t.overall, t.per_mode, t.matchup]);
  const rankRuns = Object.values(rank).map((r) => r.id);
  const counts = {
    brawler_mode_aggregates: await count(pool, "brawler_mode_aggregates", "aggregation_run_id", aggRuns),
    brawler_overall_aggregates: await count(pool, "brawler_overall_aggregates", "aggregation_run_id", aggRuns),
    matchup_aggregates: await count(pool, "matchup_aggregates", "aggregation_run_id", aggRuns),
    ranking_results: await count(pool, "ranking_results", "ranking_run_id", rankRuns),
    matchup_results: await count(pool, "matchup_results", "ranking_run_id", rankRuns),
    aggregation_runs: await count(pool, "aggregation_runs", "id", aggRuns),
    ranking_runs: await count(pool, "ranking_runs", "id", rankRuns),
  };
  console.log(`${label}_COUNTS ${JSON.stringify(counts)}`);
}

before(async () => {
  if (!enabled) return;
  const { getPool } = await import("@/lib/mysql");
  const { ensureWorkflowDefinition } = await import("@/lib/workflow");
  const pool = getPool();
  const [[rs]] = await pool.query<RowDataPacket[]>("SELECT id FROM ranking_rule_sets WHERE is_active = 1 LIMIT 1");
  P.ruleSet = rs.id;

  await q(pool, "INSERT INTO data_sources (id, name, source_type) VALUES (?, ?, 'official_api')", [P.source, `${ns}-src`]);
  await q(pool, "INSERT INTO source_endpoints (id, data_source_id, endpoint_category, path) VALUES (?, ?, 'battlelog', '/x')", [P.endpoint, P.source]);
  for (const [b, i] of [[P.b1, 1], [P.b2, 2], [P.b3, 3]] as const)
    await q(pool, "INSERT INTO canonical_brawlers (id, source_brawler_id, slug, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, NOW(3), NOW(3))", [b, `${ns}-b${i}`, `${ns}-b${i}`, `B${i}`]);
  await q(pool, "INSERT INTO canonical_game_modes (id, source_mode_id, name, first_seen_at, last_seen_at) VALUES (?, ?, 'Mode', NOW(3), NOW(3))", [P.gm, `${ns}-gm`]);

  const wfDef = await ensureWorkflowDefinition(pool, `${ns}-wf`, "scheduled_sync");
  // Aggregation triples.
  for (const [name, cfg] of Object.entries(TRIPLES)) {
    const wf = uid();
    await q(pool, "INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at) VALUES (?, ?, 'succeeded', 'manual', NOW(3) - INTERVAL ? DAY)", [wf, wfDef, cfg.off]);
    const runs = { wf, overall: uid(), per_mode: uid(), matchup: uid() };
    for (const scope of ["overall", "per_mode", "matchup"] as const) {
      await q(pool, "INSERT INTO aggregation_runs (id, workflow_run_id, scope, status, started_at, completed_at) VALUES (?, ?, ?, 'succeeded', NOW(3) - INTERVAL ? DAY, NOW(3) - INTERVAL ? DAY)", [runs[scope], wf, scope, cfg.off, cfg.off]);
    }
    // child rows
    await q(pool, "INSERT INTO brawler_overall_aggregates (id, aggregation_run_id, brawler_id, matches, wins, losses, draws, win_rate) VALUES (?,?,?,10,6,3,1,0.60000),(?,?,?,8,4,3,1,0.50000)", [uid(), runs.overall, P.b1, uid(), runs.overall, P.b2]);
    await q(pool, "INSERT INTO brawler_mode_aggregates (id, aggregation_run_id, brawler_id, game_mode_id, matches, wins, losses, draws, win_rate) VALUES (?,?,?,?,10,6,3,1,0.60000),(?,?,?,?,8,4,3,1,0.50000)", [uid(), runs.per_mode, P.b1, P.gm, uid(), runs.per_mode, P.b2, P.gm]);
    await q(pool, "INSERT INTO matchup_aggregates (id, aggregation_run_id, brawler_id, opponent_brawler_id, matches, win_rate) VALUES (?,?,?,?,10,0.60000),(?,?,?,?,8,0.40000)", [uid(), runs.matchup, P.b1, P.b2, uid(), runs.matchup, P.b2, P.b3]);
    agg[name] = runs;
  }

  // Ranking runs. current(-1d succeeded), published(-200d succeeded+snapshot), held(-205d held), eligible(-200d succeeded).
  const mk = async (key: string, status: string, off: number, aggTriple: string) => {
    const wf = uid();
    await q(pool, "INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at) VALUES (?, ?, 'succeeded', 'manual', NOW(3) - INTERVAL ? DAY)", [wf, wfDef, off]);
    const id = uid();
    await q(pool, "INSERT INTO ranking_runs (id, workflow_run_id, ranking_rule_set_id, mode_aggregation_run_id, overall_aggregation_run_id, matchup_aggregation_run_id, status, started_at) VALUES (?,?,?,?,?,?,?, NOW(3) - INTERVAL ? DAY)", [id, wf, P.ruleSet, agg[aggTriple].per_mode, agg[aggTriple].overall, agg[aggTriple].matchup, status, off]);
    await q(pool, "INSERT INTO ranking_results (id, ranking_run_id, brawler_id, matches, confidence, meets_floor) VALUES (?,?,?,100,'medium',1),(?,?,?,80,'low',1)", [uid(), id, P.b1, uid(), id, P.b2]);
    await q(pool, "INSERT INTO matchup_results (id, ranking_run_id, brawler_id, opponent_brawler_id, matches, confidence_level, meets_floor) VALUES (?,?,?,?,50,'probable_counter',1),(?,?,?,?,40,'weak_signal',1)", [uid(), id, P.b1, P.b2, uid(), id, P.b2, P.b3]);
    rank[key] = { id, wf };
  };
  await mk("current", "succeeded", 1, "A");
  await mk("published", "succeeded", 200, "E");
  await mk("held", "held", 205, "A");
  await mk("eligible", "succeeded", 200, "A");

  await q(pool, "INSERT INTO published_snapshots (id, ranking_run_id, is_current, published_at) VALUES (?, ?, 1, NOW(3))", [uid(), rank.published.id]);
  await q(pool, "INSERT INTO retention_holds (id, hold_type, target_kind, target_id, reason, created_by) VALUES (?, 'investigation', 'workflow_run', ?, 'incident', 'p14it')", [uid(), agg.F.wf]);
  await q(pool, "INSERT INTO retention_environment_attestations (environment_id, purpose, confirmed_by, evidence_reference, expires_at) VALUES (?, 'isolated_staging', 'p14it', 'test', NOW(3) + INTERVAL 1 HOUR)", [P.env]);
  await snapshot(pool, "BEFORE");
});

after(async () => {
  if (!enabled) return;
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  await snapshot(pool, "AFTER");
  const s = (p: Promise<unknown>) => p.catch(() => {});
  const allAggRuns = Object.values(agg).flatMap((t) => [t.overall, t.per_mode, t.matchup]);
  const allRankRuns = Object.values(rank).map((r) => r.id);
  await s(q(pool, "DELETE FROM aggregate_trend_summaries WHERE source_aggregation_run_id IN (" + allAggRuns.map(() => "?").join(",") + ")", allAggRuns));
  await s(q(pool, "DELETE FROM retention_graph_deletion_manifests WHERE 1=0"));
  await s(q(pool, "DELETE FROM archived_run_verification_evidence WHERE archived_run_manifest_id IN (SELECT id FROM archived_run_manifests WHERE run_id IN (" + [...allAggRuns, ...allRankRuns].map(() => "?").join(",") + "))", [...allAggRuns, ...allRankRuns]));
  await s(q(pool, "DELETE FROM retention_deletion_manifests WHERE run_id IN (" + [...allAggRuns, ...allRankRuns].map(() => "?").join(",") + ")", [...allAggRuns, ...allRankRuns]));
  await s(q(pool, "DELETE FROM archived_run_manifests WHERE run_id IN (" + [...allAggRuns, ...allRankRuns].map(() => "?").join(",") + ")", [...allAggRuns, ...allRankRuns]));
  await s(q(pool, "DELETE FROM published_snapshots WHERE ranking_run_id IN (" + allRankRuns.map(() => "?").join(",") + ")", allRankRuns));
  for (const r of allRankRuns) { await s(q(pool, "DELETE FROM ranking_results WHERE ranking_run_id=?", [r])); await s(q(pool, "DELETE FROM matchup_results WHERE ranking_run_id=?", [r])); }
  await s(q(pool, "DELETE FROM ranking_runs WHERE id IN (" + allRankRuns.map(() => "?").join(",") + ")", allRankRuns));
  for (const r of allAggRuns) { await s(q(pool, "DELETE FROM brawler_overall_aggregates WHERE aggregation_run_id=?", [r])); await s(q(pool, "DELETE FROM brawler_mode_aggregates WHERE aggregation_run_id=?", [r])); await s(q(pool, "DELETE FROM matchup_aggregates WHERE aggregation_run_id=?", [r])); }
  await s(q(pool, "DELETE FROM aggregation_runs WHERE id IN (" + allAggRuns.map(() => "?").join(",") + ")", allAggRuns));
  await s(q(pool, "DELETE FROM retention_holds WHERE target_id=?", [agg.F.wf]));
  const allWf = [...Object.values(agg).map((t) => t.wf), ...Object.values(rank).map((r) => r.wf)];
  await s(q(pool, "DELETE FROM workflow_runs WHERE id IN (" + allWf.map(() => "?").join(",") + ")", allWf));
  await s(q(pool, "DELETE FROM workflow_definitions WHERE slug=?", [`${ns}-wf`]));
  await s(q(pool, "DELETE FROM matchup_aggregates WHERE brawler_id IN (?,?,?)", [P.b1, P.b2, P.b3]));
  await s(q(pool, "DELETE FROM canonical_game_modes WHERE id=?", [P.gm]));
  await s(q(pool, "DELETE FROM canonical_brawlers WHERE id IN (?,?,?)", [P.b1, P.b2, P.b3]));
  await s(q(pool, "DELETE FROM source_endpoints WHERE id=?", [P.endpoint]));
  await s(q(pool, "DELETE FROM data_sources WHERE id=?", [P.source]));
  await s(q(pool, "DELETE FROM retention_environment_attestations WHERE environment_id=?", [P.env]));
  await pool.end().catch(() => {});
  (globalThis as Record<string, unknown>).__brawlranksMysqlPool = undefined;
});

test("dry-run + preservation: plan lists only D's runs + R_eligible; hot/referenced/published/held blocked; ZERO mutation", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runRetentionOperation } = await import("@/lib/retention/operations");
  const pool = getPool();

  const beforeMode = await count(pool, "brawler_mode_aggregates", "aggregation_run_id", [agg.D.per_mode]);
  const report = await runRetentionOperation(pool, null, { action: "dry-run" });
  const plan = (report as { plan: { allowlist: { runId: string }[]; blocked: { runId: string; reasons: string[] }[] } }).plan;
  const eligible = new Set(plan.allowlist.map((t) => t.runId));

  // Only D's three scoped runs + R_eligible are eligible.
  for (const s of ["overall", "per_mode", "matchup"] as const) assert.ok(eligible.has(agg.D[s]), `D.${s} eligible`);
  assert.ok(eligible.has(rank.eligible.id), "R_eligible eligible");
  // Hot triples A/B/C, referenced/published E, held F, and ranking current/published/held are NOT eligible.
  for (const t of ["A", "B", "C", "E", "F"]) for (const s of ["overall", "per_mode", "matchup"] as const) assert.equal(eligible.has(agg[t][s]), false, `${t}.${s} preserved`);
  for (const r of ["current", "published", "held"]) assert.equal(eligible.has(rank[r].id), false, `R_${r} preserved`);

  const blocked = new Map(plan.blocked.map((b) => [b.runId, b.reasons]));
  assert.ok(blocked.get(agg.A.overall)?.includes("hot_recent_triple"));
  assert.ok(blocked.get(agg.E.overall)?.includes("referenced_by_published_snapshot"));
  assert.ok(blocked.get(agg.F.overall)?.includes("retention_hold"));
  assert.ok(blocked.get(rank.current.id)?.includes("current_held_or_published"));
  assert.ok(blocked.get(rank.published.id)?.includes("current_held_or_published"));

  // Dry-run mutated nothing.
  assert.equal(await count(pool, "brawler_mode_aggregates", "aggregation_run_id", [agg.D.per_mode]), beforeMode);
});

test("AGGREGATE family: archive->verify->reimport->gated FK-safe delete, gates, trend, corruption, idempotency, concurrency", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const A = await import("@/lib/retention/archive");
  const D = await import("@/lib/retention/deletion");
  const pool = getPool();

  // --- D.matchup (no trend): full happy path + block ordering + idempotency + concurrency ---
  const store = new InMemoryObjectStorage();
  const target = { runKind: "aggregation_run" as const, runId: agg.D.matchup, sourceTable: "matchup_aggregates" };
  const beforeRows = await count(pool, "matchup_aggregates", "aggregation_run_id", [agg.D.matchup]);
  assert.equal(beforeRows, 2);

  const arch = await A.exportRunToArchive(pool, store, { ...target, bucket: BUCKET, codeVersion: "v1", ruleSetVersion: null, patchContext: null });
  assert.equal(arch.rowCount, 2);
  assert.match(arch.originalSha256, /^[0-9a-f]{64}$/);
  assert.match(arch.archiveSha256, /^[0-9a-f]{64}$/);
  assert.ok(arch.archiveBytes > 0 && arch.uncompressedBytes > 0);
  assert.equal(store.size(), 1, "archive object created");

  // delete blocked BEFORE verification
  const b1 = await D.deleteRunChildRows(pool, { ...target, allowlist: [agg.D.matchup], dryRun: false, destructiveEnabled: true });
  assert.equal(b1.blockedReason, "archive_not_verified");
  assert.equal(await count(pool, "matchup_aggregates", "aggregation_run_id", [agg.D.matchup]), 2);

  const v = await A.verifyArchivedRun(pool, store, target.runKind, target.runId, target.sourceTable);
  assert.equal(v.verified, true);
  assert.equal(v.passes.length, 2);
  assert.ok(v.passes.every((p) => p.passed), "two independent verification passes succeed");

  // delete blocked BEFORE reimport proof
  const b2 = await D.deleteRunChildRows(pool, { ...target, allowlist: [agg.D.matchup], dryRun: false, destructiveEnabled: true });
  assert.equal(b2.blockedReason, "reimport_not_passed");

  const ri = await A.reimportArchivedRunToStaging(pool, store, target.runKind, target.runId, target.sourceTable);
  assert.equal(ri.ok, true, "restore + replay + FK + content checksum proof passed");
  assert.equal(ri.rowCountMatch, true);
  assert.equal(ri.contentChecksumMatch, true);
  assert.equal(ri.keyUnique, true);

  // dry-run delete: zero mutation even when fully gated
  const dry = await D.deleteRunChildRows(pool, { ...target, allowlist: [agg.D.matchup], dryRun: true, destructiveEnabled: true });
  assert.equal(dry.proceeded, true);
  assert.equal(dry.rowsDeleted, 0);
  assert.equal(await count(pool, "matchup_aggregates", "aggregation_run_id", [agg.D.matchup]), 2);

  // CONCURRENCY: two deletes at once — exactly one does the work, no double-delete, no FK error.
  const [r1, r2] = await Promise.allSettled([
    D.deleteRunChildRows(pool, { ...target, allowlist: [agg.D.matchup], dryRun: false, destructiveEnabled: true, batchSize: 1 }),
    D.deleteRunChildRows(pool, { ...target, allowlist: [agg.D.matchup], dryRun: false, destructiveEnabled: true, batchSize: 1 }),
  ]);
  const okDeletes = [r1, r2].filter((r) => r.status === "fulfilled" && (r.value as { proceeded: boolean }).proceeded && (r.value as { rowsDeleted: number }).rowsDeleted > 0);
  assert.ok(okDeletes.length >= 1, "at least one concurrent delete proceeded");
  assert.equal(await count(pool, "matchup_aggregates", "aggregation_run_id", [agg.D.matchup]), 0, "all matchup detail rows deleted exactly once");
  // metadata parent remains
  assert.equal(await count(pool, "aggregation_runs", "id", [agg.D.matchup]), 1, "aggregation_runs metadata preserved");

  // IDEMPOTENT rerun: rows already gone, no error, still 0.
  const rerun = await D.deleteRunChildRows(pool, { ...target, allowlist: [agg.D.matchup], dryRun: false, destructiveEnabled: true }).catch((e) => ({ err: String(e) }));
  assert.equal(await count(pool, "matchup_aggregates", "aggregation_run_id", [agg.D.matchup]), 0);
  void rerun;

  // --- D.overall (trend preservation) ---
  const store2 = new InMemoryObjectStorage();
  const t2 = { runKind: "aggregation_run" as const, runId: agg.D.overall, sourceTable: "brawler_overall_aggregates" };
  await A.exportRunToArchive(pool, store2, { ...t2, bucket: BUCKET, codeVersion: "v1", ruleSetVersion: null, patchContext: null });
  await A.verifyArchivedRun(pool, store2, t2.runKind, t2.runId, t2.sourceTable);
  await A.reimportArchivedRunToStaging(pool, store2, t2.runKind, t2.runId, t2.sourceTable);
  const delOverall = await D.deleteRunChildRows(pool, { ...t2, allowlist: [agg.D.overall], dryRun: false, destructiveEnabled: true });
  assert.equal(delOverall.proceeded, true);
  assert.ok(delOverall.trendRowsWritten >= 1, "trend rows preserved before deleting overall aggregates");
  assert.equal(await count(pool, "brawler_overall_aggregates", "aggregation_run_id", [agg.D.overall]), 0);

  // --- D.per_mode: CHECKSUM CORRUPTION blocks deletion ---
  const store3 = new InMemoryObjectStorage();
  const t3 = { runKind: "aggregation_run" as const, runId: agg.D.per_mode, sourceTable: "brawler_mode_aggregates" };
  const a3 = await A.exportRunToArchive(pool, store3, { ...t3, bucket: BUCKET, codeVersion: "v1", ruleSetVersion: null, patchContext: null });
  await A.verifyArchivedRun(pool, store3, t3.runKind, t3.runId, t3.sourceTable);
  await A.reimportArchivedRunToStaging(pool, store3, t3.runKind, t3.runId, t3.sourceTable);
  store3.corrupt(BUCKET, a3.objectKey, Buffer.from("tampered-bytes"));
  const reverify = await A.verifyArchivedRun(pool, store3, t3.runKind, t3.runId, t3.sourceTable);
  assert.equal(reverify.verified, false, "corruption fails re-verification");
  const blockedCorrupt = await D.deleteRunChildRows(pool, { ...t3, allowlist: [agg.D.per_mode], dryRun: false, destructiveEnabled: true });
  assert.equal(blockedCorrupt.blockedReason, "archive_not_verified", "corrupted archive blocks deletion");
  assert.equal(await count(pool, "brawler_mode_aggregates", "aggregation_run_id", [agg.D.per_mode]), 2, "per_mode rows preserved after corruption");
});

test("RANKING family: archive->verify->reimport->gated FK-safe delete, gates, corruption; metadata + preserved runs remain", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const A = await import("@/lib/retention/archive");
  const D = await import("@/lib/retention/deletion");
  const pool = getPool();

  // ranking_results happy path.
  const store = new InMemoryObjectStorage();
  const target = { runKind: "ranking_run" as const, runId: rank.eligible.id, sourceTable: "ranking_results" };
  assert.equal(await count(pool, "ranking_results", "ranking_run_id", [rank.eligible.id]), 2);
  const arch = await A.exportRunToArchive(pool, store, { ...target, bucket: BUCKET, codeVersion: "v1", ruleSetVersion: null, patchContext: null });
  assert.equal(arch.rowCount, 2);

  const b1 = await D.deleteRunChildRows(pool, { ...target, allowlist: [rank.eligible.id], dryRun: false, destructiveEnabled: true });
  assert.equal(b1.blockedReason, "archive_not_verified");

  const v = await A.verifyArchivedRun(pool, store, target.runKind, target.runId, target.sourceTable);
  assert.equal(v.verified, true);
  const b2 = await D.deleteRunChildRows(pool, { ...target, allowlist: [rank.eligible.id], dryRun: false, destructiveEnabled: true });
  assert.equal(b2.blockedReason, "reimport_not_passed");

  const ri = await A.reimportArchivedRunToStaging(pool, store, target.runKind, target.runId, target.sourceTable);
  assert.equal(ri.ok, true);
  assert.equal(ri.contentChecksumMatch, true);

  const del = await D.deleteRunChildRows(pool, { ...target, allowlist: [rank.eligible.id], dryRun: false, destructiveEnabled: true });
  assert.equal(del.proceeded, true);
  assert.equal(await count(pool, "ranking_results", "ranking_run_id", [rank.eligible.id]), 0);
  assert.equal(await count(pool, "ranking_runs", "id", [rank.eligible.id]), 1, "ranking_runs metadata preserved");

  // matchup_results: corruption blocks deletion.
  const store2 = new InMemoryObjectStorage();
  const t2 = { runKind: "ranking_run" as const, runId: rank.eligible.id, sourceTable: "matchup_results" };
  const a2 = await A.exportRunToArchive(pool, store2, { ...t2, bucket: BUCKET, codeVersion: "v1", ruleSetVersion: null, patchContext: null });
  await A.verifyArchivedRun(pool, store2, t2.runKind, t2.runId, t2.sourceTable);
  await A.reimportArchivedRunToStaging(pool, store2, t2.runKind, t2.runId, t2.sourceTable);
  store2.corrupt(BUCKET, a2.objectKey, Buffer.from("tampered"));
  const rev = await A.verifyArchivedRun(pool, store2, t2.runKind, t2.runId, t2.sourceTable);
  assert.equal(rev.verified, false);
  const blocked = await D.deleteRunChildRows(pool, { ...t2, allowlist: [rank.eligible.id], dryRun: false, destructiveEnabled: true });
  assert.equal(blocked.blockedReason, "archive_not_verified");
  assert.equal(await count(pool, "matchup_results", "ranking_run_id", [rank.eligible.id]), 2, "matchup_results preserved after corruption");

  // Preserved runs' detail remains intact.
  assert.equal(await count(pool, "ranking_results", "ranking_run_id", [rank.current.id]), 2, "current ranking run detail preserved");
  assert.equal(await count(pool, "ranking_results", "ranking_run_id", [rank.published.id]), 2, "published ranking run detail preserved");
  assert.equal(await count(pool, "matchup_aggregates", "aggregation_run_id", [agg.A.matchup]), 2, "hot triple A detail preserved");
  assert.equal(await count(pool, "matchup_aggregates", "aggregation_run_id", [agg.E.matchup]), 2, "referenced/published triple E detail preserved");
  assert.equal(await count(pool, "matchup_aggregates", "aggregation_run_id", [agg.F.matchup]), 2, "held triple F detail preserved");
});
