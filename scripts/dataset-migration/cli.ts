#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { assertDifferentDatabases, createEndpointPool, inspectConfig, redactSecrets, resolveEndpoint, safeIdentity } from "./config";
import { syncTable, type TableReport } from "./engine";
import { FAMILY_ORDER, plansFor, TABLE_PLANS, type TablePlan } from "./model";
import { FileStateStore } from "./state";
import { globalReconciliation, reconcileCurrentPublication } from "./validation";
import { assessSourceGrants, createSourceReader, type SourceReader } from "./source-reader";
import { normalizeTimestamp } from "./timestamp";
import { assertInventoryReady, discoverTableInventory, skippedTableReport, type SkippedTableReport } from "./inventory";
import { formatProgressLine, MigrationProgressTracker } from "./progress";
import {
  resolveScope, scopePlans, scopeManifestHash, scopeStateIdentity, summarizeScope,
  type ScopeStateIdentity, type ScopeSummary,
} from "./scope";
import { applySimulated, PageCursorSimulation, type SimRow } from "./simulation";

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

async function pools(): Promise<{ source: SourceReader; target: Pool; sourceIdentity: string; targetIdentity: string }> {
  const sourceConfig = resolveEndpoint("source"), targetConfig = resolveEndpoint("target");
  assertDifferentDatabases(sourceConfig, targetConfig);
  return { source: createSourceReader(createEndpointPool(sourceConfig)), target: createEndpointPool(targetConfig), sourceIdentity: safeIdentity(sourceConfig), targetIdentity: safeIdentity(targetConfig) };
}

async function runtimeIdentity(pool: Pick<Pool, "query">): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT @@hostname hostname, @@port port, DATABASE() db");
  return `${rows[0].hostname}:${rows[0].port}/${rows[0].db}`.toLowerCase();
}

async function assertRuntimeDifferent(source: SourceReader, target: Pool): Promise<void> {
  const [a, b] = await Promise.all([runtimeIdentity(source), runtimeIdentity(target)]);
  if (a === b) throw new Error("Source and target identify as the same runtime database; refusing execution");
}

async function inspectSourceGrants(source: SourceReader): Promise<ReturnType<typeof assessSourceGrants>> {
  const [rows] = await source.query<RowDataPacket[]>("SHOW GRANTS FOR CURRENT_USER");
  const grants = rows.flatMap((row) => Object.values(row).map(String)).join("\n").toUpperCase();
  const assessment = assessSourceGrants(grants);
  if (!assessment.selectAvailable) throw new Error("Source database user does not have SELECT privilege");
  return assessment;
}

async function connectionTest(role: "source" | "target"): Promise<Record<string, unknown>> {
  const config = resolveEndpoint(role);
  const pool = createEndpointPool(config);
  const source = role === "source" ? createSourceReader(pool) : null;
  try {
    const queryable = source ?? pool;
    const [rows] = await queryable.query<RowDataPacket[]>("SELECT VERSION() version, DATABASE() db, @@hostname hostname");
    const leastPrivilege = source ? await inspectSourceGrants(source) : null;
    return { ok: true, role, identity: safeIdentity(config), server: { version: rows[0].version, database: rows[0].db, hostname: rows[0].hostname }, tls: true, sourceSqlInvariant: source ? "SELECT_SHOW_ONLY" : undefined, leastPrivilege };
  } finally { await (source ?? pool).end(); }
}

interface ResolvedSelection {
  name: string;
  plans: TablePlan[];
  includedTables: Set<string>;
  reconcilePublication: boolean;
  runGlobalReconciliation: boolean;
  currentPublicationOnly: boolean;
  stateIdentity: ScopeStateIdentity;
  summary: ScopeSummary | null;
  tier: string;
}

/**
 * Resolves what a pass will touch. An explicit `--scope`/`--profile` uses the
 * centralized scope registry (fail-closed on unknown names). Otherwise the
 * legacy `--family`/`--table` selection is preserved for backward compatibility;
 * legacy runs share a single "legacy" state identity so existing resume-by-family
 * flows keep working, while an explicit scope binds its own identity.
 */
function resolveSelection(options: Args, mode: "dry-run" | "apply"): ResolvedSelection {
  const scopeName = options.scope ?? options.profile;
  if (scopeName !== undefined && scopeName !== true) {
    const definition = resolveScope(String(scopeName));
    const plans = scopePlans(definition);
    return {
      name: definition.name,
      plans,
      includedTables: new Set(plans.map((plan) => plan.table)),
      reconcilePublication: definition.reconcileCurrentPublication,
      runGlobalReconciliation: definition.scopedReconciliation,
      currentPublicationOnly: definition.currentPublicationOnly,
      stateIdentity: scopeStateIdentity(definition),
      summary: summarizeScope(definition, mode),
      tier: definition.tier,
    };
  }
  const selected = String(options.family ?? options.table ?? "all");
  const plans = plansFor(selected); // throws on unknown family/table (fail-closed)
  return {
    name: selected,
    plans,
    includedTables: new Set(plans.map((plan) => plan.table)),
    reconcilePublication: selected === "all" || selected === "derived-public" || selected === "published_snapshots",
    runGlobalReconciliation: selected === "all",
    currentPublicationOnly: false,
    // Legacy selections interoperate within one directory as before.
    stateIdentity: { scope: "legacy", version: 1, manifestHash: "legacy" },
    summary: null,
    tier: selected === "all" ? "all" : "legacy",
  };
}

async function runSelection(options: Args, apply: boolean, repeatedPassId?: string): Promise<Record<string, unknown>> {
  const selection = resolveSelection(options, apply ? "apply" : "dry-run");
  const selected = selection.name;
  const selectedPlans = selection.plans;
  const pageSize = numberOption(options, "page-size", 500, 5000);
  const maxRetries = numberOption(options, "retries", 3, 10);
  const overlapSeconds = numberOption(options, "overlap-seconds", 300, 86400);
  const watchdogSeconds = numberOption(options, "watchdog-seconds", 900, 7200);
  const progressEveryPages = numberOption(options, "progress-every-pages", 1, 1000);
  const base = stateDirectory(options);
  // Dry-run diagnostics are durable but isolated from authoritative apply cursors.
  const store = new FileStateStore(apply ? base : path.join(base, "dry-run"));
  await store.initialize();
  // Fail closed if this directory was created for a different scope/manifest.
  await store.bindScope(selection.stateIdentity);
  const passId = repeatedPassId ?? randomUUID();
  const startedAt = new Date().toISOString();
  await store.writeRunMetadata(passId, {
    version: 1, passId, status: "starting", mode: apply ? "apply" : "dry-run", selected,
    scope: selection.name, tier: selection.tier, scopeIdentity: selection.stateIdentity, scopeSummary: selection.summary,
    pageSize, maxRetries, overlapSeconds, watchdogSeconds, startedAt,
    diagnosticDirectory: store.directory,
  });
  const debug = options.debug === true;
  const progress = new MigrationProgressTracker(passId, watchdogSeconds * 1000, async (event) => {
    const safeEvent = event.error ? { ...event, error: redactSecrets(event.error) } : event;
    await store.writeDiagnostic(passId, safeEvent);
    const pageDue = safeEvent.stage !== "page_completed" || (safeEvent.pageNumber ?? 0) % progressEveryPages === 0;
    const ordinary = ["run_started", "preflight", "family_started", "family_completed", "table_started", "page_completed", "table_completed", "table_skipped", "run_completed", "failed"].includes(safeEvent.stage);
    if (pageDue && (debug || ordinary)) process.stderr.write(`${formatProgressLine(safeEvent)}\n`);
  });
  let db: Awaited<ReturnType<typeof pools>> | null = null;
  const reports: Array<TableReport | SkippedTableReport> = [];
  try {
    await progress.emit("run_started");
    db = await pools();
    await assertRuntimeDifferent(db.source, db.target);
    await inspectSourceGrants(db.source);
    const inventory = await progress.query("inventory_preflight", () => discoverTableInventory(db!.source, db!.target));
    assertInventoryReady(inventory, new Set(selectedPlans.map((plan) => plan.table)));
    await progress.emit("preflight");
    // Explicit, secret-free preflight so the operator can confirm exactly what
    // this pass will and will not touch before any target write.
    const skippedOptional = inventory
      .filter((entry) => entry.action === "skip" && selection.includedTables.has(entry.table))
      .map((entry) => entry.table);
    const preflight = {
      phase8ScopePreflight: {
        scope: selection.name,
        tier: selection.tier,
        mode: apply ? "apply" : "dry-run",
        source: db.sourceIdentity,
        target: db.targetIdentity,
        stateDirectory: store.directory,
        currentPublicationOnly: selection.currentPublicationOnly,
        includedTables: selectedPlans.map((plan) => plan.table),
        dependencyExpandedTables: selection.summary?.dependencyExpandedTables ?? [],
        skippedOptionalTables: skippedOptional,
        excludedTables: selection.summary?.excludedTables ?? [],
        excludedBulkHistory: selection.summary?.excludedBulkHistory ?? [],
        manifestHash: selection.stateIdentity.manifestHash,
      },
    };
    process.stderr.write(`${JSON.stringify(preflight)}\n`);
    await store.writeRunMetadata(passId, {
      version: 1, passId, status: "running", mode: apply ? "apply" : "dry-run", selected,
      scope: selection.name, tier: selection.tier, ...preflight,
      pageSize, maxRetries, overlapSeconds, watchdogSeconds, startedAt,
      sourceIdentity: db.sourceIdentity, targetIdentity: db.targetIdentity,
    });

    let activeFamily: string | null = null;
    for (const plan of selectedPlans) {
      if (activeFamily !== plan.family) {
        if (activeFamily) await progress.emit("family_completed", { family: activeFamily });
        activeFamily = plan.family;
        await progress.emit("family_started", { family: activeFamily });
      }
      const entry = inventory.find((item) => item.table === plan.table)!;
      if (entry.action === "skip") {
        await progress.emit("table_started", { family: plan.family, table: plan.table, pageNumber: 0 });
        reports.push(skippedTableReport(entry, passId, apply));
        await progress.emit("table_skipped", { family: plan.family, table: plan.table, pageNumber: 0, rowsRead: 0 });
        continue;
      }
      reports.push(await syncTable(db.source, db.target, store, plan, {
        apply, pageSize, maxRetries, overlapSeconds,
        allowReconcileDelete: options["allow-reconcile-delete"] === true,
        sourceIdentity: db.sourceIdentity, targetIdentity: db.targetIdentity, passId, progress,
      }));
    }
    if (activeFamily) await progress.emit("family_completed", { family: activeFamily });
    const publication = selection.reconcilePublication
      ? await progress.query("current_publication_reconciliation", () => reconcileCurrentPublication(db!.source, db!.target, apply))
      : null;
    const workflowLockWatermark = reports.find((report) => report.table === "workflow_locks")?.sourceTimeWatermark ?? undefined;
    const synchronizedTables = new Set(inventory.filter((entry) => entry.action === "sync").map((entry) => entry.table));
    // Scoped reconciliation: for Tier-1 this limits the checks to in-scope tables
    // so anti-joins on deliberately un-synced battle/raw history do not misfire.
    const reconciliationTables = selection.name === "all"
      ? synchronizedTables
      : new Set([...selection.includedTables].filter((table) => synchronizedTables.has(table)));
    const reconciliation = selection.runGlobalReconciliation
      ? await progress.query("global_reconciliation", () => globalReconciliation(db!.source, db!.target, pageSize, { workflowLockSourceTimeWatermark: workflowLockWatermark ?? undefined, includedTables: reconciliationTables }))
      : null;
    const lagSeconds = Math.max(0, ...reports.map((report) => typeof report.lagSeconds === "number" ? report.lagSeconds : 0));
    const result = { passId, apply, scope: selection.name, tier: selection.tier, scopeSummary: selection.summary, familyOrder: FAMILY_ORDER, inventory, reports, publication, reconciliation, lagSeconds, under60Seconds: lagSeconds < 60, successful: reports.every((report) => (report.status === "completed" || report.status === "skipped_absent_source_table") && report.deletionRequired !== true) && (publication ? publication.matched === true : true) && (reconciliation ? reconciliation.passed === true : true) };
    await store.writeReport(passId, result);
    await store.writeRunMetadata(passId, { version: 1, passId, status: "completed", mode: apply ? "apply" : "dry-run", selected, pageSize, startedAt, completedAt: new Date().toISOString(), successful: result.successful });
    await progress.emit("run_completed");
    return result;
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    await store.writeRunMetadata(passId, { version: 1, passId, status: "failed", mode: apply ? "apply" : "dry-run", selected, pageSize, startedAt, failedAt: new Date().toISOString(), error: message, progress: progress.snapshot() });
    await store.writeDiagnostic(passId, { at: new Date().toISOString(), passId, stage: "failed", error: message, ...progress.snapshot() });
    process.stderr.write(`phase8-progress stage=failed error=${JSON.stringify(message)}\n`);
    throw error;
  } finally {
    progress.close();
    if (db) await Promise.all([db.source.end(), db.target.end()]);
  }
}

async function lagReport(options: Args): Promise<Record<string, unknown>> {
  const db = await pools();
  const store = new FileStateStore(stateDirectory(options));
  const families: Record<string, unknown> = {};
  let global = 0;
  try {
    await assertRuntimeDifferent(db.source, db.target);
    await inspectSourceGrants(db.source);
    const inventory = await discoverTableInventory(db.source, db.target);
    assertInventoryReady(inventory);
    const syncTables = new Set(inventory.filter((entry) => entry.action === "sync").map((entry) => entry.table));
    for (const plan of TABLE_PLANS.filter((item) => item.cursorColumn && syncTables.has(item.table))) {
      const state = await store.read(plan.table);
      const [rows] = await db.source.query<RowDataPacket[]>(`SELECT MAX(\`${plan.cursorColumn}\`) latest FROM \`${plan.table}\``);
      const latest = normalizeTimestamp(rows[0].latest, { family: plan.family, table: plan.table, column: plan.cursorColumn!, operation: "latest eligible source lag watermark", nullable: true });
      const completed = state?.status === "completed" && state.cursor
        ? normalizeTimestamp(state.cursor.timestamp, { family: plan.family, table: plan.table, column: plan.cursorColumn!, operation: "completed durable cursor lag calculation", nullable: false })
        : null;
      const lag = latest && completed ? Math.max(0, (new Date(latest).getTime() - new Date(completed).getTime()) / 1000) : null;
      if (lag !== null) global = Math.max(global, lag);
      families[plan.table] = { latestEligibleSource: latest, completedCursor: completed, lagSeconds: lag, stateStatus: state?.status ?? "missing" };
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
  // Readiness is scope-specific: a change of scope resets the streak so a Tier-1
  // readiness count can never be satisfied by earlier full-history passes.
  const scope = report.scope ?? "all";
  const previous = history.at(-1);
  const previousConsecutive = previous?.scope === scope ? Number(previous?.consecutiveSuccessfulUnder60 ?? 0) : 0;
  const entry = { at: new Date().toISOString(), passId: report.passId, scope, tier: report.tier ?? null, successful, lagSeconds: report.lagSeconds, consecutiveSuccessfulUnder60: successful ? previousConsecutive + 1 : 0 };
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
  const configuredWarnings = Array.isArray(value.warnings) ? value.warnings.map(String) : [];
  const grantWarning = (value.leastPrivilege as { warning?: string | null } | undefined)?.warning;
  const warning = grantWarning ?? configuredWarnings[0];
  if ((command === "inspect-config" || command === "test-source") && warning) return `Phase 8 migration command '${command}' completed. WARNING: ${warning}`;
  if (command === "scope-preview") return `Phase 8 scope-preview (${value.scope && (value.scope as { scope?: string }).scope}) self-checks ${value.ok ? "PASS" : "FAIL"}; no database connection was made.`;
  if (value.passId) return `Phase 8 ${value.apply ? "apply" : "dry-run"} pass ${value.passId} [scope=${value.scope ?? "all"}]: ${value.successful ? "SUCCESS" : "NOT READY"}; lag=${value.lagSeconds ?? "n/a"}s.`;
  if (command === "lag") return `Phase 8 lag: ${value.globalMaximumLagSeconds ?? "unknown"}s; under 60s=${String(value.under60Seconds)}.`;
  if (command === "reconcile") return `Phase 8 reconciliation: ${value.passed === true ? "PASS" : "FAIL"}.`;
  if (command === "sample-report") return "Synthetic local Phase 8 evidence generated; no database connection was made.";
  return `Phase 8 migration command '${command}' completed.`;
}

/** Preserves the legacy full-history default only when no selection is given. */
function withDefaultSelection(options: Args): Args {
  if (options.scope !== undefined || options.profile !== undefined || options.family !== undefined || options.table !== undefined) return options;
  return { ...options, family: "all" };
}

/**
 * Local, synthetic, credential-free validation of a scope. It never connects to
 * a database: it resolves the scope, proves the manifest is deterministic, and
 * exercises the safety invariants (state-dir scope binding, no-advance-on-page-
 * failure, dry-run no-mutation) against fixtures in a temporary directory.
 */
async function scopePreview(options: Args): Promise<Record<string, unknown>> {
  const scopeName = String(options.scope ?? options.profile ?? "tier-1");
  const definition = resolveScope(scopeName); // fail-closed on unknown
  const summary = summarizeScope(definition, "dry-run");
  const plans = scopePlans(definition);

  // Determinism: resolving/serializing twice must be byte-identical.
  const hashA = scopeManifestHash(definition);
  const hashB = scopeManifestHash(resolveScope(scopeName));
  const orderA = plans.map((plan) => plan.table);
  const orderB = scopePlans(resolveScope(scopeName)).map((plan) => plan.table);
  const deterministic = hashA === hashB && JSON.stringify(orderA) === JSON.stringify(orderB);

  // Dependency order: every parent appears before its child in the manifest.
  const position = new Map(orderA.map((table, index) => [table, index] as const));
  const parentBeforeChild = plans.every((plan) => !plan.parent || !position.has(plan.parent.table) || position.get(plan.parent.table)! < position.get(plan.table)!);

  // State-directory scope binding (in a disposable temp dir; no DB).
  let bindingAcceptsSameScope = false;
  let bindingRejectsForeignScope = false;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "phase8-scope-preview-"));
  try {
    const store = new FileStateStore(tmp);
    await store.initialize();
    await store.bindScope(scopeStateIdentity(definition));
    try { await store.bindScope(scopeStateIdentity(definition)); bindingAcceptsSameScope = true; } catch { bindingAcceptsSameScope = false; }
    const otherName = definition.name === "all" ? "tier-1" : "all";
    try { await store.bindScope(scopeStateIdentity(resolveScope(otherName))); bindingRejectsForeignScope = false; } catch { bindingRejectsForeignScope = true; }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // Cursor safety + dry-run no-mutation, using the deterministic simulation.
  const sampleRows: SimRow[] = [
    { id: "a", timestamp: "2026-01-01T00:00:00.000Z", key: "a", content: "1" },
    { id: "b", timestamp: "2026-01-01T00:00:01.000Z", key: "b", content: "2" },
  ];
  const cursor = new PageCursorSimulation();
  let cursorHeldOnFailure = false;
  try { cursor.apply(sampleRows, true); } catch { cursorHeldOnFailure = cursor.cursor === null; }
  cursor.apply(sampleRows, false);
  const cursorAdvancesOnSuccess = cursor.cursor?.id === "b";
  const target = new Map<string, SimRow>(sampleRows.map((row) => [row.key, { ...row }]));
  const dryRunNoMutation = applySimulated({ ...sampleRows[0] }, target, true) === "matched" && target.size === sampleRows.length;

  const selfChecks = { deterministic, parentBeforeChild, bindingAcceptsSameScope, bindingRejectsForeignScope, cursorHeldOnFailure, cursorAdvancesOnSuccess, dryRunNoMutation };
  const ok = Object.values(selfChecks).every(Boolean);
  if (!ok) process.exitCode = 1;
  return { command: "scope-preview", databaseConnection: false, scope: summary, manifestHash: hashA, selfChecks, ok };
}

function help(): string {
  return `BrawlRanks DATASET Phase 8 migration CLI
  inspect-config | test-source | test-target | init-state
  dry-run [--scope tier-1|all | --family <family|table>] | apply [--scope ...]
  pass [--scope ...] [--apply] | repeat --passes N [--scope ...] [--apply]
  preflight | reconcile | resume [--scope ...|--family ...] | state | manifests | lag
  readiness --passes 3 [--scope ...] | export-report --out <file> | sample-report
  scope-preview [--scope tier-1|all]   (local synthetic self-check; no database)

Scopes (centralized in scope.ts, fail-closed on unknown names):
  tier-1  Minimum continuity state for writer cutover (Phase 8 Tier-1).
          Excludes all historical battle/raw/observed-player/aggregate bulk.
  all     Full historical synchronization (Tier-1 + Tier-2 + Tier-3).
A --state-dir is bound to one scope; reusing it for another scope fails closed.

Dry-run progress defaults to every page with a 900-second CPU-inactivity watchdog.
Use --progress-every-pages N, --watchdog-seconds N, and --debug for query-stage logs.
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
  else if (command === "preflight") {
    const db = await pools();
    try {
      await assertRuntimeDifferent(db.source, db.target); await inspectSourceGrants(db.source);
      const inventory = await discoverTableInventory(db.source, db.target);
      output = { ok: !inventory.some((entry) => entry.action === "fatal"), inventory };
      if ((output as { ok: boolean }).ok === false) process.exitCode = 1;
    } finally { await Promise.all([db.source.end(), db.target.end()]); }
  }
  else if (command === "init-state") { const store = new FileStateStore(stateDirectory(options)); await store.initialize(); output = { initialized: true, directory: stateDirectory(options), schemaMutation: false }; }
  else if (command === "scope-preview") output = await scopePreview(options);
  else if (command === "dry-run") output = await runSelection(options, false);
  else if (command === "apply") output = await runSelection(options, true);
  else if (command === "pass") output = await runSelection(withDefaultSelection(options), options.apply === true);
  else if (command === "resume") output = await runSelection(options, options.apply === true);
  else if (command === "repeat") {
    const count = numberOption(options, "passes", 1, 100); const passes = [];
    for (let i = 0; i < count; i += 1) passes.push(await runSelection(withDefaultSelection(options), options.apply === true));
    output = { passes };
  } else if (command === "reconcile") {
    const db = await pools(); try {
      await assertRuntimeDifferent(db.source, db.target); await inspectSourceGrants(db.source);
      const inventory = await discoverTableInventory(db.source, db.target); assertInventoryReady(inventory);
      output = await globalReconciliation(db.source, db.target, numberOption(options, "page-size", 1000, 5000), { includedTables: new Set(inventory.filter((entry) => entry.action === "sync").map((entry) => entry.table)) });
    } finally { await Promise.all([db.source.end(), db.target.end()]); }
  } else if (command === "state") output = await listState(options);
  else if (command === "manifests") output = await latestManifests(options);
  else if (command === "lag") output = await lagReport(options);
  else if (command === "readiness") {
    const count = numberOption(options, "passes", 3, 10); const passes = [];
    for (let i = 0; i < count; i += 1) { const report = await runSelection(withDefaultSelection(options), options.apply === true); passes.push({ report, readiness: await recordReadiness(stateDirectory(options), report) }); }
    output = { passes, scope: passes.at(-1)?.readiness.scope, ready: passes.at(-1)?.readiness.ready === true };
  } else if (command === "export-report") {
    const out = path.resolve(String(options.out ?? "phase8-validation-report.json"));
    const readiness = await readinessStatus(options);
    const report = { generatedAt: new Date().toISOString(), scope: readiness?.scope ?? null, phase8ProductionValidated: Number(readiness?.consecutiveSuccessfulUnder60 ?? 0) >= 3, readiness, latestPassReports: await latestReports(options), state: await listState(options), manifests: await latestManifests(options), lag: await lagReport(options) };
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); output = { exported: out };
  } else throw new Error(`Unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (options.json !== true) process.stderr.write(`${humanSummary(command, output)}\n`);
}

main().catch((error) => {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  const stack = error instanceof Error && error.stack ? redactSecrets(error.stack) : null;
  process.stderr.write(`${JSON.stringify({ ok: false, error: message, stack })}\n`);
  process.exitCode = 1;
});
