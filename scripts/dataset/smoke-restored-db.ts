#!/usr/bin/env -S tsx
/**
 * DATASET Phase 2 — read-only application smoke test against an ISOLATED
 * restored copy.
 *
 * This exercises the REAL public read path — lib/publishedSnapshots/repository.ts
 * via lib/mysql.ts::getPool() — against a disposable restored database, to
 * prove the restored copy can actually serve the application's public
 * contract, not merely hold rows. It performs ZERO writes and never touches
 * ingestion, aggregation, ranking, retention, publication, or migrations.
 *
 * SAFETY MODEL (fail closed):
 *   1. DB_NAME must start with `brawlranks_restoretest_`. Any production
 *      marker (u350003894, brawl2, prod, production, live) is refused.
 *   2. DB_HOST must be loopback (127.0.0.1 / localhost / ::1).
 *   3. NODE_ENV/APP_ENV must not be `production`.
 *   4. The pool is used for SELECTs only; this script issues no INSERT/
 *      UPDATE/DELETE/DDL and starts no workflow.
 *
 * Usage (local-only credentials, never production):
 *   DB_HOST=127.0.0.1 DB_PORT=3307 DB_NAME=brawlranks_restoretest_YYYYMMDD \
 *   DB_USER=root BRAWL_DB_SECRET_V1=<local-container-password> \
 *   npx tsx scripts/dataset/smoke-restored-db.ts
 *
 * Exit 0 = smoke test passed. Exit non-zero = a check failed (details on
 * stderr, never a secret).
 */

import { getPool } from "../../lib/mysql";
import {
  getCurrentSnapshotMeta,
  getCurrentPublishedBrawlers,
} from "../../lib/publishedSnapshots/repository";

const PRODUCTION_MARKERS = ["u350003894", "brawl2", "prod", "production", "live"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function refuse(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

function assertIsolatedTarget(): void {
  const name = (process.env.DB_NAME ?? "").toLowerCase();
  if (!name.startsWith("brawlranks_restoretest_")) {
    refuse(
      `DB_NAME "${process.env.DB_NAME ?? ""}" must start with brawlranks_restoretest_ ` +
        "— this smoke test only runs against a disposable restored copy."
    );
  }
  const suffix = name.slice("brawlranks_restoretest_".length);
  for (const marker of PRODUCTION_MARKERS) {
    if (suffix.includes(marker)) refuse(`DB_NAME contains production marker "${marker}".`);
  }
  const host = process.env.DB_HOST ?? "";
  if (!LOOPBACK.has(host)) {
    refuse(`DB_HOST "${host}" is not loopback. A remote host risks pointing at production.`);
  }
  const envName = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "").toLowerCase();
  if (envName === "production") refuse("NODE_ENV/APP_ENV is production. Refusing.");
}

async function main(): Promise<void> {
  assertIsolatedTarget();

  const results: Array<{ check: string; observed: string; verdict: "PASS" | "FAIL" }> = [];
  const record = (check: string, ok: boolean, observed: string) =>
    results.push({ check, observed, verdict: ok ? "PASS" : "FAIL" });

  const pool = getPool();

  // 1. Connectivity (SELECT 1) — proves the restored DB accepts the app pool.
  const [ping] = await pool.query("SELECT 1 AS ok");
  record("connectivity", Array.isArray(ping) && (ping as any[]).length === 1, "SELECT 1 returned a row");

  // 2. getCurrentSnapshotMeta — the exact query the public API meta uses.
  const meta = await getCurrentSnapshotMeta(pool);
  record("current_snapshot_meta", meta !== null, meta ? `snapshot ${meta.snapshotId}` : "null");

  if (!meta) {
    // A restored copy with no published snapshot is a valid production state
    // (brawlersPublished 0), but our evidence says exactly 1 current snapshot.
    report(results);
    refuse("no current published snapshot found — expected exactly one per restore evidence.");
  }

  // 3. getCurrentPublishedBrawlers — the exact per-brawler public contract.
  const brawlers = await getCurrentPublishedBrawlers(pool, meta.snapshotId);
  record("published_brawlers_nonempty", brawlers.length > 0, `${brawlers.length} brawlers`);
  record(
    "published_item_count_105",
    brawlers.length === 105,
    `${brawlers.length} items (evidence expected 105)`
  );

  // 4. Contract shape — each record must carry the public fields the site reads.
  const shapeOk =
    brawlers.length === 0 ||
    brawlers.every(
      (b) =>
        typeof b.brawlerSlug === "string" &&
        b.brawlerSlug.length > 0 &&
        typeof b.overallTier === "string" &&
        Number.isFinite(b.overallScore) &&
        typeof b.publishedAt === "string"
    );
  record("public_contract_shape", shapeOk, "slug/tier/score/publishedAt present on every item");

  // 5. Ordering — the public list is ordered by overall_score DESC.
  const orderedOk = brawlers.every(
    (b, i) => i === 0 || brawlers[i - 1].overallScore >= b.overallScore
  );
  record("ordered_by_score_desc", orderedOk, "overall_score non-increasing");

  report(results);

  const failed = results.filter((r) => r.verdict === "FAIL");
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll read-only smoke checks PASSED against the isolated restored copy.");
}

function report(results: Array<{ check: string; observed: string; verdict: string }>): void {
  console.log("DATASET Phase 2 — restored-copy read-only smoke test");
  console.log(`target: ${process.env.DB_NAME} @ ${process.env.DB_HOST}:${process.env.DB_PORT ?? "3306"}\n`);
  for (const r of results) {
    console.log(`  [${r.verdict}] ${r.check}: ${r.observed}`);
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    // Never print a stack that could contain a DSN; message only.
    console.error(`smoke test error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
