/**
 * Raw -> normalized transform for the Brawler catalog (layer A -> layer B,
 * BRAWLRANKS_WEBSITE_SPEC.md Section 7.5). Pure functions, no I/O — callers
 * are responsible for persisting the result to normalized_snapshots.
 */

import { sha256Hex, stableStringify } from "@/lib/hash";
import type { RawBrawlerItem } from "@/lib/catalog/schema";

export interface NormalizedBrawler {
  sourceId: string;
  name: string;
  slug: string;
  starPowers: Array<{ sourceId: string; name: string }>;
  gadgets: Array<{ sourceId: string; name: string }>;
}

export interface NormalizedEntitySnapshot {
  entityType: "brawler";
  entityId: string;
  normalized: NormalizedBrawler;
  normalizedPayloadJson: string;
  payloadChecksum: string;
}

/**
 * Deterministic slug generation: lowercase, non-alphanumeric runs collapsed
 * to a single hyphen, leading/trailing hyphens trimmed. Generated once at
 * first sync and never regenerated from a later name change (Section 7.6 —
 * a rename produces an alias row, not a slug change), so this function is
 * only ever called for entities not yet in canonical_brawlers.
 */
export function generateSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "unnamed";
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Normalizes one validated raw Brawler item into a canonical, order-stable
 * shape. Nested starPowers/gadgets are sorted by source id so that two
 * fetches carrying the same set in a different order produce an identical
 * checksum (required for accurate no-change detection, Section 8.2).
 */
export function normalizeBrawlerItem(item: RawBrawlerItem): NormalizedEntitySnapshot {
  const normalized: NormalizedBrawler = {
    sourceId: item.id,
    name: item.name,
    slug: generateSlug(item.name),
    starPowers: sortById(item.starPowers.map((s) => ({ id: s.id, name: s.name }))).map((s) => ({
      sourceId: s.id,
      name: s.name,
    })),
    gadgets: sortById(item.gadgets.map((g) => ({ id: g.id, name: g.name }))).map((g) => ({
      sourceId: g.id,
      name: g.name,
    })),
  };

  const normalizedPayloadJson = stableStringify(normalized);
  const payloadChecksum = sha256Hex(normalizedPayloadJson);

  return {
    entityType: "brawler",
    entityId: item.id,
    normalized,
    normalizedPayloadJson,
    payloadChecksum,
  };
}

export function normalizeBrawlerItems(items: RawBrawlerItem[]): NormalizedEntitySnapshot[] {
  return items.map(normalizeBrawlerItem);
}
