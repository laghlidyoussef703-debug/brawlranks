#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { assertDifferentDatabases, createEndpointPool, inspectConfig, redactSecrets, resolveEndpoint, safeIdentity } from "./config";
import { syncTable } from "./engine";
import { FAMILY_ORDER, plansFor, TABLE_PLANS } from "./model";
import { FileStateStore } from "./state";
import { globalReconciliation, reconcileCurrentPublication } from "./validation";

type Args = Record<string, string | boolean>;
function args(argv: string[]): { command: string; options: Args } {
  const command = argv[2] ?? "help";
  const options: Args = {};
  for (let i = 3; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    options[key] = value;
  }
  return { command, options };
}
const numberOption = (options: Args, key: string, fallback: number, max: number): number => {
  const value = Number(options[key] ?? fallback);
  if (!Number.isInteger(value) || value <= 0 || value > max) throw new Error(`--${key} must be an integer from 1 to ${max}`);
  return value;
};
const stateDirectory = (options: Args): string => path.resolve(String(options["state-dir"] ?? process.env.MIGRATION_SYNC_STATE_DIR ?? ".migration-sync-state"));

async function pools(): Promise<{ source: Pool; target: Pool; sourceIdentity: string; targetIdentity: string }> {
  const sourceConfig = resolveEndpoint("source"), targetConfig = resolveEndpoint("target");
  assertDifferentDatabases(sourceConfig, targetConfig);
  return { source: createEndpointPool(sourceConfig), target: createEndpointPool(targetConfig), sourceIdentity: safeIdentity(sourceConfig), targetIdentity: safeIdentity(targetConfig) };
}

async function runtimeIdentity(pool: Pool): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT @@hostname hostname, @@port port, DATABASE() db");
  return `${rows[0].hostname}:${rows[0].port}/${rows[0].db}`.toLowerCase();
}

async function assertRuntimeDifferent(source: Pool, target: Pool): Promise<void> {
  const [a, b] = await Promise.all([runtimeIdentity(source), runtimeIdentity(target)]);
  if (a === b) throw new Error("Source and target identify as the same runtime database; refusing execution");
}

async function assertSourceReadOnly(source: Pool): Promise<void> {
  const [rows] = await source.query<RowDataPacket[]>("SHOW GRANTS FOR CURRENT_USER");
  const grants = rows.flatMap((row) => Object.values(row).map(String)).join("\n").toUpperCase();
  if (/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|TRIGGER|EVENT|EXECUTE|ALL PRIVILEGES)\b/.test(grants)) {
    throw new Error("Source database user has write or administrative privileges; a SELECT-only migration identity is required");
  }
  if (!/\bSELECT\b/.test(grants)) throw new Error("Source database user does not have SELECT privilege");
}

async function connectionTest(role: "source" | "target"): Promise<Record<string, unknown>> {
  const config = resolveEndpoint(role);
  const pool = createEndpointPool(config);
  try {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT VERSION() version, DATABASE() db, @@hostname hostname");
    if (role === "source") await assertSourceReadOnly(pool);
    return { ok: true, role, identity: safeIdentity(config), server: { version: rows[0].version, database: rows[0].db, hostname: rows[0].hostname }, tls: true, sourceReadOnlyVerified: role === "source" ? true : undefined };
  } finally { await pool.end(); }
}

async function runSelection(options: Args, apply: boolean, repeatedPassId?: string): Promise<Record<string, unknown>> {
  const selected = String(options.family ?? options.table ?? "all");
  const selectedPlans = plansFor(selected);
  const pageSize = numberOption(options, "page-size", 500, 5000);
  const maxRetries = numberOption(options, "retries", 3, 10);
  const overlapSeconds = numberOption(options, "overlap-seconds", 300, 86400);
  const db = await pools();
  const base = stateDirectory(options);
  const store = new FileStateStore(apply ? base : path.join(base, "dry-run"));
  await store.initialize();
  const passId = repeatedPassId ?? randomUUID();
  const reports = [];
  try {
    await assertRuntimeDifferent(db.source, db.target);
    await assertSourceReadOnly(db.source);
    for (const plan of selectedPlans) {
      reports.push(await syncTable(db.source, db.target, store, plan, {
        apply, pageSize, maxRetries, overlapSeconds,
        allowReconcileDelete: options["allow-reconcile-delete"] === true,
        sourceIdentity: db.sourceIdentity, targetIdentity: db.targetIdentity, passId,
      }));
    }
    const publication = selected === "all" || selected === "derived-public" || selected === "published_snapshots"
      ? await reconcileCurrentPublication(db.source, db.target, apply)
      : null;
    const reconciliation = selected === "all" ? await globalReconciliation(db.source, db.target, pageSize) : null;
    const lagSeconds = Math.max(0, ...reports.map((report) => report.lagSeconds ?? 0));
    const result = { passId, apply, familyOrder: FAMILY_ORDER, reports, publication, reconciliation, lagSeconds, under60Seconds: lagSeconds < 60, successful: reports.every((report) => report.status === "completed") && (publication ? publication.matched === true : true) && (reconciliation ? reconciliation.passed === true : true) };
    await store.writeReport(passId, result);
    return result;
  } finally { await Promise.all([db.source.end(), db.target.end()]); }
}

async function lagReport(options: Args): Promise<Record<string, unknown>> {
  const db = await pools();
  const store = new FileStateStore(stateDirectory(options));
  const families: Record<string, unknown> = {};
  let global = 0;
  try {
    await assertRuntimeDifferent(db.source, db.target);
    await assertSourceReadOnly(db.source);
    for (const plan of TABLE_PLANS.filter((item) => item.cursorColumn)) {
      const state = await store.read(plan.table);
      const [rows] = await db.source.query<RowDataPacket[]>(`SELECT MAX(\`${plan.cursorColumn}\`) latest FROM \`${plan.table}\``);
      const latest = rows[0].latest as Date | null;
      const completed = state?.status === "completed" && state.cursor ? new Date(state.cursor.timestamp) : null;
      const lag = latest && completed ? Math.max(0, (latest.getTime() - completed.getTime()) / 1000) : null;
      if (lag !== null) global = Math.max(global, lag);
      families[plan.table] = { latestEligibleSource: latest?.toISOString() ?? null, completedCursor: completed?.toISOString() ?? null, lagSeconds: lag, stateStatus: state?.status ?? "missing" };
    }
    return { families, globalMaximumLagSeconds: global, under60Seconds: global < 60 };
  } finally { await Promise.all([db.source.end(), db.target.end()]); }
}

async function recordReadiness(directory: string, report: Record<string, unknown>): Promise<Record<string, unknown>> {
  const filename = path.join(directory, "readiness.json");
  await mkdir(directory, { recursive: true });
  let history: Array<Record<string, unknown>> = [];
  try { history = JSON.parse(await readFile(filename, "utf8")) as Array<Record<string, unknown>>; } catch { /* first run */ }
  const successful = report.successful === true && report.under60Seconds === true;
  const previousConsecutive = Number(history.at(-1)?.consecutiveSuccessfulUnder60 ?? 0);
  const entry = { at: new Date().toISOString(), passId: report.passId, successful, lagSeconds: report.lagSeconds, consecutiveSuccessfulUnder60: successful ? previousConsecutive + 1 : 0 };
  history.push(entry);
  await writeFile(filename, `${JSON.stringify(history.slice(-100), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { ...entry, ready: entry.consecutiveSuccessfulUnder60 >= 3 };
}

async function listState(options: Args): Promise<Record<string, unknown>> {
  const directory = path.join(stateDirectory(options), "state");
  try {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    const states = await Promise.all(files.map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"))));
    return { directory, states };
  } catch { return { directory, states: [] }; }
}

async function latestManifests(options: Args): Promise<Record<string, unknown>> {
  const directory = path.join(stateDirectory(options), "manifests");
  try {
    const limit = numberOption(options, "limit", 5, 100);
    const passes = (await readdir(directory)).sort().reverse();
    const manifests: unknown[] = [];
    for (const pass of passes) {
      const passDir = path.join(directory, pass);
      const files = (await readdir(passDir)).filter((name) => name.endsWith(".json")).sort().reverse();
      for (const file of files) {
        manifests.push(JSON.parse(await readFile(path.join(passDir, file), "utf8")));
        if (manifests.length >= limit) return { directory, manifests };
      }
    }
    return { directory, manifests };
  } catch { return { directory, passes: [] }; }
}

async function latestReports(options: Args): Promise<unknown[]> {
  const directory = path.join(stateDirectory(options), "reports");
  try {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort().reverse().slice(0, 3);
    return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(directory, file), "utf8"))));
  } catch { return []; }
}

async function readinessStatus(options: Args): Promise<Record<string, unknown> | null> {
  try {
    const history = JSON.parse(await readFile(path.join(stateDirectory(options), "readiness.json"), "utf8")) as Array<Record<string, unknown>>;
    return history.at(-1) ?? null;
  } catch { return null; }
}

function humanSummary(command: string, output: unknown): string {
  const value = output as Record<string, unknown>;
  if (value.passId) return `Phase 8 ${value.apply ? "apply" : "dry-run"} pass ${value.passId}: ${value.successful ? "SUCCESS" : "NOT READY"}; lag=${value.lagSeconds ?? "n/a"}s.`;
  if (command === "lag") return `Phase 8 lag: ${value.globalMaximumLagSeconds ?? "unknown"}s; under 60s=${String(value.under60Seconds)}.`;
  if (command === "reconcile") return `Phase 8 reconciliation: ${value.passed === true ? "PASS" : "FAIL"}.`;
  if (command === "sample-report") return "Synthetic local Phase 8 evidence generated; no database connection was made.";
  return `Phase 8 migration command '${command}' completed.`;
}

function help(): string {
  return `BrawlRanks DATASET Phase 8 migration CLI
  inspect-config | test-source | test-target | init-state
  dry-run --family <family|table> | apply --family <family|table>
  pass [--apply] | repeat --passes N [--apply]
  reconcile | resume [--family ...] | state | manifests | lag
  readiness --passes 3 | export-report --out <file> | sample-report

Apply is never implicit. workflow_locks deletion additionally requires --allow-reconcile-delete.`;
}

async function main(): Promise<void> {
  const { command, options } = args(process.argv);
  let output: unknown;
  if (command === "help") output = { help: help() };
  else if (command === "sample-report") output = {
    evidence: "synthetic-local-only-no-database-connection",
    cursorState: { table: "raw_api_snapshots", cursor: { timestamp: "2026-07-21T00:00:30.000Z", id: "00000000-0000-0000-0000-000000000030" }, upperWatermark: { timestamp: "2026-07-21T00:00:59.000Z", id: "00000000-0000-0000-0000-000000000059" }, status: "running", pageNumber: 2 },
    pageManifest: { passId: "local-sample-pass", family: "raw-data", table: "raw_api_snapshots", lowerCursor: { timestamp: "2026-07-21T00:00:00.000Z", id: "" }, upperWatermark: { timestamp: "2026-07-21T00:00:59.000Z", id: "00000000-0000-0000-0000-000000000059" }, firstKey: "id=...001", lastKey: "id=...030", sourceRowCount: 30, insertedCount: 0, updatedCount: 0, matchedCount: 30, deletedCount: 0, sourceChecksum: "0".repeat(64), targetVerificationChecksum: "0".repeat(64), durationMs: 12, retryCount: 0, status: "completed" },
    reconciliation: { passed: true, antiJoins: { raw_snapshot_id: { sourceOnly: 0, targetOnly: 0 } }, childGraphs: { battle_teams: { match: true }, battle_participants: { match: true }, battle_observations: { match: true } }, publishedPointerMatch: true },
    lag: { globalMaximumLagSeconds: 29, under60Seconds: true, consecutiveSuccessfulUnder60: 1, ready: false },
  };
  else if (command === "inspect-config") output = inspectConfig();
  else if (command === "test-source") output = await connectionTest("source");
  else if (command === "test-target") output = await connectionTest("target");
  else if (command === "init-state") { const store = new FileStateStore(stateDirectory(options)); await store.initialize(); output = { initialized: true, directory: stateDirectory(options), schemaMutation: false }; }
  else if (command === "dry-run") output = await runSelection(options, false);
  else if (command === "apply") output = await runSelection(options, true);
  else if (command === "pass") output = await runSelection({ ...options, family: "all" }, options.apply === true);
  else if (command === "resume") output = await runSelection(options, options.apply === true);
  else if (command === "repeat") {
    const count = numberOption(options, "passes", 1, 100); const passes = [];
    for (let i = 0; i < count; i += 1) passes.push(await runSelection({ ...options, family: "all" }, options.apply === true));
    output = { passes };
  } else if (command === "reconcile") {
    const db = await pools(); try { await assertRuntimeDifferent(db.source, db.target); await assertSourceReadOnly(db.source); output = await globalReconciliation(db.source, db.target, numberOption(options, "page-size", 1000, 5000)); } finally { await Promise.all([db.source.end(), db.target.end()]); }
  } else if (command === "state") output = await listState(options);
  else if (command === "manifests") output = await latestManifests(options);
  else if (command === "lag") output = await lagReport(options);
  else if (command === "readiness") {
    const count = numberOption(options, "passes", 3, 10); const passes = [];
    for (let i = 0; i < count; i += 1) { const report = await runSelection({ ...options, family: "all" }, options.apply === true); passes.push({ report, readiness: await recordReadiness(stateDirectory(options), report) }); }
    output = { passes, ready: passes.at(-1)?.readiness.ready === true };
  } else if (command === "export-report") {
    const out = path.resolve(String(options.out ?? "phase8-validation-report.json"));
    const readiness = await readinessStatus(options);
    const report = { generatedAt: new Date().toISOString(), phase8ProductionValidated: Number(readiness?.consecutiveSuccessfulUnder60 ?? 0) >= 3, readiness, latestPassReports: await latestReports(options), state: await listState(options), manifests: await latestManifests(options), lag: await lagReport(options) };
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); output = { exported: out };
  } else throw new Error(`Unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (options.json !== true) process.stderr.write(`${humanSummary(command, output)}\n`);
}

main().catch((error) => {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
});
