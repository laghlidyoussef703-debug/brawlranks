/**
 * DATASET Phase 5 — retention dry-run planner (READ-ONLY).
 *
 * Produces the exact deletion allowlist, the blocked runs with a reason for
 * every one, and per-(run, source table) child-row counts. Performs ZERO
 * writes. This is what runs by default and for the 7-day dry-run soak; nothing
 * here can delete or archive anything.
 */

import type { Pool, PoolConnection } from "mysql2/promise";
import {
  computeAggregationEligibility,
  computeRankingEligibility,
  type EligibilityOptions,
  type RunEligibility,
} from "./eligibility";
import {
  fetchEligibilityInputs,
  countChildRows,
  AGGREGATION_CHILD_TABLE,
  RANKING_CHILD_TABLES,
} from "./repository";

type Queryable = Pool | PoolConnection;

export interface PlannedTarget {
  runKind: "aggregation_run" | "ranking_run";
  runId: string;
  sourceTable: string;
  rowCount: number;
}
export interface BlockedRun {
  runKind: "aggregation_run" | "ranking_run";
  runId: string;
  status: string;
  reasons: string[];
}
export interface RetentionPlan {
  generatedAt: string;
  options: { hotTripleCount: number; rankingRetentionDays: number };
  allowlist: PlannedTarget[];
  eligibleRunIds: string[];
  blocked: BlockedRun[];
  totals: { eligibleRuns: number; blockedRuns: number; candidateRows: number };
}

async function targetsForEligibleAgg(db: Queryable, e: RunEligibility, scopeById: Map<string, string>): Promise<PlannedTarget[]> {
  const scope = scopeById.get(e.runId);
  if (!scope) return [];
  const table = AGGREGATION_CHILD_TABLE[scope];
  if (!table) return [];
  return [{ runKind: "aggregation_run", runId: e.runId, sourceTable: table, rowCount: await countChildRows(db, table, e.runId) }];
}
async function targetsForEligibleRanking(db: Queryable, e: RunEligibility): Promise<PlannedTarget[]> {
  const out: PlannedTarget[] = [];
  for (const table of RANKING_CHILD_TABLES) {
    out.push({ runKind: "ranking_run", runId: e.runId, sourceTable: table, rowCount: await countChildRows(db, table, e.runId) });
  }
  return out;
}

export async function planRetention(db: Queryable, opts: EligibilityOptions = {}): Promise<RetentionPlan> {
  const inputs = await fetchEligibilityInputs(db);
  const hotTripleCount = opts.hotTripleCount ?? 3;
  const rankingRetentionDays = opts.rankingRetentionDays ?? 90;

  const aggElig = computeAggregationEligibility(inputs, { ...opts, hotTripleCount });
  const rankElig = computeRankingEligibility(inputs, { ...opts, rankingRetentionDays });

  const scopeById = new Map(inputs.aggregationRuns.map((r) => [r.id, r.scope]));

  const allowlist: PlannedTarget[] = [];
  const eligibleRunIds: string[] = [];
  for (const e of aggElig) {
    if (!e.eligible) continue;
    eligibleRunIds.push(e.runId);
    allowlist.push(...(await targetsForEligibleAgg(db, e, scopeById)));
  }
  for (const e of rankElig) {
    if (!e.eligible) continue;
    eligibleRunIds.push(e.runId);
    allowlist.push(...(await targetsForEligibleRanking(db, e)));
  }

  const blocked: BlockedRun[] = [...aggElig, ...rankElig]
    .filter((e) => !e.eligible)
    .map((e) => ({ runKind: e.runKind, runId: e.runId, status: e.status, reasons: e.blockReasons }));

  const candidateRows = allowlist.reduce((n, t) => n + t.rowCount, 0);

  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    options: { hotTripleCount, rankingRetentionDays },
    allowlist,
    eligibleRunIds: [...new Set(eligibleRunIds)],
    blocked,
    totals: { eligibleRuns: eligibleRunIds.length, blockedRuns: blocked.length, candidateRows },
  };
}

/** Human-readable dry-run report. Zero writes; safe to log. */
export function formatPlanReport(plan: RetentionPlan): string {
  const lines: string[] = [];
  lines.push("DATASET Phase 5 — retention dry-run plan");
  lines.push(`generated: ${plan.generatedAt}`);
  lines.push(`options: keep ${plan.options.hotTripleCount} hot triples, ${plan.options.rankingRetentionDays}-day ranking window`);
  lines.push("");
  lines.push(`ELIGIBLE (allowlist): ${plan.totals.eligibleRuns} run(s), ${plan.totals.candidateRows} candidate child rows`);
  for (const t of plan.allowlist) {
    lines.push(`  + ${t.runKind} ${t.runId} :: ${t.sourceTable} (${t.rowCount} rows)`);
  }
  lines.push("");
  lines.push(`BLOCKED: ${plan.totals.blockedRuns} run(s)`);
  for (const b of plan.blocked) {
    lines.push(`  - ${b.runKind} ${b.runId} [${b.status}] :: ${b.reasons.join(", ")}`);
  }
  return lines.join("\n");
}
