/**
 * Operator held-run approval (Phase 11 controlled bootstrap approval).
 *
 * The first DigitalOcean ranking run is compared against the stale 2026-07-16
 * Hostinger snapshot, so the mass-movement guard legitimately HELD it
 * (tierMoveRatio≈0.648 > 0.25, hold_reason=mass_movement_guard). These DB-free
 * unit tests (fake pool injected via approveHeldRanking's `pool` seam) prove the
 * approval command's contract WITHOUT MySQL: it publishes an eligible held run
 * transactionally, rejects an unknown run, rejects an incomplete candidate,
 * no-ops an already-published run, and rolls the whole publish back (preserving
 * the previous snapshot) when any insert fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolConnection } from "mysql2/promise";

interface Events {
  supersede: number;
  snapshotInsert: number;
  itemInsert: number;
  matchupItemInsert: number;
  rankingRunUpdate: number;
  approvalStep: number;
  commit: boolean;
  rollback: boolean;
}

function makeEvents(): Events {
  return { supersede: 0, snapshotInsert: 0, itemInsert: 0, matchupItemInsert: 0, rankingRunUpdate: 0, approvalStep: 0, commit: false, rollback: false };
}

interface RawRun {
  id: string;
  workflowRunId: string;
  rankingRuleSetId: string;
  modeAggregationRunId: string;
  overallAggregationRunId: string;
  matchupAggregationRunId: string;
  patchId: string | null;
  status: string;
  holdReason: string | null;
  tierMoveRatio: number | null;
  brawlersEvaluated: number | null;
  brawlersPublished: number | null;
}

function makeRun(over: Partial<RawRun> = {}): RawRun {
  return {
    id: "rr-1",
    workflowRunId: "wr-1",
    rankingRuleSetId: "rs-1",
    modeAggregationRunId: "agg-mode",
    overallAggregationRunId: "agg-overall",
    matchupAggregationRunId: "agg-matchup",
    patchId: null,
    status: "held",
    holdReason: "mass_movement_guard",
    tierMoveRatio: 0.64762,
    brawlersEvaluated: 3,
    brawlersPublished: 0,
    ...over,
  };
}

function makeCandidate(brawlerId: string, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: `res-${brawlerId}-overall`,
    brawlerId,
    gameModeId: null,
    matches: 300,
    winRate: 0.55,
    highRankWinRate: 0.56,
    matchupCoverage: 0.6,
    metaScore: 55.5,
    tier: "B",
    confidence: "medium",
    meetsFloor: 1,
    ...over,
  };
}

interface FakeOpts {
  run: RawRun | null;
  publishedSnapshot?: { id: string; isCurrent: number } | null;
  aggAllSucceeded?: boolean;
  cursor?: unknown | null;
  activeBrawlers: string[];
  candidates: Record<string, unknown>[];
  matchupResultCount: number;
  qualifyingMatchups: Record<string, unknown>[];
  itemInsertThrows?: boolean;
  events: Events;
}

function makeFakePool(opts: FakeOpts): Pool {
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const aggSucceeded = opts.aggAllSucceeded ?? true;

  const handle = async (sqlRaw: string): Promise<[unknown, unknown]> => {
    const sql = norm(sqlRaw);

    // --- reads --------------------------------------------------------------
    if (/FROM ranking_runs WHERE id = \?/i.test(sql)) return [opts.run ? [opts.run] : [], []];
    if (/FROM published_snapshots WHERE ranking_run_id = \?/i.test(sql)) {
      return [opts.publishedSnapshot ? [opts.publishedSnapshot] : [], []];
    }
    if (/FROM aggregation_runs WHERE id IN/i.test(sql)) {
      const ids = ["agg-mode", "agg-overall", "agg-matchup"];
      return [ids.map((id) => ({ id, status: aggSucceeded ? "succeeded" : "running" })), []];
    }
    if (/SELECT output_summary FROM workflow_steps/i.test(sql)) {
      return [opts.cursor ? [{ output_summary: JSON.stringify(opts.cursor) }] : [], []];
    }
    if (/FROM canonical_brawlers WHERE is_active = 1/i.test(sql)) {
      return [opts.activeBrawlers.map((id) => ({ id })), []];
    }
    if (/FROM ranking_results WHERE ranking_run_id = \?/i.test(sql)) {
      return [opts.candidates, []];
    }
    if (/SELECT COUNT\(\*\) AS c FROM matchup_results/i.test(sql)) {
      return [[{ c: opts.matchupResultCount }], []];
    }
    if (/FROM matchup_results WHERE ranking_run_id = \? AND relationship IS NOT NULL/i.test(sql)) {
      return [opts.qualifyingMatchups, []];
    }

    // --- writes -------------------------------------------------------------
    if (/^UPDATE published_snapshots SET is_current = 0/i.test(sql)) {
      opts.events.supersede += 1;
      return [{ affectedRows: 1 }, []];
    }
    if (/^INSERT INTO published_snapshots/i.test(sql)) {
      opts.events.snapshotInsert += 1;
      return [{ affectedRows: 1 }, []];
    }
    if (/^INSERT INTO published_snapshot_items/i.test(sql)) {
      opts.events.itemInsert += 1;
      if (opts.itemInsertThrows) throw new Error("simulated published_snapshot_items INSERT failure");
      return [{ affectedRows: 1 }, []];
    }
    if (/^INSERT INTO published_matchup_items/i.test(sql)) {
      opts.events.matchupItemInsert += 1;
      return [{ affectedRows: 1 }, []];
    }
    if (/^UPDATE ranking_runs SET status/i.test(sql)) {
      opts.events.rankingRunUpdate += 1;
      return [{ affectedRows: 1 }, []];
    }
    if (/^INSERT INTO workflow_steps/i.test(sql)) {
      opts.events.approvalStep += 1;
      return [{ affectedRows: 1 }, []];
    }
    if (/^SELECT/i.test(sql)) return [[], []];
    return [{ affectedRows: 1 }, []];
  };

  const conn = {
    query: (sql: string) => handle(sql),
    execute: (sql: string) => handle(sql),
    beginTransaction: async () => {},
    commit: async () => {
      opts.events.commit = true;
    },
    rollback: async () => {
      opts.events.rollback = true;
    },
    release: () => {},
  } as unknown as PoolConnection;

  return {
    query: (sql: string) => handle(sql),
    execute: (sql: string) => handle(sql),
    getConnection: async () => conn,
  } as unknown as Pool;
}

const validCursor = () => ({ rankingRunId: "rr-1", patchId: null, patchVersionLabel: "v1.0", nowIso: "2026-07-22T10:00:00.000Z" });

function happyOpts(events: Events): FakeOpts {
  const brawlers = ["b1", "b2", "b3"];
  return {
    run: makeRun(),
    publishedSnapshot: null,
    cursor: validCursor(),
    activeBrawlers: brawlers,
    candidates: [
      ...brawlers.map((b) => makeCandidate(b)),
      // one per-mode row for b1 (nested mode tier)
      makeCandidate("b1", { id: "res-b1-mode", gameModeId: "gm-1", tier: "A", metaScore: 60 }),
    ],
    matchupResultCount: 12,
    qualifyingMatchups: [
      { brawlerId: "b1", opponentBrawlerId: "b2", relationship: "counter", confidenceLevel: "probable_counter", winRate: 0.4, matches: 50 },
      { brawlerId: "b2", opponentBrawlerId: "b3", relationship: "strong", confidenceLevel: "high_confidence_counter", winRate: 0.62, matches: 120 },
    ],
    events,
  };
}

test("approved publication: a mass_movement held run publishes transactionally with an audit step", async () => {
  const { approveHeldRanking } = await import("@/lib/ranking/approval");
  const events = makeEvents();
  const pool = makeFakePool(happyOpts(events));

  const result = await approveHeldRanking(
    { rankingRunId: "rr-1", approvedBy: "operator@brawlranks", reason: "bootstrap: first DO snapshot" },
    { pool }
  );

  assert.equal(result.outcome, "published");
  assert.equal(result.snapshotId !== undefined, true);
  assert.equal(result.brawlersPublished, 3, "all three overall candidates were publishable");
  assert.equal(events.supersede, 1, "exactly one supersede of the prior current snapshot");
  assert.equal(events.snapshotInsert, 1, "exactly one new published_snapshots row");
  assert.equal(events.itemInsert, 3, "one published item per publishable brawler");
  assert.equal(events.matchupItemInsert, 2, "both qualifying matchups published");
  assert.equal(events.rankingRunUpdate, 1, "the ranking_run is marked succeeded");
  assert.equal(events.approvalStep, 1, "the operator_approval audit step is recorded");
  assert.equal(events.commit, true, "the publish transaction committed");
  assert.equal(events.rollback, false);
  // Evidence records who/why/when + a stable hash and the guard context.
  assert.equal(result.approvedBy, "operator@brawlranks");
  assert.match(result.evidence.evidenceHash, /^[0-9a-f]{64}$/);
  assert.equal(result.evidence.massMovementThreshold, 0.25);
  assert.equal(result.evidence.guardWouldHold, true, "0.648 > 0.25 — the guard genuinely tripped (bootstrap-expected)");
  assert.equal(result.evidence.activeBrawlers, 3);
  assert.equal(result.evidence.publishableBrawlers, 3);
});

test("dry-run: validates and computes evidence but publishes nothing", async () => {
  const { approveHeldRanking } = await import("@/lib/ranking/approval");
  const events = makeEvents();
  const pool = makeFakePool(happyOpts(events));

  const result = await approveHeldRanking(
    { rankingRunId: "rr-1", approvedBy: "op", reason: "preflight" },
    { pool, dryRun: true }
  );

  assert.equal(result.outcome, "validated");
  assert.equal(events.supersede, 0);
  assert.equal(events.snapshotInsert, 0);
  assert.equal(events.itemInsert, 0);
  assert.equal(events.rankingRunUpdate, 0);
  assert.equal(events.approvalStep, 0);
  assert.equal(result.evidence.publishableBrawlers, 3);
});

test("invalid run ID: an unknown rankingRunId is rejected before any write", async () => {
  const { approveHeldRanking, ApprovalError } = await import("@/lib/ranking/approval");
  const events = makeEvents();
  const pool = makeFakePool({ ...happyOpts(events), run: null });

  await assert.rejects(
    () => approveHeldRanking({ rankingRunId: "nope", approvedBy: "op", reason: "x" }, { pool }),
    (err: unknown) => err instanceof ApprovalError && /unknown ranking run/i.test((err as Error).message)
  );
  assert.equal(events.snapshotInsert, 0, "nothing was published for an unknown run");
});

test("wrong state: a run that is not a mass_movement hold is refused", async () => {
  const { approveHeldRanking, ApprovalError } = await import("@/lib/ranking/approval");
  const events = makeEvents();
  const pool = makeFakePool({ ...happyOpts(events), run: makeRun({ status: "succeeded", holdReason: null }) });

  await assert.rejects(
    () => approveHeldRanking({ rankingRunId: "rr-1", approvedBy: "op", reason: "x" }, { pool }),
    (err: unknown) => err instanceof ApprovalError && /is not held/i.test((err as Error).message)
  );
  assert.equal(events.snapshotInsert, 0);
});

test("incomplete candidate: a run missing overall rows for some active brawlers is rejected before any write", async () => {
  const { approveHeldRanking, ApprovalError } = await import("@/lib/ranking/approval");
  const events = makeEvents();
  // 3 active brawlers, but only 2 have overall candidate rows.
  const opts = happyOpts(events);
  opts.candidates = [makeCandidate("b1"), makeCandidate("b2")];
  const pool = makeFakePool(opts);

  await assert.rejects(
    () => approveHeldRanking({ rankingRunId: "rr-1", approvedBy: "op", reason: "x" }, { pool }),
    (err: unknown) => err instanceof ApprovalError && /incomplete candidate/i.test((err as Error).message)
  );
  assert.equal(events.supersede, 0, "no supersede on an incomplete candidate");
  assert.equal(events.snapshotInsert, 0, "no snapshot created on an incomplete candidate");
});

test("already-published run: idempotent no-op, no supersede or new snapshot", async () => {
  const { approveHeldRanking } = await import("@/lib/ranking/approval");
  const events = makeEvents();
  const opts = happyOpts(events);
  opts.publishedSnapshot = { id: "snap-existing", isCurrent: 1 };
  opts.run = makeRun({ status: "succeeded", brawlersPublished: 42 }); // already-published runs are 'succeeded'
  const pool = makeFakePool(opts);

  const result = await approveHeldRanking(
    { rankingRunId: "rr-1", approvedBy: "op", reason: "retry" },
    { pool }
  );

  assert.equal(result.outcome, "already_published");
  assert.equal(result.snapshotId, "snap-existing");
  assert.equal(result.brawlersPublished, 42);
  assert.equal(events.supersede, 0, "an already-published run is never re-superseded");
  assert.equal(events.snapshotInsert, 0, "no second snapshot is created");
  assert.equal(events.approvalStep, 0);
});

test("transactional rollback: an insert failure rolls back the whole publish and preserves the old snapshot", async () => {
  const { approveHeldRanking } = await import("@/lib/ranking/approval");
  const events = makeEvents();
  const opts = happyOpts(events);
  opts.itemInsertThrows = true; // the first published_snapshot_items INSERT throws
  const pool = makeFakePool(opts);

  await assert.rejects(
    () => approveHeldRanking({ rankingRunId: "rr-1", approvedBy: "op", reason: "x" }, { pool }),
    /published_snapshot_items INSERT failure/
  );

  assert.equal(events.supersede, 1, "the supersede ran inside the transaction...");
  assert.equal(events.rollback, true, "...but the transaction rolled back");
  assert.equal(events.commit, false, "the transaction never committed, so the old snapshot stays current");
  assert.equal(events.rankingRunUpdate, 0, "the ranking_run was NOT marked succeeded");
  assert.equal(events.approvalStep, 0, "no approval step was durably recorded");
});
