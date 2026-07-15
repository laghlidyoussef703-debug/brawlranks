/**
 * Change detection for the Brawler catalog vertical slice
 * (BRAWLRANKS_WEBSITE_SPEC.md Section 8). Compares the newest normalized
 * candidate snapshot against the last row in normalized_snapshots with
 * is_accepted = 1 for that entity — never against raw, never against
 * published data (Section 8's explicit comparison rule).
 *
 * Only the change types this vertical slice can actually observe are
 * produced: new_brawler, brawler_removed_or_deprecated, gadget_change,
 * star_power_change, missing_source_data, unexpected_mass_change. The
 * catalog endpoint carries no numeric stats, game modes, or patch version,
 * so stat_change / new_game_mode / patch_version_change / gear_change /
 * schema_change never fire here — a later phase that ingests those sources
 * will add them.
 *
 * A pure rename (name changed, id/gadgets/star powers unchanged) is
 * deliberately NOT emitted as a detected_changes row: there is no
 * "name_change" entry in the change_type CHECK constraint, and forcing it
 * into an unrelated bucket (e.g. stat_change) would misrepresent the event.
 * Renames are instead captured precisely by the brawler_aliases mechanism
 * in lib/catalog/repository.ts (Section 7.6).
 */

import type { NormalizedBrawler, NormalizedEntitySnapshot } from "@/lib/catalog/normalize";

export type ChangeSeverity = "info" | "warning" | "critical";

export interface DetectedChangeRecord {
  entityType: "brawler";
  entityId: string;
  changeType:
    | "new_brawler"
    | "brawler_removed_or_deprecated"
    | "gadget_change"
    | "star_power_change"
    | "missing_source_data"
    | "unexpected_mass_change";
  field?: string;
  oldValue?: string;
  newValue?: string;
  severity: ChangeSeverity;
}

export interface PreviousAcceptedEntity {
  entityId: string;
  normalized: NormalizedBrawler;
  payloadChecksum: string;
}

function diffSubItems(
  entityId: string,
  changeType: "gadget_change" | "star_power_change",
  before: Array<{ sourceId: string; name: string }>,
  after: Array<{ sourceId: string; name: string }>
): DetectedChangeRecord[] {
  const beforeIds = new Map(before.map((item) => [item.sourceId, item.name]));
  const afterIds = new Map(after.map((item) => [item.sourceId, item.name]));
  const changes: DetectedChangeRecord[] = [];

  for (const [id, name] of afterIds) {
    if (!beforeIds.has(id)) {
      changes.push({
        entityType: "brawler",
        entityId,
        changeType,
        field: id,
        oldValue: undefined,
        newValue: name,
        severity: "info",
      });
    }
  }

  for (const [id, name] of beforeIds) {
    if (!afterIds.has(id)) {
      changes.push({
        entityType: "brawler",
        entityId,
        changeType,
        field: id,
        oldValue: name,
        newValue: undefined,
        severity: "warning",
      });
    }
  }

  return changes;
}

/**
 * Diffs a single entity's new candidate against its previous accepted
 * state. Returns [] when the two normalized payloads are byte-identical
 * (the checksum comparison IS the no-meaningful-change check, Section 8.2)
 * — callers must not proceed to acceptance/publication when this returns [].
 */
export function detectPerEntityChanges(
  candidate: NormalizedEntitySnapshot,
  previous: PreviousAcceptedEntity | null
): DetectedChangeRecord[] {
  if (previous === null) {
    return [
      {
        entityType: "brawler",
        entityId: candidate.entityId,
        changeType: "new_brawler",
        newValue: candidate.normalized.name,
        severity: "info",
      },
    ];
  }

  if (previous.payloadChecksum === candidate.payloadChecksum) {
    return [];
  }

  return [
    ...diffSubItems(
      candidate.entityId,
      "gadget_change",
      previous.normalized.gadgets,
      candidate.normalized.gadgets
    ),
    ...diffSubItems(
      candidate.entityId,
      "star_power_change",
      previous.normalized.starPowers,
      candidate.normalized.starPowers
    ),
  ];
}

export function detectRemoval(entityId: string, previousName: string): DetectedChangeRecord {
  return {
    entityType: "brawler",
    entityId,
    changeType: "brawler_removed_or_deprecated",
    oldValue: previousName,
    severity: "warning",
  };
}

export interface VolumeAnomalyResult {
  incident: DetectedChangeRecord | null;
  shouldBlockAcceptance: boolean;
}

/**
 * Set-level guard against a source outage masquerading as mass deletion.
 * - Zero new items while a previous accepted set exists -> missing_source_data,
 *   blocks acceptance entirely (the whole run is quarantined).
 * - More than half of the previously-known entities disappear in one run ->
 *   unexpected_mass_change, also blocks acceptance (Section 7.24 data-quality
 *   gate: a run this destructive requires human review, not silent commit).
 * A normal, gradual roster change (a handful of removals) is NOT blocked —
 * only used for the two anomaly thresholds above.
 */
export function detectVolumeAnomaly(
  previousEntityIds: string[],
  newEntityIds: string[]
): VolumeAnomalyResult {
  if (previousEntityIds.length === 0) {
    return { incident: null, shouldBlockAcceptance: false };
  }

  if (newEntityIds.length === 0) {
    return {
      incident: {
        entityType: "brawler",
        entityId: "*",
        changeType: "missing_source_data",
        severity: "critical",
      },
      shouldBlockAcceptance: true,
    };
  }

  const newIdSet = new Set(newEntityIds);
  const removedCount = previousEntityIds.filter((id) => !newIdSet.has(id)).length;
  const removedRatio = removedCount / previousEntityIds.length;

  if (removedRatio > 0.5) {
    return {
      incident: {
        entityType: "brawler",
        entityId: "*",
        changeType: "unexpected_mass_change",
        field: "removed_ratio",
        newValue: removedRatio.toFixed(3),
        severity: "critical",
      },
      shouldBlockAcceptance: true,
    };
  }

  return { incident: null, shouldBlockAcceptance: false };
}
