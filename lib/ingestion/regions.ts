/**
 * Region/country-code configuration for ranking-seed diversity
 * (BRAWLRANKS_WEBSITE_SPEC.md Section 7.3 — "the seed set deliberately
 * includes players from multiple regions/countries," Section 7.28's
 * "curated initial subset" recommendation).
 *
 * The spec explicitly leaves the exact initial country list as an
 * unresolved owner decision (Section 7.28) — this is a reasoned starting
 * recommendation, not a verified-optimal or spec-mandated list. Every
 * entry is chosen for geographic/gameplay-population diversity reasoning,
 * not verified real player-count data (no live proxy access this
 * session — same limitation as every prior phase). Widen or swap entries
 * once real entriesFetched/coverage data justifies it.
 */

export interface CuratedRegion {
  code: string;
  label: string;
  justification: string;
}

export const CURATED_REGIONS: CuratedRegion[] = [
  { code: "global", label: "Global", justification: "Worldwide top-players baseline — already in production use since Phase 3." },
  { code: "us", label: "United States", justification: "North America — large, historically active Brawl Stars market, English-speaking baseline distinct from the global leaderboard's composition." },
  { code: "br", label: "Brazil", justification: "Latin America — Brazil is widely documented as one of Brawl Stars' largest and most active player bases globally, a meaningfully distinct regional cluster from North America/Europe." },
  { code: "de", label: "Germany", justification: "Europe — a large, stable EU market with a long-standing Supercell-title player base." },
  { code: "sa", label: "Saudi Arabia", justification: "Middle East / North Africa — one of the larger, more active MENA mobile-gaming markets for Supercell titles, filling a region otherwise entirely absent from the sample." },
  { code: "id", label: "Indonesia", justification: "Asia — a large, mobile-first population and one of the biggest Southeast Asian markets for Supercell titles." },
  { code: "au", label: "Australia", justification: "Oceania — the natural single representative for a distinct geographic/timezone cluster otherwise unrepresented." },
];

/** Default active region list for ranking-seed-refresh — see lib/ingestion/config.ts#INITIAL_RANKING_REGIONS, which is derived from this list. */
export const CURATED_REGION_CODES: string[] = CURATED_REGIONS.map((r) => r.code);

const COUNTRY_CODE_PATTERN = /^[a-z]{2}$/i;

/**
 * "global" (case-insensitive) or exactly two ASCII letters (ISO 3166-1
 * alpha-2 shape — the official rankings endpoint's documented parameter
 * shape, consistent across every third-party mirror checked in Phase 3).
 * Never assumes a specific code is actually supported by the live API —
 * only that its *shape* is well-formed enough to be worth sending.
 */
export function isValidCountryCodeShape(code: string): boolean {
  const trimmed = code.trim();
  if (trimmed.toLowerCase() === "global") return true;
  return COUNTRY_CODE_PATTERN.test(trimmed);
}

/** Lowercase for a real ISO code; "global" stays exactly "global". Returns null for anything shape-invalid — never guesses or truncates. */
export function normalizeCountryCode(code: string): string | null {
  if (!isValidCountryCodeShape(code)) return null;
  const trimmed = code.trim();
  return trimmed.toLowerCase() === "global" ? "global" : trimmed.toLowerCase();
}
