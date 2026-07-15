/**
 * Deterministic battle identity (BRAWLRANKS_WEBSITE_SPEC.md Section 7.4
 * step 6, Section 7.6 — "a battle ID derived from stable fields... the
 * same real-world battle always normalizes to the same internal ID
 * regardless of which participant's log it was observed from").
 *
 * Algorithm: sha256 hex of `${battleTimeRaw}|${mode}|${canonicalTeams}`,
 * where canonicalTeams sorts participant tags within each team and then
 * sorts the teams themselves by their canonicalized tag list — so neither
 * within-team ordering nor which team API happened to list first (which
 * observer's own team tends to be reported first) affects the result.
 *
 * battleTimeRaw is used EXACTLY as reported by the source (Section 7.4
 * step 12 — "battle time as reported by the source"), never reformatted or
 * re-parsed into a different representation before hashing, so two
 * observations of the same real battle — which report the identical
 * source string — always hash identically.
 *
 * Deliberately does NOT include Brawler selection, result, or duration in
 * the hash: those can only ever differ between two truly distinct battles
 * (in which case the participant-tag/timestamp/mode difference already
 * changes the hash), never between two observations of the same real
 * battle — including anything else would be redundant, not more correct.
 *
 * A battle with a genuinely different (e.g. fewer) set of participant tags
 * than another observation at the same timestamp/mode intentionally
 * produces a DIFFERENT key — this is a deliberate choice, not a bug: an
 * incomplete/truncated observation is a data-quality question (Section
 * 7.24's quarantine path), not something this function silently guesses
 * its way around by merging on partial information.
 */

import { sha256Hex } from "@/lib/hash";

export interface BattleIdentityInput {
  battleTimeRaw: string;
  mode: string;
  /** One array per team/slot; each inner array is that team's participant tags. */
  teams: string[][];
}

function canonicalizeTeams(teams: string[][]): string {
  const teamKeys = teams
    .map((team) => [...team].map((tag) => tag.toUpperCase()).sort().join(","))
    .filter((key) => key.length > 0)
    .sort();
  return teamKeys.join("|");
}

export function computeBattleKey(input: BattleIdentityInput): string {
  const canonical = `${input.battleTimeRaw}|${input.mode}|${canonicalizeTeams(input.teams)}`;
  return sha256Hex(canonical);
}
