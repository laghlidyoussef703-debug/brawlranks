/**
 * DATASET Phase 4 — replay validator adapter (no-write).
 *
 * Invokes the EXISTING ingestion validators (lib/ingestion/schemas.ts,
 * lib/catalog/schema.ts) — the very functions the live pipeline uses — against
 * a replayed payload, in pure no-write mode. It duplicates NO validation rules:
 * it only dispatches by endpoint_category and extracts the items/object exactly
 * as the corresponding sync does (`payload?.payload ?? payload`, a bare array,
 * or `{ items }`), then calls the existing validator.
 *
 * Scope, stated precisely: this runs the existing VALIDATOR (schema validation)
 * in dry-run. It does NOT run the battle-graph NORMALIZER (which builds
 * battle/team/participant rows and is write-coupled with no dry-run mode) — that
 * remains a documented, separately-owned gap. DATASET.md Phase 4 permits
 * "the existing validator/normalizer in dry-run or idempotent mode"; this is the
 * validator half, run with zero writes.
 */

import {
  validateBattleLogItems,
  validatePlayerPayload,
  validateClubPayload,
  validatePlayerRankingItems,
} from "@/lib/ingestion/schemas";
import { validateBrawlersPayload } from "@/lib/catalog/schema";
import type { ReplayValidator } from "./replay";
import { ReplayError } from "./replay";

export interface ReplayValidationSummary {
  endpointCategory: string;
  validatorRan: boolean;
  validCount: number;
  rejectedCount: number;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (Array.isArray(rec.items)) return rec.items as unknown[];
    if (rec.payload && typeof rec.payload === "object" && Array.isArray((rec.payload as Record<string, unknown>).items)) {
      return (rec.payload as { items: unknown[] }).items;
    }
  }
  return [];
}

/** Unwraps the proxy envelope the object syncs use: `payload?.payload ?? payload`. */
function unwrapEnvelope(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "payload" in (value as object)) {
    return (value as Record<string, unknown>).payload;
  }
  return value;
}

/**
 * Runs the existing validator for `endpointCategory` against `payload`. Returns
 * a summary; throws ReplayError only when the payload cannot be validated into
 * at least one record where one is expected — i.e. the replayed object does not
 * match the pipeline's own schema.
 */
export function validateReplayedPayload(endpointCategory: string, payload: unknown): ReplayValidationSummary {
  let validCount = 0;
  let rejectedCount = 0;

  switch (endpointCategory) {
    case "battle_log": {
      const { valid, rejected } = validateBattleLogItems(asArray(payload));
      validCount = valid.length;
      rejectedCount = rejected;
      break;
    }
    case "player_rankings": {
      const { valid, rejected } = validatePlayerRankingItems(asArray(payload));
      validCount = valid.length;
      rejectedCount = rejected;
      break;
    }
    case "player_profile": {
      const player = validatePlayerPayload(unwrapEnvelope(payload));
      validCount = player ? 1 : 0;
      rejectedCount = player ? 0 : 1;
      break;
    }
    case "club_profile": {
      const club = validateClubPayload(unwrapEnvelope(payload));
      validCount = club ? 1 : 0;
      rejectedCount = club ? 0 : 1;
      break;
    }
    case "brawlers_catalog": {
      const { valid, rejected } = validateBrawlersPayload(asArray(payload));
      validCount = valid.length;
      rejectedCount = rejected.length;
      break;
    }
    default:
      throw new ReplayError("unvalidatable_category", `no existing validator for category "${endpointCategory}"`);
  }

  if (validCount === 0) {
    throw new ReplayError(
      "validation_produced_no_records",
      `existing validator for "${endpointCategory}" accepted 0 records from the replayed payload`
    );
  }
  return { endpointCategory, validatorRan: true, validCount, rejectedCount };
}

/**
 * Builds a ReplayValidator bound to a snapshot's endpoint_category, so
 * replayArchive() invokes the existing validator in no-write mode. `onSummary`
 * receives the per-replay validation summary.
 */
export function existingValidatorReplay(
  endpointCategory: string,
  onSummary?: (summary: ReplayValidationSummary) => void
): ReplayValidator {
  return (payload) => {
    const summary = validateReplayedPayload(endpointCategory, payload);
    onSummary?.(summary);
  };
}
