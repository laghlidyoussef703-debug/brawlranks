/**
 * Incident signature computation for deduplication/aggregation
 * (BRAWLRANKS_WEBSITE_SPEC.md Section 7.24 — Phase 4.7 extends this with
 * "avoid producing one incident per item when aggregation is safer").
 *
 * The signature deliberately excludes anything that varies per occurrence
 * of the SAME underlying problem (related_fetch_run_id, timestamps, exact
 * rejected-item counts) — only the stable identity of "what kind of
 * problem is this" goes in. Two incidents with the same signature are, by
 * construction, the same recurring root cause, not two different bugs that
 * happen to share a type.
 */

import { sha256Hex, stableStringify } from "@/lib/hash";

export interface IncidentSignatureInput {
  incidentType: string;
  dataCategory?: string | null;
  relatedEntityType?: string | null;
  /** A short, stable identifier for the root-cause class (e.g. "battle_log_rejected_items", "schema_mismatch") — never the full per-occurrence detail. */
  reasonKey: string;
}

export function computeIncidentSignature(input: IncidentSignatureInput): string {
  return sha256Hex(
    stableStringify({
      incidentType: input.incidentType,
      dataCategory: input.dataCategory ?? null,
      relatedEntityType: input.relatedEntityType ?? null,
      reasonKey: input.reasonKey,
    })
  );
}
