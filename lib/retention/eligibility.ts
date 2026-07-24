/**
 * DATASET Phase 5 — retention eligibility & reference guards.
 *
 * Pure computation (no DB, no IO) so every guard is unit-tested directly. A
 * thin reader (repository.ts) fetches the small metadata/reference inputs; this
 * module decides which runs' CHILD rows are archive/deletion candidates and,
 * for every BLOCKED run, exactly why.
 *
 * Run METADATA (aggregation_runs, ranking_runs) is never a deletion candidate —
 * only child/detail rows are, and only when a run is `eligible` here AND every
 * downstream hard gate (archive, double-verify, staging re-import, manifest)
 * has also passed (enforced in deletion.ts, not here).
 */

export type RunKind = "aggregation_run" | "ranking_run";

export type BlockReason =
  | "not_succeeded"
  | "hot_recent_triple"
  | "referenced_by_ranking_run"
  | "referenced_by_published_snapshot"
  | "workflow_non_terminal"
  | "retention_hold"
  | "current_held_or_published"
  | "within_90_day_window";

/** Workflow statuses that mean "still active" — a run under one is never touched. */
// The current schema uses running/held, while queued/retrying are accepted here
// deliberately so a future workflow vocabulary expansion fails safe without a
// retention-code deployment racing it.
const NON_TERMINAL_WORKFLOW = new Set(["queued", "running", "retrying", "held"]);
const SUCCEEDED_AGG = new Set(["succeeded", "succeeded_with_warnings"]);

export interface AggregationRunRow {
  id: string;
  workflowRunId: string;
  scope: "overall" | "per_mode" | "matchup";
  status: string;
  startedAt: Date;
}
export interface RankingRunRow {
  id: string;
  workflowRunId: string;
  status: string;
  modeAggregationRunId: string;
  overallAggregationRunId: string;
  matchupAggregationRunId: string;
  startedAt: Date;
}
export interface WorkflowRunRow {
  id: string;
  status: string;
}
export interface PublishedSnapshotRow {
  rankingRunId: string;
}
export interface HoldRow {
  targetKind: string;
  targetId: string;
}

export interface EligibilityInputs {
  aggregationRuns: AggregationRunRow[];
  rankingRuns: RankingRunRow[];
  workflowRuns: WorkflowRunRow[];
  publishedSnapshots: PublishedSnapshotRow[];
  openHolds: HoldRow[];
}

export interface EligibilityOptions {
  hotTripleCount?: number; // default 3 (current + previous two)
  rankingRetentionDays?: number; // default 90
  now?: Date;
}

export interface RunEligibility {
  runKind: RunKind;
  runId: string;
  status: string;
  workflowRunId: string;
  eligible: boolean;
  blockReasons: BlockReason[];
}

function workflowStatusMap(inputs: EligibilityInputs): Map<string, string> {
  return new Map(inputs.workflowRuns.map((w) => [w.id, w.status]));
}

function holdSet(inputs: EligibilityInputs, kind: string): Set<string> {
  return new Set(inputs.openHolds.filter((h) => h.targetKind === kind).map((h) => h.targetId));
}
function workflowHoldSet(inputs: EligibilityInputs): Set<string> {
  return new Set(inputs.openHolds.filter((h) => h.targetKind === "workflow_run").map((h) => h.targetId));
}

/**
 * The current + previous two FULLY successful aggregation triples. A triple is
 * one workflow_run_id whose three scoped runs (overall, per_mode, matchup) are
 * all present and succeeded. Ordered by the triple's most recent started_at.
 * Returns the set of hot workflow_run_ids.
 */
export function identifyHotTriples(inputs: EligibilityInputs, hotTripleCount = 3): Set<string> {
  const byWorkflow = new Map<string, { scopes: Set<string>; allSucceeded: boolean; latest: number }>();
  for (const run of inputs.aggregationRuns) {
    const entry = byWorkflow.get(run.workflowRunId) ?? { scopes: new Set(), allSucceeded: true, latest: 0 };
    entry.scopes.add(run.scope);
    if (!SUCCEEDED_AGG.has(run.status)) entry.allSucceeded = false;
    entry.latest = Math.max(entry.latest, run.startedAt.getTime());
    byWorkflow.set(run.workflowRunId, entry);
  }
  const completeTriples = [...byWorkflow.entries()]
    .filter(([, e]) => e.allSucceeded && e.scopes.has("overall") && e.scopes.has("per_mode") && e.scopes.has("matchup"))
    .sort((a, b) => b[1].latest - a[1].latest || a[0].localeCompare(b[0]))
    .slice(0, hotTripleCount)
    .map(([workflowRunId]) => workflowRunId);
  return new Set(completeTriples);
}

/** aggregation_run ids referenced by ANY ranking_run (any of its three FKs). */
function aggRunsReferencedByRanking(inputs: EligibilityInputs): Set<string> {
  const set = new Set<string>();
  for (const r of inputs.rankingRuns) {
    set.add(r.modeAggregationRunId);
    set.add(r.overallAggregationRunId);
    set.add(r.matchupAggregationRunId);
  }
  return set;
}

/** ranking_run ids referenced by ANY published_snapshot. */
function rankingRunsPublished(inputs: EligibilityInputs): Set<string> {
  return new Set(inputs.publishedSnapshots.map((p) => p.rankingRunId));
}

/** aggregation_run ids reachable from a published_snapshot via its ranking_run. */
function aggRunsPublishedTransitive(inputs: EligibilityInputs): Set<string> {
  const publishedRanking = rankingRunsPublished(inputs);
  const set = new Set<string>();
  for (const r of inputs.rankingRuns) {
    if (!publishedRanking.has(r.id)) continue;
    set.add(r.modeAggregationRunId);
    set.add(r.overallAggregationRunId);
    set.add(r.matchupAggregationRunId);
  }
  return set;
}

export function computeAggregationEligibility(inputs: EligibilityInputs, opts: EligibilityOptions = {}): RunEligibility[] {
  const hot = identifyHotTriples(inputs, opts.hotTripleCount ?? 3);
  const referencedByRanking = aggRunsReferencedByRanking(inputs);
  const publishedTransitive = aggRunsPublishedTransitive(inputs);
  const wfStatus = workflowStatusMap(inputs);
  const aggHolds = holdSet(inputs, "aggregation_run");
  const wfHolds = workflowHoldSet(inputs);

  return inputs.aggregationRuns.map((run) => {
    const reasons: BlockReason[] = [];
    if (!SUCCEEDED_AGG.has(run.status)) reasons.push("not_succeeded");
    if (hot.has(run.workflowRunId)) reasons.push("hot_recent_triple");
    if (referencedByRanking.has(run.id)) reasons.push("referenced_by_ranking_run");
    if (publishedTransitive.has(run.id)) reasons.push("referenced_by_published_snapshot");
    if (NON_TERMINAL_WORKFLOW.has(wfStatus.get(run.workflowRunId) ?? "")) reasons.push("workflow_non_terminal");
    if (aggHolds.has(run.id) || wfHolds.has(run.workflowRunId)) reasons.push("retention_hold");
    return {
      runKind: "aggregation_run",
      runId: run.id,
      status: run.status,
      workflowRunId: run.workflowRunId,
      eligible: reasons.length === 0,
      blockReasons: reasons,
    };
  });
}

export function computeRankingEligibility(inputs: EligibilityInputs, opts: EligibilityOptions = {}): RunEligibility[] {
  const now = opts.now ?? new Date();
  const retentionDays = opts.rankingRetentionDays ?? 90;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const published = rankingRunsPublished(inputs);
  const wfStatus = workflowStatusMap(inputs);
  const rankHolds = holdSet(inputs, "ranking_run");
  const wfHolds = workflowHoldSet(inputs);
  const newestSuccessfulStartedAt = inputs.rankingRuns
    .filter((run) => run.status === "succeeded")
    .reduce((latest, run) => Math.max(latest, run.startedAt.getTime()), Number.NEGATIVE_INFINITY);

  return inputs.rankingRuns.map((run) => {
    const reasons: BlockReason[] = [];
    // Only a cleanly-succeeded run has a complete, safe-to-archive candidate set.
    if (run.status !== "succeeded") reasons.push("not_succeeded");
    if (
      run.status === "held" ||
      published.has(run.id) ||
      (run.status === "succeeded" && run.startedAt.getTime() === newestSuccessfulStartedAt)
    ) reasons.push("current_held_or_published");
    if (run.startedAt.getTime() >= cutoff.getTime()) reasons.push("within_90_day_window");
    if (NON_TERMINAL_WORKFLOW.has(wfStatus.get(run.workflowRunId) ?? "")) reasons.push("workflow_non_terminal");
    if (rankHolds.has(run.id) || wfHolds.has(run.workflowRunId)) reasons.push("retention_hold");
    return {
      runKind: "ranking_run",
      runId: run.id,
      status: run.status,
      workflowRunId: run.workflowRunId,
      eligible: reasons.length === 0,
      blockReasons: [...new Set(reasons)],
    };
  });
}
