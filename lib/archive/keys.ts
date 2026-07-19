/**
 * DATASET Phase 4 — deterministic archive object keys.
 *
 * The key is a pure function of a snapshot's immutable identity, so the same
 * snapshot always maps to the same object and integrity isolation is simple:
 *
 *   raw/v1/YYYY/MM/DD/<endpoint_category>/<data_fetch_run_id>/<snapshot_id>-<checksum>.json.gz
 *
 * Every dynamic segment is validated against a strict, closed pattern before it
 * is placed in a path. A category that is not in the closed mapping, or an id/
 * checksum that is not exactly the expected shape, throws — so no attacker- or
 * bug-supplied value can ever traverse (`..`, `/`) or otherwise escape the key
 * layout. The date segments come from the snapshot's `received_at` in UTC.
 */

export const ARCHIVE_KEY_PREFIX = "raw";
export const ARCHIVE_KEY_VERSION = "v1";
export const ARCHIVE_COMPRESSION = "gzip";
export const ARCHIVE_OBJECT_SUFFIX = ".json.gz";

/**
 * Closed mapping of the ONLY endpoint categories that may be archived, to their
 * safe path segment. Values are already lowercase `[a-z_]` slugs; the mapping
 * exists so that an unknown/typo/hostile category fails closed rather than being
 * written into a path. Sourced from the live distinct values in
 * raw_api_snapshots.endpoint_category (battle_log, player_profile, club_profile,
 * player_rankings, brawlers_catalog).
 */
const ENDPOINT_CATEGORY_SEGMENTS: Readonly<Record<string, string>> = Object.freeze({
  battle_log: "battle_log",
  player_profile: "player_profile",
  club_profile: "club_profile",
  player_rankings: "player_rankings",
  brawlers_catalog: "brawlers_catalog",
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export function isValidUuid(value: string): boolean {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isValidSha256(value: string): boolean {
  return typeof value === "string" && SHA256_RE.test(value);
}

/** Returns the safe path segment for a category, or throws for anything else. */
export function safeEndpointSegment(category: string): string {
  const segment = ENDPOINT_CATEGORY_SEGMENTS[category];
  if (!segment) {
    throw new Error(
      `Unarchivable endpoint_category "${category}". Only a closed set is permitted; ` +
        "add it to ENDPOINT_CATEGORY_SEGMENTS deliberately if a new category is introduced."
    );
  }
  return segment;
}

export function listArchivableCategories(): string[] {
  return Object.keys(ENDPOINT_CATEGORY_SEGMENTS);
}

export interface ArchiveKeyParts {
  snapshotId: string;
  dataFetchRunId: string;
  endpointCategory: string;
  checksum: string; // SHA-256 of the ORIGINAL payload
  receivedAt: Date;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Builds the deterministic object key. Throws if any identity component is not
 * exactly the expected shape — the key must never be built from unvalidated
 * input, because it becomes a storage path.
 */
export function buildArchiveKey(parts: ArchiveKeyParts): string {
  if (!isValidUuid(parts.snapshotId)) throw new Error("buildArchiveKey: snapshotId is not a UUID");
  if (!isValidUuid(parts.dataFetchRunId)) throw new Error("buildArchiveKey: dataFetchRunId is not a UUID");
  if (!isValidSha256(parts.checksum)) throw new Error("buildArchiveKey: checksum is not a 64-hex SHA-256");
  if (!(parts.receivedAt instanceof Date) || Number.isNaN(parts.receivedAt.getTime())) {
    throw new Error("buildArchiveKey: receivedAt is not a valid Date");
  }
  const segment = safeEndpointSegment(parts.endpointCategory);

  const yyyy = parts.receivedAt.getUTCFullYear().toString().padStart(4, "0");
  const mm = pad2(parts.receivedAt.getUTCMonth() + 1);
  const dd = pad2(parts.receivedAt.getUTCDate());

  return [
    ARCHIVE_KEY_PREFIX,
    ARCHIVE_KEY_VERSION,
    yyyy,
    mm,
    dd,
    segment,
    parts.dataFetchRunId,
    `${parts.snapshotId}-${parts.checksum.toLowerCase()}${ARCHIVE_OBJECT_SUFFIX}`,
  ].join("/");
}
