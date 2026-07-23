import type { DbRow } from "./canonical";
import { normalizeTimestamp } from "./timestamp";

/** Code-evidenced TTLs for every workflow slug that acquires workflow_locks. */
export const WORKFLOW_LOCK_TTLS_MS = {
  "catalog-sync-brawlers": [5 * 60_000],
  "club-expansion": [5 * 60_000],
  "battle-log-crawl": [5 * 60_000],
  "player-discovery": [5 * 60_000],
  "retention-sweep": [5 * 60_000],
  "ranking-seed-refresh": [5 * 60_000],
  "ranking-rebuild": [2 * 60_000, 15 * 60_000],
  "statistical-aggregation": [2 * 60_000, 15 * 60_000],
} as const;

export type VerifiedWorkflowSlug = keyof typeof WORKFLOW_LOCK_TTLS_MS;
export const AMBIGUOUS_WORKFLOW_LOCK_SLUGS = Object.entries(WORKFLOW_LOCK_TTLS_MS)
  .filter(([, values]) => values.length > 1)
  .map(([slug]) => slug);

export interface SkippedEphemeralStaleLockEvidence {
  lockId: string;
  workflowDefinitionId: string;
  workflowSlug: string;
  expiresAt: string;
  releasedAt: string;
  reasonCode: "ambiguous_zero_date_released_expired_ephemeral_lock";
}

export type WorkflowLockMigrationDecision =
  | { action: "copy"; row: DbRow; normalized: boolean }
  | { action: "skip"; evidence: SkippedEphemeralStaleLockEvidence };

export function workflowLockTtlsMs(slug: string): readonly number[] {
  const values = WORKFLOW_LOCK_TTLS_MS[slug as VerifiedWorkflowSlug] as readonly number[] | undefined;
  if (!values) throw new Error(`Cannot normalize workflow_locks.locked_at: unknown workflow slug ${JSON.stringify(slug)}`);
  return values;
}

export function verifiedWorkflowLockTtlMs(slug: string): number {
  const values = workflowLockTtlsMs(slug);
  if (values.length !== 1) throw new Error(`Cannot normalize workflow_locks.locked_at: workflow slug ${JSON.stringify(slug)} has ambiguous code-evidenced TTLs [${values.join(",")}]ms`);
  return values[0];
}

export function isMariaDbZeroDate(value: unknown): boolean {
  return typeof value === "string" && /^0000-00-00 00:00:00(?:\.0{1,6})?$/.test(value.trim());
}

export function normalizeWorkflowLockRow(row: DbRow, slug: string): { row: DbRow; normalized: boolean } {
  if (!isMariaDbZeroDate(row.locked_at)) return { row, normalized: false };
  const ttlMs = verifiedWorkflowLockTtlMs(slug);
  const expiresAt = normalizeTimestamp(row.expires_at, {
    family: "workflow-children", table: "workflow_locks", column: "expires_at",
    operation: `zero-date locked_at normalization for slug ${slug}`, nullable: false,
  })!;
  return {
    row: { ...row, locked_at: new Date(new Date(expiresAt).getTime() - ttlMs).toISOString() },
    normalized: true,
  };
}

export function classifyWorkflowLockRow(row: DbRow, slug: string, fixedSourceWatermark: string): WorkflowLockMigrationDecision {
  if (!isMariaDbZeroDate(row.locked_at)) return { action: "copy", row, normalized: false };
  const expiresAt = normalizeTimestamp(row.expires_at, {
    family: "workflow-children", table: "workflow_locks", column: "expires_at",
    operation: `ephemeral zero-date classification for slug ${slug}`, nullable: false,
  })!;
  const releasedAt = normalizeTimestamp(row.released_at, {
    family: "workflow-children", table: "workflow_locks", column: "released_at",
    operation: `ephemeral zero-date classification for slug ${slug}`, nullable: false,
  })!;
  const watermark = normalizeTimestamp(fixedSourceWatermark, {
    family: "workflow-children", table: "workflow_locks", column: "source_time_watermark",
    operation: "ephemeral zero-date classification", nullable: false,
  })!;
  if (expiresAt > watermark) throw new Error(`Cannot migrate workflow_locks zero-date lock ${String(row.id)}: expires_at is after fixed source watermark`);

  const ttls = workflowLockTtlsMs(slug);
  if (ttls.length === 1) return { action: "copy", ...normalizeWorkflowLockRow(row, slug) };
  return {
    action: "skip",
    evidence: {
      lockId: String(row.id),
      workflowDefinitionId: String(row.workflow_definition_id),
      workflowSlug: slug,
      expiresAt,
      releasedAt,
      reasonCode: "ambiguous_zero_date_released_expired_ephemeral_lock",
    },
  };
}
