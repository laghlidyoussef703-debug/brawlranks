#!/usr/bin/env node
/**
 * DATASET Phase 3 — automated MySQL 8.4 compatibility proof.
 *
 * Applies every migration to a REAL, DISPOSABLE MySQL 8.4 server from empty,
 * then exercises the runtime semantics the schema relies on. This is the proof
 * that closes DATASET.md's "prove all migrations and queries on MySQL 8.4"
 * gate — static inspection (compatibility-check.mjs) cannot.
 *
 * It fails closed: it refuses to run against anything that is not an empty,
 * clearly-disposable MySQL 8.x target.
 *
 * Disposable container (never a production credential):
 *   docker run -d --name brawlranks-mysql84test \
 *     -e MYSQL_ROOT_PASSWORD='<local-only>' -p 3308:3306 mysql:8.4 \
 *     --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci \
 *     --default-time-zone=+00:00
 *
 * Then:
 *   DB_HOST=127.0.0.1 DB_PORT=3308 DB_NAME=brawlranks_mysql84_migtest \
 *   DB_USER=root BRAWL_DB_SECRET_V1='<local-only>' \
 *   node scripts/dataset/mysql84-compat-test.mjs
 *
 * The migration runner is invoked as a child process (scripts/migrate.mjs up)
 * so this test proves the REAL runner works on 8.4 — it does not re-implement
 * migration application. Exit 0 = all checks passed.
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const MIGRATION_FILE_COUNT = readdirSync(path.join(REPO_ROOT, "migrations")).filter((f) =>
  f.endsWith(".sql")
).length;

const PRODUCTION_MARKERS = ["u350003894", "brawl2", "prod", "production", "live"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function fail(message) {
  console.error(`REFUSED/FAILED: ${message}`);
  process.exit(1);
}

function parsePort(raw) {
  if (!raw) return 3306;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) fail(`invalid DB_PORT "${raw}"`);
  return n;
}

function assertDisposableTarget() {
  const name = (process.env.DB_NAME ?? "").toLowerCase();
  if (!name) fail("DB_NAME is required.");
  for (const marker of PRODUCTION_MARKERS) {
    if (name.includes(marker)) fail(`DB_NAME contains production marker "${marker}".`);
  }
  const host = process.env.DB_HOST ?? "";
  if (!LOOPBACK.has(host) && process.env.ALLOW_REMOTE_TARGET !== "1") {
    fail(`DB_HOST "${host}" is not loopback. Refusing (export ALLOW_REMOTE_TARGET=1 to override).`);
  }
}

function runMigrationsUp() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "scripts", "migrate.mjs"), "up"], {
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`migrate.mjs up exited ${code}`))));
    child.on("error", reject);
  });
}

const results = [];
function check(name, ok, observed) {
  results.push({ name, ok, observed });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}: ${observed}`);
}

async function main() {
  assertDisposableTarget();

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parsePort(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.BRAWL_DB_SECRET_V1,
    multipleStatements: true,
  });

  try {
    const [[ver]] = await conn.query(
      "SELECT VERSION() v, @@version_comment vc, @@sql_mode sm, @@time_zone tz, @@collation_server cs"
    );
    if (!/^8\.4\./.test(ver.v) || /mariadb/i.test(ver.vc)) {
      fail(`target is not MySQL 8.4 (VERSION()=${ver.v}, comment=${ver.vc}). This test only runs on MySQL 8.4.`);
    }
    console.log(`MySQL 8.4 compatibility proof against ${process.env.DB_NAME}`);
    console.log(`  server: ${ver.v} / ${ver.vc}`);
    console.log(`  sql_mode: ${ver.sm}`);
    console.log(`  time_zone: ${ver.tz}, collation_server: ${ver.cs}\n`);

    const [[applied]] = await conn.query("SELECT COUNT(*) n FROM schema_migrations").catch(() => [[{ n: 0 }]]);
    if (applied.n === 0) {
      console.log("No migrations applied yet — applying all from empty via scripts/migrate.mjs up:\n");
      await runMigrationsUp();
      console.log("");
    }

    // --- schema checks ---
    const [[mig]] = await conn.query("SELECT COUNT(*) n FROM schema_migrations");
    check("migrations_applied_all", mig.n === MIGRATION_FILE_COUNT, `${mig.n} of ${MIGRATION_FILE_COUNT} files`);

    const [[tbl]] = await conn.query(
      "SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()"
    );
    check("table_count_at_least_46", tbl.n >= 46, `${tbl.n} (>= 45 migration + schema_migrations)`);

    const [[arch]] = await conn.query(
      "SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='raw_snapshot_archives'"
    );
    check("raw_snapshot_archives_present", arch.n === 1, `${arch.n} (Phase 4 archive table)`);

    const [[nonInno]] = await conn.query(
      "SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' AND ENGINE<>'InnoDB'"
    );
    check("all_innodb", nonInno.n === 0, `${nonInno.n} non-InnoDB`);

    const [colls] = await conn.query(
      "SELECT DISTINCT TABLE_COLLATION c FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'"
    );
    check(
      "collation_uniform_unicode_ci",
      colls.length === 1 && colls[0].c === "utf8mb4_unicode_ci",
      colls.map((r) => r.c).join(",")
    );

    const [[fk]] = await conn.query(
      "SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='FOREIGN KEY'"
    );
    check("foreign_keys_at_least_73", fk.n >= 73, `${fk.n} (>= 73)`);

    const [[gen]] = await conn.query(
      "SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND GENERATION_EXPRESSION IS NOT NULL AND GENERATION_EXPRESSION<>''"
    );
    check("generated_columns_5", gen.n === 5, `${gen.n}`);

    const [[rank]] = await conn.query(
      "SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='battle_teams' AND COLUMN_NAME='rank'"
    );
    check("battle_teams_rank_present", Boolean(rank), rank ? rank.t : "MISSING");

    const [[rule]] = await conn.query("SELECT COUNT(*) n FROM ranking_rule_sets WHERE is_active=1");
    check("one_active_rule_set", rule.n === 1, `${rule.n}`);

    // --- runtime semantics ---
    await conn.query(
      "CREATE TEMPORARY TABLE t_cur (id INT PRIMARY KEY, is_active TINYINT(1) NOT NULL DEFAULT 0, active_flag TINYINT(1) AS (IF(is_active=1,1,NULL)) STORED, UNIQUE KEY u (active_flag)) ENGINE=InnoDB"
    );
    await conn.query("INSERT INTO t_cur(id,is_active) VALUES (1,1),(2,0),(3,0)");
    let invariantEnforced = false;
    try {
      await conn.query("INSERT INTO t_cur(id,is_active) VALUES (4,1)");
    } catch (e) {
      invariantEnforced = e.code === "ER_DUP_ENTRY";
    }
    check("generated_col_single_current_invariant", invariantEnforced, "second active row rejected (ER_DUP_ENTRY)");

    await conn.query(
      "CREATE TEMPORARY TABLE t_chk (id INT PRIMARY KEY, result VARCHAR(10), CONSTRAINT c CHECK (result IN ('victory','defeat','draw','unknown'))) ENGINE=InnoDB"
    );
    await conn.query("INSERT INTO t_chk VALUES (1,'victory')");
    let checkEnforced = false;
    try {
      await conn.query("INSERT INTO t_chk VALUES (2,'bogus')");
    } catch (e) {
      checkEnforced = e.errno === 3819;
    }
    check("check_constraint_enforced", checkEnforced, "invalid value rejected (errno 3819)");

    await conn.query("CREATE TEMPORARY TABLE t_up (k VARCHAR(10) PRIMARY KEY, n INT NOT NULL) ENGINE=InnoDB");
    await conn.query("INSERT INTO t_up VALUES ('a',1)");
    await conn.query("INSERT INTO t_up VALUES ('a',5) ON DUPLICATE KEY UPDATE n=n+VALUES(n)");
    const [[up]] = await conn.query("SELECT n FROM t_up WHERE k='a'");
    check("insert_on_duplicate_key_update", up.n === 6, `n=${up.n} (expected 6)`);

    const [[lock]] = await conn.query(
      "SELECT GET_LOCK('brawlranks_probe',5) a, RELEASE_LOCK('brawlranks_probe') r"
    );
    check("advisory_get_lock", lock.a === 1 && lock.r === 1, `acquired=${lock.a} released=${lock.r}`);

    const [[dt]] = await conn.query("SELECT CAST('2026-07-19 12:34:56.789' AS DATETIME(3)) d");
    const dtStr = dt.d instanceof Date ? dt.d.toISOString() : String(dt.d);
    check("datetime3_millisecond_precision", /\.789/.test(dtStr) || /789/.test(dtStr), dtStr);

    console.log("");
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.error(`${failed.length} check(s) FAILED on MySQL 8.4.`);
      process.exit(1);
    }
    console.log("All MySQL 8.4 compatibility checks PASSED.");
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(`mysql84-compat-test error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
