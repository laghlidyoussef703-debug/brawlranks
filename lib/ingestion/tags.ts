/**
 * Player/club tag normalization (BRAWLRANKS_WEBSITE_SPEC.md Section 7.6 —
 * the official tag is the stable external identity for players/clubs).
 *
 * Official tags always start with "#" and use a restricted alphanumeric
 * alphabet (digits and uppercase letters, excluding easily-confused
 * characters — verified via three independent third-party API-wrapper
 * sources this session, see PHASE3.md "Endpoint verification"). Tags are
 * case-insensitive at the API but stored canonically uppercase.
 */

const TAG_PATTERN = /^#[0289PYLQGRJCUV]+$/;

export interface TagValidationResult {
  valid: boolean;
  normalized: string | null;
  reason?: "empty" | "invalid_characters" | "too_short" | "too_long";
}

/**
 * Normalizes a raw tag string to canonical form: uppercase, single leading
 * "#". Accepts input with or without the leading "#" (some UIs/queries omit
 * it) but never invents a tag that wasn't structurally plausible.
 */
export function validateAndNormalizeTag(raw: string): TagValidationResult {
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.length === 0) {
    return { valid: false, normalized: null, reason: "empty" };
  }

  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;

  if (withHash.length < 4) {
    return { valid: false, normalized: null, reason: "too_short" };
  }
  if (withHash.length > 16) {
    return { valid: false, normalized: null, reason: "too_long" };
  }
  if (!TAG_PATTERN.test(withHash)) {
    return { valid: false, normalized: null, reason: "invalid_characters" };
  }

  return { valid: true, normalized: withHash };
}

/**
 * Percent-encodes a normalized tag for use as a URL path segment — the
 * official API requires "#" to be encoded as "%23" (documented consistently
 * across every third-party client checked this session).
 */
export function encodeTagForPath(normalizedTag: string): string {
  return normalizedTag.replace("#", "%23");
}
