import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import {
  stepAggregation,
  DEFAULT_AGGREGATION_BATCH_SIZE,
  MAX_AGGREGATION_BATCH_SIZE,
  type AggregationStepResult,
} from "@/lib/aggregation/sync";

/**
 * Protected trigger for the statistical-aggregation workflow (Phase 5.2 /
 * Phase 11 timeout fix). Cadence per Section 7.22/15: "Statistical aggregation
 * | Every 6-12 hours."
 *
 * DURABLE, INTENTIONAL BACKGROUND CONTINUATION. The heavy set-based aggregate
 * SQL (an `INSERT ... SELECT` over the whole battle history) used to run
 * synchronously inside this request; even with `batchSize:8` it exceeded
 * Hostinger/nginx's ~55s gateway timeout, so nginx 504'd while Node kept the
 * query running (an ACCIDENTAL background continuation), the lock stayed held,
 * and systemd's immediate retry got a 409 and marked the unit failed.
 *
 * The route now returns within a few seconds and never runs that SQL on the
 * request thread. `stepAggregation` claims a fresh job (fast), dispatches each
 * heavy mode/overall/matchup slice to a tracked background continuation that
 * owns the workflow lock, runs the light `finalize` inline, and reports an
 * honest state. The scheduler simply calls this endpoint repeatedly until
 * `completed`. The DigitalOcean scheduler/proxy are not touched here.
 *
 * Response contract — always a fast, structured, systemd-friendly result; a
 * progressing workflow can no longer masquerade as a gateway failure, and an
 * overlapping trigger is a safe non-error that never starts a second run:
 *   - started      -> 202 { ok: true,  accepted: true,  state: "started",         workflowRunId, phase }
 *   - in_progress  -> 202 { ok: true,  accepted: true,  state: "in_progress",     workflowRunId, phase }
 *   - already_running (a slice holds the lock) -> 200 { ok: true, accepted: false, state: "already_running", workflowRunId }
 *   - completed    -> 200 { ok: true,  accepted: true,  state: "completed",       workflowRunId, phase, outcome, counts }
 *   - failed (handled, self-healing: missing cursor) -> 200 { ok: false, state: "failed", workflowRunId }
 *
 * NOTE ON OVERLAP CODE: an in-flight invocation returns HTTP 200 (structured
 * JSON, never a second workflow), NOT 409 — a 409 is exactly what made systemd
 * mark this progressing workflow failed, which is the defect this fix removes.
 * This mirrors the battle-log cron's proven contract.
 */
export const runtime = "nodejs";

/** Maps the honest step state to the fast, structured HTTP contract above. Pure and DB-free so it can be unit tested exhaustively. */
export function toAggregationHttpResponse(result: AggregationStepResult): { httpStatus: number; body: Record<string, unknown> } {
  switch (result.status) {
    case "already_running":
      return {
        httpStatus: 200,
        body: { ok: true, accepted: false, state: "already_running", workflowRunId: result.activeWorkflowRunId ?? result.workflowRunId },
      };
    case "failed":
      return {
        httpStatus: 200,
        body: { ok: false, state: "failed", workflowRunId: result.workflowRunId, phase: result.phase },
      };
    case "completed":
      return {
        httpStatus: 200,
        body: {
          ok: true,
          accepted: true,
          state: "completed",
          workflowRunId: result.workflowRunId,
          phase: result.phase,
          outcome: result.outcome,
          modeAggregateCount: result.modeAggregateCount,
          overallAggregateCount: result.overallAggregateCount,
          matchupAggregateCount: result.matchupAggregateCount,
          reconciliationWarnings: result.reconciliationWarnings,
        },
      };
    case "started":
    case "in_progress":
    default:
      return {
        httpStatus: 202,
        body: { ok: true, accepted: true, state: result.status, workflowRunId: result.workflowRunId, phase: result.phase },
      };
  }
}

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("aggregation-run", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  let batchSize = DEFAULT_AGGREGATION_BATCH_SIZE;
  const body = await request.json().catch(() => null);
  if (body && typeof body.batchSize === "number" && Number.isInteger(body.batchSize) && body.batchSize > 0) {
    batchSize = Math.min(body.batchSize, MAX_AGGREGATION_BATCH_SIZE);
  }

  try {
    // Deliberately NOT awaiting result.backgroundSlice: the heavy aggregate SQL
    // runs as a tracked background continuation while this request returns fast.
    const result = await stepAggregation("cron", batchSize);
    const { httpStatus, body: responseBody } = toAggregationHttpResponse(result);
    return NextResponse.json(responseBody, { status: httpStatus });
  } catch (error) {
    logSafeError("aggregation-run", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Aggregation run failed unexpectedly."), { status: 500 });
  }
}
