/**
 * Defensive validation for the official /v1/brawlers catalog payload.
 *
 * The exact real payload shape has NOT been independently verified in this
 * session (no local DB credentials, no Hostinger MCP access to inspect a
 * stored raw snapshot — see PHASE2.md "Known Limitations"). This validator
 * is deliberately conservative: it requires only `id` and `name` per
 * Brawler item (the two fields every public description of the endpoint
 * agrees on), and treats `starPowers`/`gadgets` as optional, best-effort
 * arrays. Anything else present on an item is ignored, not rejected — an
 * unknown extra field must never fail validation (BRAWLRANKS_WEBSITE_SPEC.md
 * Section 7.24: quarantine individual bad records, don't fail the whole run
 * over a shape not yet modeled).
 *
 * Rarity, class, description, and image fields are intentionally NOT
 * validated or extracted here — see migrations/0006 for why.
 */

export interface RawGadgetOrStarPower {
  id: string;
  name: string;
}

export interface RawBrawlerItem {
  id: string;
  name: string;
  starPowers: RawGadgetOrStarPower[];
  gadgets: RawGadgetOrStarPower[];
}

export interface RejectedItem {
  index: number;
  reason:
    | "not_an_object"
    | "missing_or_invalid_id"
    | "missing_or_invalid_name";
  rawId?: string;
}

export interface ValidationResult {
  valid: RawBrawlerItem[];
  rejected: RejectedItem[];
}

function coerceIdentifier(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function coerceName(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/**
 * Extracts well-formed { id, name } pairs from an optional nested array,
 * silently dropping malformed entries rather than rejecting the parent
 * Brawler — a single bad gadget entry must not quarantine an entire
 * otherwise-valid Brawler.
 */
function extractSubItems(value: unknown): RawGadgetOrStarPower[] {
  if (!Array.isArray(value)) return [];

  const results: RawGadgetOrStarPower[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = coerceIdentifier(record.id);
    const name = coerceName(record.name);
    if (id !== null && name !== null) {
      results.push({ id, name });
    }
  }
  return results;
}

export function validateBrawlersPayload(items: unknown[]): ValidationResult {
  const valid: RawBrawlerItem[] = [];
  const rejected: RejectedItem[] = [];

  items.forEach((item, index) => {
    if (item === null || typeof item !== "object") {
      rejected.push({ index, reason: "not_an_object" });
      return;
    }

    const record = item as Record<string, unknown>;
    const id = coerceIdentifier(record.id);
    if (id === null) {
      rejected.push({ index, reason: "missing_or_invalid_id" });
      return;
    }

    const name = coerceName(record.name);
    if (name === null) {
      rejected.push({ index, reason: "missing_or_invalid_name", rawId: id });
      return;
    }

    valid.push({
      id,
      name,
      starPowers: extractSubItems(record.starPowers),
      gadgets: extractSubItems(record.gadgets),
    });
  });

  return { valid, rejected };
}
