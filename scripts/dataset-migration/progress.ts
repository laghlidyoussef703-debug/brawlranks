import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { compareCursor, type CompositeCursor, type TablePlan } from "./model";

export type ProgressStage =
  | "run_started" | "preflight" | "family_started" | "family_completed"
  | "table_started" | "metadata" | "upper_watermark" | "source_page"
  | "target_comparison" | "page_completed" | "reconciliation"
  | "query_started" | "query_completed" | "query_failed"
  | "table_completed" | "table_skipped" | "run_completed" | "failed";

export interface ProgressEvent {
  at: string;
  passId: string;
  stage: ProgressStage;
  family?: string;
  table?: string;
  pageNumber?: number;
  rowsRead?: number;
  inserted?: number;
  updated?: number;
  matched?: number;
  deleted?: number;
  cursorBefore?: CompositeCursor | null;
  cursorAfter?: CompositeCursor | null;
  elapsedMs: number;
  lastSuccessfulDatabaseOperationAt: string;
  queryInProgress: boolean;
  queryStage?: string | null;
  queryStartedAt?: string | null;
  memory?: { rss: number; heapUsed: number; external: number };
  eventLoopDelayMs?: { mean: number; max: number };
  error?: string;
}

export function assertStrictCursorProgress(
  plan: Pick<TablePlan, "table" | "family">,
  previous: CompositeCursor | null,
  next: CompositeCursor,
  rowCount: number,
  lastRowIdentity: string
): void {
  if (!previous) return;
  const comparison = compareCursor(next, previous);
  if (comparison > 0) return;
  const direction = comparison === 0 ? "repeated" : "regressed";
  throw new Error(
    `Phase 8 cursor progress error: cursor ${direction}; family=${plan.family}; table=${plan.table}; ` +
    `previous=${JSON.stringify(previous)}; next=${JSON.stringify(next)}; rowCount=${rowCount}; lastRowIdentity=${lastRowIdentity}`
  );
}

export function validatePageProgress(
  plan: Pick<TablePlan, "table" | "family">,
  previous: CompositeCursor | null,
  next: CompositeCursor | null,
  rowCount: number,
  lastRowIdentity: string
): "done" | "advanced" {
  if (rowCount === 0) return "done";
  if (!next) throw new Error(`Phase 8 cursor progress error: non-empty page has no next cursor; family=${plan.family}; table=${plan.table}; rowCount=${rowCount}; lastRowIdentity=${lastRowIdentity}`);
  assertStrictCursorProgress(plan, previous, next, rowCount, lastRowIdentity);
  return "advanced";
}

export function nextRetryAttempt(currentRetry: number, maximumRetries: number): number | null {
  return currentRetry >= maximumRetries ? null : currentRetry + 1;
}

export function assertTupleProgress(
  context: string,
  previous: readonly string[],
  next: readonly string[],
  rowCount: number
): void {
  const previousKey = JSON.stringify(previous), nextKey = JSON.stringify(next);
  let comparison = 0;
  for (let index = 0; index < Math.max(previous.length, next.length); index += 1) {
    const a = next[index] ?? "", b = previous[index] ?? "";
    if (a === b) continue;
    comparison = a > b ? 1 : -1; break;
  }
  if (comparison > 0) return;
  throw new Error(`Phase 8 pagination progress error: ${context}; previous=${previousKey}; next=${nextKey}; rowCount=${rowCount}`);
}

export class MigrationProgressTracker {
  private readonly startedAt = Date.now();
  private lastActivityAt = Date.now();
  private lastDatabaseOperationAt = Date.now();
  private queryStartedAt: number | null = null;
  private queryStage: string | null = null;
  private expiredReason: string | null = null;
  private readonly timer: NodeJS.Timeout;
  private readonly histogram: IntervalHistogram;

  constructor(
    readonly passId: string,
    readonly inactivityMs: number,
    private readonly onEvent: (event: ProgressEvent) => Promise<void> | void = () => undefined
  ) {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    const interval = Math.max(1_000, Math.min(30_000, Math.floor(inactivityMs / 4)));
    this.timer = setInterval(() => {
      if (this.queryStartedAt !== null) return; // A valid long SQL query is never killed by the CPU-idle watchdog.
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs >= this.inactivityMs) this.expiredReason = `no database operation, cursor advancement, or page completion for ${idleMs}ms`;
    }, interval);
    this.timer.unref();
  }

  async query<T>(stage: string, task: () => Promise<T>): Promise<T> {
    this.throwIfStalled(stage);
    this.queryStartedAt = Date.now(); this.queryStage = stage;
    await this.emit("query_started");
    try {
      const result = await task();
      this.lastDatabaseOperationAt = Date.now(); this.lastActivityAt = this.lastDatabaseOperationAt;
      this.queryStartedAt = null; this.queryStage = null;
      await this.emit("query_completed");
      return result;
    } catch (error) {
      this.queryStartedAt = null; this.queryStage = null;
      // The database operation returned (with an error), so this is not CPU-only inactivity.
      // Do not move lastSuccessfulDatabaseOperationAt, which intentionally tracks successes only.
      this.lastActivityAt = Date.now();
      await this.emit("query_failed", { error: error instanceof Error ? error.message : "unknown_error" });
      this.throwIfStalled(stage);
      throw error;
    }
  }

  activity(): void {
    this.throwIfStalled("activity");
    this.lastActivityAt = Date.now();
  }

  async emit(stage: ProgressStage, details: Partial<Omit<ProgressEvent, "at" | "passId" | "stage" | "elapsedMs" | "lastSuccessfulDatabaseOperationAt" | "queryInProgress">> = {}): Promise<void> {
    this.throwIfStalled(stage);
    if (stage === "page_completed") this.lastActivityAt = Date.now();
    const memory = process.memoryUsage();
    const event: ProgressEvent = {
      at: new Date().toISOString(), passId: this.passId, stage, ...details,
      elapsedMs: Date.now() - this.startedAt,
      lastSuccessfulDatabaseOperationAt: new Date(this.lastDatabaseOperationAt).toISOString(),
      queryInProgress: this.queryStartedAt !== null,
      queryStage: this.queryStage,
      queryStartedAt: this.queryStartedAt === null ? null : new Date(this.queryStartedAt).toISOString(),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external },
      eventLoopDelayMs: {
        mean: Number.isFinite(this.histogram.mean) ? this.histogram.mean / 1e6 : 0,
        max: Number.isFinite(this.histogram.max) ? this.histogram.max / 1e6 : 0,
      },
    };
    await this.onEvent(event);
  }

  snapshot(): { lastActivityAt: string; lastSuccessfulDatabaseOperationAt: string; queryInProgress: boolean; queryStage: string | null } {
    return {
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      lastSuccessfulDatabaseOperationAt: new Date(this.lastDatabaseOperationAt).toISOString(),
      queryInProgress: this.queryStartedAt !== null,
      queryStage: this.queryStage,
    };
  }

  throwIfStalled(stage: string): void {
    if (this.queryStartedAt === null && Date.now() - this.lastActivityAt >= this.inactivityMs) {
      this.expiredReason ??= `no database operation, cursor advancement, or page completion for ${Date.now() - this.lastActivityAt}ms`;
    }
    if (!this.expiredReason) return;
    throw new Error(`Phase 8 watchdog timeout at stage=${stage}: ${this.expiredReason}; lastSuccessfulDatabaseOperationAt=${new Date(this.lastDatabaseOperationAt).toISOString()}`);
  }

  close(): void {
    clearInterval(this.timer); this.histogram.disable();
  }
}

export function formatProgressLine(event: ProgressEvent): string {
  const fields = [
    `phase8-progress`, `stage=${event.stage}`,
    event.family ? `family=${event.family}` : null,
    event.table ? `table=${event.table}` : null,
    event.pageNumber !== undefined ? `page=${event.pageNumber}` : null,
    event.rowsRead !== undefined ? `rows=${event.rowsRead}` : null,
    event.inserted !== undefined ? `insert=${event.inserted}` : null,
    event.updated !== undefined ? `update=${event.updated}` : null,
    event.deleted !== undefined ? `delete=${event.deleted}` : null,
    event.cursorAfter !== undefined ? `cursor=${JSON.stringify(event.cursorAfter)}` : null,
    `elapsedMs=${event.elapsedMs}`,
    `lastDbOp=${event.lastSuccessfulDatabaseOperationAt}`,
  ].filter(Boolean);
  return fields.join(" ");
}
