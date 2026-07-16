/**
 * Pure, DB-free patch-inference logic (Phase 5.1 — BRAWLRANKS_WEBSITE_SPEC.md
 * Section 7.7, scoped down honestly per migration 0020's header comment: no
 * official patch-notes source is confirmed/wired up this phase, so a patch
 * here is inferred from the already-operational catalog-sync change
 * detection, Section 8, not from Supercell's real version identifier).
 *
 * "Meaningful catalog change" reuses Section 8.2's already-established
 * no-change/meaningful-change distinction exactly (change detection found
 * at least one event vs. none) — this is not a new, invented threshold; a
 * catalog-sync run's `detected_changes` output is already the same
 * mechanism the spec uses to decide whether a run recalculates anything at
 * all. `unexpected_mass_change`/`missing_source_data` volume anomalies
 * (lib/catalog/changeDetection.ts#detectVolumeAnomaly) never reach this
 * function in the first place — sync.ts already blocks acceptance and
 * returns `held` before change-detection/patch-inference runs for those
 * cases, so this only ever sees ordinary info/warning-severity changes.
 */

export const PATCH_SOURCE_INFERRED = "inferred_from_catalog_change" as const;

/**
 * A new patch record is warranted exactly when the triggering catalog-sync
 * run detected at least one change — a run with zero detected changes
 * (Section 8.2's "no-change" case) must never create a patch row.
 */
export function shouldCreatePatch(changeCount: number): boolean {
  return changeCount > 0;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * `internal-YYYYMMDDTHHMMSSZ` — application-generated, timestamp-derived,
 * unique to the second, deterministic for a given instant. Deliberately
 * NOT a Supercell version string (e.g. never "v56.123" or similar) — the
 * "internal-" prefix and this format make it structurally impossible to
 * mistake for an official patch version anywhere it's displayed or
 * queried. No sequence-counter table or extra query is needed: this
 * workflow already runs under a single workflow_lock (catalog-sync can
 * never run concurrently with itself), so two calls within the same
 * second are not a realistic collision risk in practice; the DB-level
 * UNIQUE constraint on `version_label` (migration 0020) is the final
 * safety net if it ever were.
 */
export function generateVersionLabel(now: Date): string {
  const y = now.getUTCFullYear();
  const mo = pad(now.getUTCMonth() + 1, 2);
  const d = pad(now.getUTCDate(), 2);
  const h = pad(now.getUTCHours(), 2);
  const mi = pad(now.getUTCMinutes(), 2);
  const s = pad(now.getUTCSeconds(), 2);
  return `internal-${y}${mo}${d}T${h}${mi}${s}Z`;
}
