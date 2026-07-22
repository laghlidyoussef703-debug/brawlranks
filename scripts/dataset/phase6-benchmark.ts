#!/usr/bin/env -S tsx
/**
 * DATASET Phase 6.5 — benchmark harness (manual / one-off; disposable DB only).
 *
 * Self-provisions minimal synthetic prerequisites in a LOCAL, DISPOSABLE MySQL
 * 8.4 database so every required Phase 6 benchmark path is actually MEASURED
 * with non-zero results, using the REAL production code paths (never fabricated
 * SQL for the measured operation):
 *   1. battle-log write txn latency (warmup + p50/p95/p99) — insertNormalizedBattle
 *   2. public tier-list read latency (p50/p95) — getCurrentSnapshotMeta +
 *      getCurrentPublishedBrawlers (the /api/public/tier-list repository reads),
 *      after creating a minimal synthetic current published snapshot with items
 *   3. aggregation batchSize 8 (duration/outcome/counts) — runAggregation
 *   4. ranking rebuild batchSize 8 (duration/outcome/counts) — runRankingRebuild
 *      (run AFTER aggregation so it evaluates > 0 candidates)
 *   5. archive claim/update (p50/p95, NO payload deletion) — enqueue/claim/verify,
 *      against synthetic archive-eligible raw snapshots the harness creates
 *   6. dump + restore throughput — a real local MySQL 8.4 dump of the benchmark
 *      DB (measured), restored into a disposable temp DB (measured)
 *
 * FAILS (exit 1) if any required path is skipped, aggregation processed 0,
 * ranking evaluated 0, public tier-list returns 0 items, archive is not
 * measured, or dump throughput is not measured.
 *
 * SAFETY (fail closed): refuses non-loopback DB_HOST and production-marker
 * DB_NAME. No external API/network/proxy calls. No schema/migration change
 * (SET FOREIGN_KEY_CHECKS is a session var used only to scope cleanup). Cleans
 * up only rows this benchmark created (tracked IDs + created_at >= run-start).
 *
 * Usage (local disposable DB only — never a production credential):
 *   DB_HOST=127.0.0.1 DB_PORT=3308 DB_NAME=brawlranks_it_test DB_USER=root \
 *   BRAWL_DB_SECRET_V1=<local> PHASE6_DOCKER_CONTAINER=brawlranks-mysql84test \
 *   npx tsx scripts/dataset/phase6-benchmark.ts
 */

import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { getPool } from "../../lib/mysql";
import { getDataSourceByName, getSourceEndpoint, createFetchRun, insertCanonicalBrawler } from "../../lib/catalog/repository";
import { getOrCreateGameMode, ensurePlayerStub, insertNormalizedBattle, getBattleTeamIds, upsertBattleParticipant } from "../../lib/ingestion/repository";
import { getCurrentSnapshotMeta, getCurrentPublishedBrawlers } from "../../lib/publishedSnapshots/repository";
import { runAggregation } from "../../lib/aggregation/sync";
import { runRankingRebuild } from "../../lib/ranking/sync";
import { enqueuePendingArchives, claimNextArchive, markArchiveVerified } from "../../lib/archive/repository";

const PRODUCTION_MARKERS = ["u350003894", "brawl2", "prod", "production", "live"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function refuse(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}
function assertDisposableTarget(): void {
  const host = process.env.DB_HOST ?? "";
  const name = (process.env.DB_NAME ?? "").toLowerCase();
  if (!LOOPBACK.has(host)) refuse(`DB_HOST "${host}" is not loopback.`);
  if (!name) refuse("DB_NAME is required.");
  for (const marker of PRODUCTION_MARKERS) if (name.includes(marker)) refuse(`DB_NAME contains production marker "${marker}".`);
  if ((process.env.APP_ENV ?? process.env.NODE_ENV ?? "").toLowerCase() === "production") refuse("NODE_ENV/APP_ENV is production.");
}

const round = (x: number): number => Math.round(x * 1000) / 1000;
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
function latencyStats(samplesMs: number[]): Record<string, number> {
  const s = [...samplesMs].sort((a, b) => a - b);
  return { n: s.length, minMs: round(s[0]), p50Ms: round(percentile(s, 50)), p95Ms: round(percentile(s, 95)), p99Ms: round(percentile(s, 99)), maxMs: round(s[s.length - 1]) };
}
async function timedMs<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

const PROVISIONAL_SLO = {
  note: "PROVISIONAL local single-node sanity thresholds only — NOT the production DigitalOcean SLO (owner approval pending; DATASET.md Phase 6.5 / open question 10).",
  battleWriteTxnP95Ms: 75, battleWriteTxnP99Ms: 150, publicTierListReadP95Ms: 75, archiveClaimUpdateP95Ms: 75,
};

const ITER = Number(process.env.BENCH_ITER ?? 200);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 20);
const BRAWLER_COUNT = Number(process.env.BENCH_BRAWLERS ?? 10);
const RESTORE_EVIDENCE_GB = Number(process.env.RESTORE_DUMP_GB ?? 1.15);
const RESTORE_EVIDENCE_SECONDS = Number(process.env.RESTORE_SECONDS ?? 26 * 60 + 19);

interface BenchOutput {
  status: "ok" | "fail" | "skipped_missing_prerequisite";
  sloVerdict?: "PASS" | "FAIL" | "N/A";
  [k: string]: unknown;
}

/** Tracks every base row this benchmark inserts, for scoped cleanup. */
interface Created {
  dataSourceId?: string;
  endpointId?: string;
  fetchRunIds: string[];
  brawlerIds: string[];
  gameModeIds: string[];
  playerIds: string[];
  battleIds: string[];
  rawSnapshotIds: string[];
  archiveBucket?: string;
  benchStartSql?: string;
}

async function scalarQuery(pool: Pool, sql: string, params: unknown[] = []): Promise<RowDataPacket | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows[0];
}

/** Ensure a synthetic data source + endpoint exist and return their ids. */
async function ensureSourceAndEndpoint(pool: Pool, created: Created): Promise<{ dataSourceId: string; endpointId: string }> {
  const existingDs = await getDataSourceByName(pool, "official-brawl-stars-api");
  let dataSourceId: string;
  if (existingDs) {
    dataSourceId = existingDs.id;
  } else {
    dataSourceId = randomUUID();
    await pool.execute(
      "INSERT INTO data_sources (id, name, source_type, is_enabled) VALUES (?, 'official-brawl-stars-api', 'official_api', 1)",
      [dataSourceId]
    );
    created.dataSourceId = dataSourceId;
  }
  const existingEp = await getSourceEndpoint(pool, dataSourceId, "battle_log");
  let endpointId: string;
  if (existingEp) {
    endpointId = existingEp.id;
  } else {
    endpointId = randomUUID();
    await pool.execute(
      "INSERT INTO source_endpoints (id, data_source_id, endpoint_category, path, method, schema_version, is_enabled) VALUES (?, ?, 'battle_log', '/v1/players/{tag}/battlelog', 'GET', 'v1', 1)",
      [endpointId, dataSourceId]
    );
    created.endpointId = endpointId;
  }
  return { dataSourceId, endpointId };
}

/** Benchmark 1: battle-log write txn latency. Keeps battles + adds participants for aggregation. */
async function benchBattleWrite(pool: Pool, created: Created, brawlerIds: string[], gameModeId: string, playerA: string, playerB: string, fetchRunId: string): Promise<BenchOutput> {
  const insertBattle = async (idx: number): Promise<string> => {
    const battleId = await insertNormalizedBattle(
      pool,
      {
        battleKey: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 32),
        gameModeId,
        mapId: null,
        eventSourceId: null,
        battleType: "phase6-benchmark",
        structure: "teams",
        occurredAt: new Date(),
        durationSeconds: null,
        trophyChange: null,
        fetchRunId,
        patchId: null,
      },
      [
        { teamIndex: 0, result: idx % 3 === 2 ? "defeat" : "victory", rank: null },
        { teamIndex: 1, result: idx % 3 === 2 ? "victory" : "defeat", rank: null },
      ]
    );
    created.battleIds.push(battleId);
    return battleId;
  };
  // Untimed: attach 2 participants (rotating distinct brawler pairs) so aggregation has data.
  const attachParticipants = async (battleId: string, idx: number): Promise<void> => {
    const teams = await getBattleTeamIds(pool, battleId);
    const bx = brawlerIds[idx % brawlerIds.length];
    const by = brawlerIds[(idx + 1) % brawlerIds.length];
    await upsertBattleParticipant(pool, { battleId, battleTeamId: teams.get(0) ?? null, playerId: playerA, brawlerId: bx, brawlerPower: null, brawlerTrophies: null, participantIndex: 0, isStarPlayer: false });
    await upsertBattleParticipant(pool, { battleId, battleTeamId: teams.get(1) ?? null, playerId: playerB, brawlerId: by, brawlerPower: null, brawlerTrophies: null, participantIndex: 1, isStarPlayer: false });
  };

  for (let i = 0; i < WARMUP; i += 1) { const id = await insertBattle(i); await attachParticipants(id, i); }
  const samples: number[] = [];
  for (let i = 0; i < ITER; i += 1) {
    const { ms, value } = await timedMs(() => insertBattle(WARMUP + i));
    samples.push(ms);
    await attachParticipants(value, WARMUP + i);
  }

  const measuredIds = created.battleIds.slice(WARMUP);
  const ph = measuredIds.map(() => "?").join(",");
  const battleCount = Number((await scalarQuery(pool, `SELECT COUNT(*) c FROM normalized_battles WHERE id IN (${ph})`, measuredIds))?.c);
  const dupKeys = Number((await scalarQuery(pool, `SELECT COUNT(*) c FROM (SELECT battle_key FROM normalized_battles WHERE id IN (${ph}) GROUP BY battle_key HAVING COUNT(*)>1) d`, measuredIds))?.c);
  const teamCount = Number((await scalarQuery(pool, `SELECT COUNT(*) c FROM battle_teams WHERE battle_id IN (${ph})`, measuredIds))?.c);
  const s = latencyStats(samples);
  const correctness = { battlesPersisted: battleCount === measuredIds.length, noDuplicateBattleKeys: dupKeys === 0, twoTeamsPerBattle: teamCount === measuredIds.length * 2 };
  const semanticOk = correctness.battlesPersisted && correctness.noDuplicateBattleKeys && correctness.twoTeamsPerBattle;
  return { status: "ok", path: "insertNormalizedBattle (normalized_battles + battle_teams)", warmup: WARMUP, iterations: ITER, latencyMs: s, correctness, sloVerdict: semanticOk && s.p95Ms <= PROVISIONAL_SLO.battleWriteTxnP95Ms && s.p99Ms <= PROVISIONAL_SLO.battleWriteTxnP99Ms ? "PASS" : "FAIL" };
}

const VALID_AGG_OUTCOMES = ["succeeded", "succeeded_with_warnings"];
const VALID_RANKING_OUTCOMES = ["published", "held_mass_movement", "no_significant_change"];

async function benchAggregation(): Promise<BenchOutput> {
  const { ms, value } = await timedMs(() => runAggregation("manual", 8));
  const processed = (value.overallAggregateCount ?? 0) + (value.modeAggregateCount ?? 0);
  const validOutcome = VALID_AGG_OUTCOMES.includes(value.outcome);
  const measuredNonZero = validOutcome && processed > 0;
  return {
    status: measuredNonZero ? "ok" : "fail",
    path: "runAggregation('manual', 8)",
    batchSize: 8,
    durationMs: round(ms),
    outcome: value.outcome,
    counts: { overallAggregateCount: value.overallAggregateCount, modeAggregateCount: value.modeAggregateCount, matchupAggregateCount: value.matchupAggregateCount, reconciliationWarnings: value.reconciliationWarnings },
    processedCount: processed,
    correctness: { validOutcome, processedMoreThanZero: processed > 0 },
    sloVerdict: measuredNonZero ? "PASS" : "FAIL",
  };
}

async function benchRanking(): Promise<BenchOutput> {
  const { ms, value } = await timedMs(() => runRankingRebuild("manual", 8));
  const evaluated = value.brawlersEvaluated ?? 0;
  const validOutcome = VALID_RANKING_OUTCOMES.includes(value.outcome);
  const measuredNonZero = validOutcome && evaluated > 0;
  return {
    status: measuredNonZero ? "ok" : "fail",
    path: "runRankingRebuild('manual', 8)",
    batchSize: 8,
    durationMs: round(ms),
    outcome: value.outcome,
    counts: { rankingRunId: value.rankingRunId ?? null, brawlersEvaluated: evaluated, brawlersPublished: value.brawlersPublished ?? 0, tierMoveRatio: value.tierMoveRatio ?? null },
    correctness: { validOutcome, evaluatedMoreThanZero: evaluated > 0 },
    sloVerdict: measuredNonZero ? "PASS" : "FAIL",
  };
}

/** Create a minimal synthetic CURRENT published snapshot + items, then measure the real read. */
async function benchPublicRead(pool: Pool, brawlerIds: string[]): Promise<BenchOutput> {
  const ruleSetId = (await scalarQuery(pool, "SELECT id FROM ranking_rule_sets WHERE is_active=1 LIMIT 1"))?.id as string | undefined;
  const modeAgg = (await scalarQuery(pool, "SELECT id FROM aggregation_runs WHERE scope='per_mode' AND status IN ('succeeded','succeeded_with_warnings') ORDER BY created_at DESC LIMIT 1"))?.id as string | undefined;
  const overallAgg = (await scalarQuery(pool, "SELECT id FROM aggregation_runs WHERE scope='overall' AND status IN ('succeeded','succeeded_with_warnings') ORDER BY created_at DESC LIMIT 1"))?.id as string | undefined;
  const matchupAgg = (await scalarQuery(pool, "SELECT id FROM aggregation_runs WHERE scope='matchup' AND status IN ('succeeded','succeeded_with_warnings') ORDER BY created_at DESC LIMIT 1"))?.id as string | undefined;
  const wdId = (await scalarQuery(pool, "SELECT id FROM workflow_definitions WHERE slug='ranking-rebuild' LIMIT 1"))?.id as string | undefined;
  if (!ruleSetId || !modeAgg || !overallAgg || !matchupAgg || !wdId) {
    return { status: "skipped_missing_prerequisite", sloVerdict: "FAIL", missing: `cannot build a synthetic published snapshot (ruleSet=${!!ruleSetId} perMode=${!!modeAgg} overall=${!!overallAgg} matchup=${!!matchupAgg} rankingDef=${!!wdId}) — aggregation must have produced runs first` };
  }

  const workflowRunId = randomUUID();
  await pool.execute("INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at) VALUES (?, ?, 'succeeded', 'manual', NOW(3))", [workflowRunId, wdId]);
  const rankingRunId = randomUUID();
  await pool.execute(
    `INSERT INTO ranking_runs (id, workflow_run_id, ranking_rule_set_id, mode_aggregation_run_id, overall_aggregation_run_id, matchup_aggregation_run_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'succeeded', NOW(3))`,
    [rankingRunId, workflowRunId, ruleSetId, modeAgg, overallAgg, matchupAgg]
  );
  await pool.execute("UPDATE published_snapshots SET is_current=0 WHERE is_current=1");
  const snapshotId = randomUUID();
  await pool.execute("INSERT INTO published_snapshots (id, ranking_run_id, is_current, published_at) VALUES (?, ?, 1, NOW(3))", [snapshotId, rankingRunId]);
  const itemBrawlers = brawlerIds.slice(0, Math.max(1, brawlerIds.length));
  let rank = 0;
  for (const brawlerId of itemBrawlers) {
    rank += 1;
    await pool.execute(
      `INSERT INTO published_snapshot_items (id, published_snapshot_id, brawler_id, overall_tier, overall_score, overall_confidence, mode_tiers, calculated_at, published_at, data_limitations)
       VALUES (?, ?, ?, ?, ?, 'medium', '{}', NOW(3), NOW(3), '{}')`,
      [randomUUID(), snapshotId, brawlerId, rank <= 2 ? "S" : "A", round(100 - rank)]
    );
  }

  const readOnce = async () => {
    const m = await getCurrentSnapshotMeta(pool);
    return m ? getCurrentPublishedBrawlers(pool, m.snapshotId) : [];
  };
  for (let i = 0; i < WARMUP; i += 1) await readOnce();
  const samples: number[] = [];
  let lastItems: Awaited<ReturnType<typeof readOnce>> = [];
  for (let i = 0; i < ITER; i += 1) { const { ms, value } = await timedMs(readOnce); samples.push(ms); lastItems = value; }

  const itemCount = lastItems.length;
  const shapeOk = itemCount > 0 && lastItems.every((b) => typeof b.brawlerSlug === "string" && b.brawlerSlug.length > 0 && typeof b.overallTier === "string" && Number.isFinite(b.overallScore) && typeof b.publishedAt === "string");
  const orderedOk = lastItems.every((b, i) => i === 0 || lastItems[i - 1].overallScore >= b.overallScore);
  const s = latencyStats(samples);
  const semanticOk = itemCount > 0 && shapeOk && orderedOk;
  return { status: itemCount > 0 ? "ok" : "fail", path: "synthetic current published snapshot -> getCurrentSnapshotMeta + getCurrentPublishedBrawlers", warmup: WARMUP, iterations: ITER, snapshotId, itemCount, latencyMs: s, correctness: { itemsMoreThanZero: itemCount > 0, publicContractShape: shapeOk, orderedByScoreDesc: orderedOk }, sloVerdict: semanticOk && s.p95Ms <= PROVISIONAL_SLO.publicTierListReadP95Ms ? "PASS" : "FAIL" };
}

/** Create synthetic archive-eligible raw snapshots, then measure claim/update (no payload deletion). */
async function benchArchiveClaimUpdate(pool: Pool, created: Created, fetchRunId: string): Promise<BenchOutput> {
  const bucket = `phase6-bench-${randomUUID()}`;
  created.archiveBucket = bucket;
  const total = ITER + WARMUP + 10;
  for (let i = 0; i < total; i += 1) {
    const id = randomUUID();
    const payload = `{"phase6-benchmark":true,"i":${i},"nonce":"${randomUUID()}"}`;
    await pool.execute(
      `INSERT INTO raw_api_snapshots (id, data_fetch_run_id, endpoint_category, payload, checksum, http_status, received_at)
       VALUES (?, ?, 'battle_log', ?, ?, 200, NOW(3))`,
      [id, fetchRunId, payload, createHash("sha256").update(payload).digest("hex")]
    );
    created.rawSnapshotIds.push(id);
  }
  const enqueued = await enqueuePendingArchives(pool, { bucket, provider: "phase6-benchmark", limit: total });
  if (enqueued === 0) return { status: "fail", sloVerdict: "FAIL", missing: "enqueuePendingArchives created 0 rows despite synthetic raw snapshots" };

  const claimAndVerify = async (): Promise<string | null> => {
    const claimed = await claimNextArchive(pool, { leaseOwner: "phase6-benchmark", leaseSeconds: 300 });
    if (!claimed) return null;
    await markArchiveVerified(pool, { rawSnapshotId: claimed.rawSnapshotId, objectSize: claimed.originalSize, objectChecksum: createHash("sha256").update(claimed.rawSnapshotId).digest("hex") });
    return claimed.rawSnapshotId;
  };
  for (let i = 0; i < WARMUP; i += 1) if ((await claimAndVerify()) === null) break;
  const samples: number[] = [];
  let lastId: string | null = null;
  for (let i = 0; i < ITER; i += 1) { const { ms, value } = await timedMs(claimAndVerify); if (value === null) break; samples.push(ms); lastId = value; }

  let verifiedOk = false;
  let payloadPreserved = false;
  if (lastId) {
    const arch = await scalarQuery(pool, "SELECT archive_status, payload_removed_at FROM raw_snapshot_archives WHERE raw_snapshot_id=?", [lastId]);
    verifiedOk = arch?.archive_status === "verified" && arch?.payload_removed_at === null;
    payloadPreserved = Number((await scalarQuery(pool, "SELECT payload IS NOT NULL AS present FROM raw_api_snapshots WHERE id=?", [lastId]))?.present) === 1;
  }
  const measured = samples.length > 0;
  const s = latencyStats(samples);
  const semanticOk = measured && verifiedOk && payloadPreserved;
  return { status: measured ? "ok" : "fail", path: "claimNextArchive (FOR UPDATE SKIP LOCKED) + markArchiveVerified", warmup: WARMUP, iterations: samples.length, latencyMs: s, correctness: { measured, markedVerified: verifiedOk, rawPayloadNotDeleted: payloadPreserved }, sloVerdict: semanticOk && s.p95Ms <= PROVISIONAL_SLO.archiveClaimUpdateP95Ms ? "PASS" : "FAIL" };
}

/** Measure a real local MySQL 8.4 dump of the benchmark DB + restore into a disposable temp DB. */
async function benchDumpRestore(): Promise<BenchOutput> {
  const container = process.env.PHASE6_DOCKER_CONTAINER ?? "";
  const db = process.env.DB_NAME!;
  const user = process.env.DB_USER ?? "root";
  const pw = process.env.BRAWL_DB_SECRET_V1 ?? "";
  const port = process.env.DB_PORT ?? "3306";
  const host = process.env.DB_HOST ?? "127.0.0.1";
  const tempDb = `${db}_dumpbench`;
  const dumpPath = path.resolve(`.tmp/phase6-bench-dump-${randomUUID()}.sql`);
  const maxBuffer = 512 * 1024 * 1024;

  const run = (argv: string[], input?: Buffer): { code: number | null; stdout: Buffer; stderr: string } => {
    const r = spawnSync(argv[0], argv.slice(1), { maxBuffer, input });
    return { code: r.status, stdout: (r.stdout as Buffer) ?? Buffer.alloc(0), stderr: String(r.stderr ?? "") };
  };
  // Build a mysqldump/mysql invocation, inside the container if configured (MySQL 8.4 tools).
  const dumpArgv = container
    ? ["docker", "exec", container, "sh", "-lc", `MYSQL_PWD='${pw}' mysqldump -u${user} --single-transaction --no-tablespaces --skip-lock-tables ${db}`]
    : ["sh", "-lc", `MYSQL_PWD='${pw}' mysqldump -h ${host} -P ${port} -u${user} --single-transaction --no-tablespaces --skip-lock-tables ${db}`];
  const mysqlExec = (sql: string): string[] => container
    ? ["docker", "exec", container, "sh", "-lc", `MYSQL_PWD='${pw}' mysql -u${user} -e "${sql}"`]
    : ["sh", "-lc", `MYSQL_PWD='${pw}' mysql -h ${host} -P ${port} -u${user} -e "${sql}"`];
  const restoreArgv = container
    ? ["docker", "exec", "-i", container, "sh", "-lc", `MYSQL_PWD='${pw}' mysql -u${user} ${tempDb}`]
    : ["sh", "-lc", `MYSQL_PWD='${pw}' mysql -h ${host} -P ${port} -u${user} ${tempDb}`];

  try {
    // --- dump ---
    const t0 = performance.now();
    const dumped = run(dumpArgv);
    const dumpMs = performance.now() - t0;
    if (dumped.code !== 0 || dumped.stdout.length === 0) {
      return { status: "fail", sloVerdict: "FAIL", missing: `mysqldump failed (code=${dumped.code}): ${dumped.stderr.slice(0, 300)}` };
    }
    await mkdir(path.resolve(".tmp"), { recursive: true });
    await writeFile(dumpPath, dumped.stdout, { mode: 0o600 });
    const dumpBytes = (await stat(dumpPath)).size;
    const dumpMB = dumpBytes / (1024 * 1024);

    // --- restore into a disposable temp DB ---
    const dropCreate = run(mysqlExec(`DROP DATABASE IF EXISTS ${tempDb}; CREATE DATABASE ${tempDb} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`));
    if (dropCreate.code !== 0) return { status: "fail", sloVerdict: "FAIL", missing: `could not create temp restore DB: ${dropCreate.stderr.slice(0, 300)}` };
    const t1 = performance.now();
    const restored = run(restoreArgv, dumped.stdout);
    const restoreMs = performance.now() - t1;
    // sanity: restored table count matches source
    const srcTables = run(mysqlExec(`SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${db}' AND TABLE_TYPE='BASE TABLE';`)).stdout.toString();
    const dstTables = run(mysqlExec(`SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${tempDb}' AND TABLE_TYPE='BASE TABLE';`)).stdout.toString();
    const srcN = Number((srcTables.match(/(\d+)/g) ?? []).pop());
    const dstN = Number((dstTables.match(/(\d+)/g) ?? []).pop());

    const dumpThroughputMBps = round(dumpMB / (dumpMs / 1000));
    const restoreThroughputMBps = restored.code === 0 ? round(dumpMB / (restoreMs / 1000)) : null;
    const measured = dumped.code === 0 && dumpMB > 0 && restored.code === 0;
    return {
      status: measured ? "ok" : "fail",
      sloVerdict: "N/A",
      path: `mysqldump + restore (${container ? `docker exec ${container}` : "TCP"}) of ${db} into ${tempDb}`,
      dump: { sizeMB: round(dumpMB), durationMs: round(dumpMs), throughputMBps: dumpThroughputMBps, measured: true },
      restore: { durationMs: round(restoreMs), throughputMBps: restoreThroughputMBps, measured: restored.code === 0, tablesSource: srcN, tablesRestored: dstN, tableCountMatch: srcN === dstN },
      restoreProofEvidence: { dumpSizeGB: RESTORE_EVIDENCE_GB, restoreSeconds: RESTORE_EVIDENCE_SECONDS, restoreThroughputMiBps: round((RESTORE_EVIDENCE_GB * 1024) / RESTORE_EVIDENCE_SECONDS), note: "1.15 GB / 26m19s restore-proof evidence (separate, larger dataset)" },
    };
  } finally {
    run(mysqlExec(`DROP DATABASE IF EXISTS ${tempDb};`));
    await rm(dumpPath, { force: true }).catch(() => {});
  }
}

/** Best-effort scoped cleanup of only this benchmark's rows (FK checks off for the delete session). */
async function cleanup(pool: Pool, created: Created): Promise<void> {
  const conn: PoolConnection = await pool.getConnection();
  const start = created.benchStartSql ?? "1970-01-01";
  const inList = (ids: string[]): string => ids.map(() => "?").join(",");
  const del = async (sql: string, params: unknown[] = []): Promise<void> => { await conn.query(sql, params).catch(() => {}); };
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS=0");
    // derived pipeline rows created during this run
    await del("DELETE FROM matchup_results WHERE created_at >= ?", [start]);
    await del("DELETE FROM ranking_results WHERE created_at >= ?", [start]);
    await del("DELETE FROM published_matchup_items WHERE published_snapshot_id IN (SELECT id FROM published_snapshots WHERE published_at >= ?)", [start]);
    await del("DELETE FROM published_snapshot_items WHERE published_at >= ?", [start]);
    await del("DELETE FROM published_snapshots WHERE published_at >= ?", [start]);
    await del("DELETE FROM ranking_runs WHERE created_at >= ?", [start]);
    await del("DELETE FROM matchup_aggregates WHERE created_at >= ?", [start]);
    await del("DELETE FROM brawler_mode_aggregates WHERE created_at >= ?", [start]);
    await del("DELETE FROM brawler_overall_aggregates WHERE created_at >= ?", [start]);
    await del("DELETE FROM aggregation_runs WHERE created_at >= ?", [start]);
    if (created.battleIds.length) {
      const ph = inList(created.battleIds);
      await del(`DELETE FROM battle_observations WHERE battle_id IN (${ph})`, created.battleIds);
      await del(`DELETE FROM battle_participants WHERE battle_id IN (${ph})`, created.battleIds);
      await del(`DELETE FROM battle_teams WHERE battle_id IN (${ph})`, created.battleIds);
      await del(`DELETE FROM normalized_battles WHERE id IN (${ph})`, created.battleIds);
    }
    if (created.archiveBucket) await del("DELETE FROM raw_snapshot_archives WHERE object_bucket = ?", [created.archiveBucket]);
    if (created.rawSnapshotIds.length) await del(`DELETE FROM raw_api_snapshots WHERE id IN (${inList(created.rawSnapshotIds)})`, created.rawSnapshotIds);
    if (created.playerIds.length) {
      await del(`DELETE FROM player_name_history WHERE player_id IN (${inList(created.playerIds)})`, created.playerIds);
      await del(`DELETE FROM normalized_players WHERE id IN (${inList(created.playerIds)})`, created.playerIds);
    }
    if (created.brawlerIds.length) await del(`DELETE FROM canonical_brawlers WHERE id IN (${inList(created.brawlerIds)})`, created.brawlerIds);
    if (created.gameModeIds.length) await del(`DELETE FROM canonical_game_modes WHERE id IN (${inList(created.gameModeIds)})`, created.gameModeIds);
    await del("DELETE FROM workflow_steps WHERE created_at >= ?", [start]);
    await del("DELETE FROM workflow_locks WHERE locked_at >= ?", [start]);
    await del("DELETE FROM workflow_runs WHERE created_at >= ?", [start]);
    if (created.fetchRunIds.length) await del(`DELETE FROM data_fetch_runs WHERE id IN (${inList(created.fetchRunIds)})`, created.fetchRunIds);
    if (created.endpointId) await del("DELETE FROM source_endpoints WHERE id = ?", [created.endpointId]);
    if (created.dataSourceId) await del("DELETE FROM data_sources WHERE id = ?", [created.dataSourceId]);
    await conn.query("SET FOREIGN_KEY_CHECKS=1");
  } finally {
    conn.release();
  }
}

async function main(): Promise<void> {
  assertDisposableTarget();
  const pool = getPool();
  const startedAt = new Date().toISOString();
  const created: Created = { fetchRunIds: [], brawlerIds: [], gameModeIds: [], playerIds: [], battleIds: [], rawSnapshotIds: [] };
  const report: Record<string, unknown> = {
    harness: "scripts/dataset/phase6-benchmark.ts",
    phase: "DATASET Phase 6.5 benchmark (self-provisioned)",
    databaseConnection: { host: process.env.DB_HOST, port: process.env.DB_PORT ?? "3306", database: process.env.DB_NAME },
    startedAt,
    provisionalSlo: PROVISIONAL_SLO,
    benchmarks: {} as Record<string, BenchOutput>,
  };
  const benches = report.benchmarks as Record<string, BenchOutput>;

  await mkdir(path.resolve(".tmp"), { recursive: true });
  const outFile = path.resolve(`.tmp/phase6-benchmark-${startedAt.replace(/[:.]/g, "-")}.json`);
  report.reportFile = outFile;
  const flush = async (): Promise<void> => { await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); };

  try {
    // Capture the run-start as a MySQL-comparable string (NOT a JS Date.toString),
    // in the same server clock as created_at, so cleanup's created_at >= scoping works.
    created.benchStartSql = String((await scalarQuery(pool, "SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%d %H:%i:%s.%f') t"))?.t);
    await flush();

    // --- self-provision the base catalog needed by battle write + aggregation ---
    process.stderr.write("[phase6-bench] provisioning synthetic catalog…\n");
    const { dataSourceId, endpointId } = await ensureSourceAndEndpoint(pool, created);
    const fetchRunId = await createFetchRun(pool, { dataSourceId, sourceEndpointId: endpointId, workflowRunId: null, triggerType: "manual" });
    created.fetchRunIds.push(fetchRunId);
    const suffix = randomUUID().slice(0, 8);
    const brawlerIds: string[] = [];
    for (let i = 0; i < BRAWLER_COUNT; i += 1) {
      brawlerIds.push(await insertCanonicalBrawler(pool, { sourceBrawlerId: `bench-${suffix}-${i}`, slug: `bench-${suffix}-${i}`, name: `BenchBrawler${suffix}${i}`, fetchRunId }));
    }
    created.brawlerIds.push(...brawlerIds);
    const gameModeId = await getOrCreateGameMode(pool, `benchMode${suffix}`, `benchMode${suffix}`);
    created.gameModeIds.push(gameModeId);
    const playerA = await ensurePlayerStub(pool, `#BENCHPA${suffix.toUpperCase()}`, "Bench Player A", fetchRunId);
    const playerB = await ensurePlayerStub(pool, `#BENCHPB${suffix.toUpperCase()}`, "Bench Player B", fetchRunId);
    created.playerIds.push(playerA, playerB);

    const step = async (key: string, label: string, fn: () => Promise<BenchOutput>): Promise<void> => {
      const t0 = performance.now();
      process.stderr.write(`[phase6-bench] ${label} … starting\n`);
      try { benches[key] = await fn(); } catch (e) { benches[key] = { status: "fail", sloVerdict: "FAIL", error: e instanceof Error ? e.message : String(e) }; }
      process.stderr.write(`[phase6-bench] ${label} … done in ${round(performance.now() - t0)}ms status=${benches[key].status} slo=${benches[key].sloVerdict ?? "N/A"}\n`);
      await flush();
    };

    // Order: write (builds battles+participants) -> aggregation -> ranking -> public read (synthetic snapshot) -> archive -> dump/restore
    await step("1_battle_log_write_txn", "1 battle-log write txn", () => benchBattleWrite(pool, created, brawlerIds, gameModeId, playerA, playerB, fetchRunId));
    await step("3_aggregation_batch8", "3 aggregation batch8", () => benchAggregation());
    await step("4_ranking_rebuild_batch8", "4 ranking rebuild batch8", () => benchRanking());
    await step("2_public_tier_list_read", "2 public tier-list read", () => benchPublicRead(pool, brawlerIds));
    await step("5_archive_claim_update", "5 archive claim/update", () => benchArchiveClaimUpdate(pool, created, fetchRunId));
    await step("6_dump_restore_throughput", "6 dump/restore throughput", () => benchDumpRestore());

    // --- final verdict per the explicit fail conditions ---
    const b = benches;
    const failConditions = {
      anySkipped: Object.values(b).some((x) => x.status === "skipped_missing_prerequisite"),
      aggregationProcessedZero: (b["3_aggregation_batch8"]?.processedCount as number ?? 0) <= 0,
      rankingEvaluatedZero: ((b["4_ranking_rebuild_batch8"]?.counts as { brawlersEvaluated?: number })?.brawlersEvaluated ?? 0) <= 0,
      publicItemsZero: (b["2_public_tier_list_read"]?.itemCount as number ?? 0) <= 0,
      archiveNotMeasured: !((b["5_archive_claim_update"]?.correctness as { measured?: boolean })?.measured === true),
      dumpNotMeasured: !((b["6_dump_restore_throughput"]?.dump as { measured?: boolean })?.measured === true),
      anyBenchFail: Object.values(b).some((x) => x.status === "fail"),
    };
    const gatePasses = !Object.values(failConditions).some(Boolean);
    report.overall = {
      benchmarkGatePasses: gatePasses,
      skipped: failConditions.anySkipped,
      failConditions,
      provisionalSloByPath: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.sloVerdict ?? "N/A"])),
    };
    report.completedAt = new Date().toISOString();
    await flush();

    console.error(`\nPhase 6 benchmark report: ${outFile}`);
    console.error(`overall: benchmarkGatePasses=${gatePasses} skipped=${failConditions.anySkipped} failConditions=${JSON.stringify(failConditions)}`);
    process.exitCode = gatePasses ? 0 : 1;
  } finally {
    process.stderr.write("[phase6-bench] cleaning up synthetic rows…\n");
    await cleanup(pool, created).catch((e) => process.stderr.write(`[phase6-bench] cleanup warning: ${e instanceof Error ? e.message : String(e)}\n`));
    await getPool().end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`phase6-benchmark error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
