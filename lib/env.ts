/**
 * Typed, strictly-validated accessors for the two Phase 6A frontend
 * environment variables (.env.example). Every canonical URL, metadataBase,
 * OG tag, and robots decision in the app must go through these functions —
 * never read `process.env.NEXT_PUBLIC_SITE_URL`/`process.env.APP_ENV`
 * directly anywhere else (spec Section 17.1's "no hardcoded domain per
 * file" rule).
 *
 * APP_ENV fails closed: anything other than exactly "production" is
 * treated as non-production, so a missing/misconfigured value can never
 * accidentally cause the site to be indexed.
 */

const APP_ENVS = ["development", "staging", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

function isAppEnv(value: string | undefined): value is AppEnv {
  return typeof value === "string" && (APP_ENVS as readonly string[]).includes(value);
}

/** Falls back to "development" (never "production") when APP_ENV is missing or not one of the three supported values. */
export function getAppEnv(): AppEnv {
  const raw = process.env.APP_ENV;
  return isAppEnv(raw) ? raw : "development";
}

export function isProduction(): boolean {
  return getAppEnv() === "production";
}

/**
 * Throws with a clear, actionable message if NEXT_PUBLIC_SITE_URL is
 * missing or is not a valid absolute http(s) URL — this value is
 * foundational to every canonical/OG/JSON-LD URL the site emits, so a
 * silent fallback (e.g. to localhost) would risk shipping the wrong
 * canonical domain to production undetected.
 */
export function getSiteUrl(): URL {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL is not set. Add it to .env.local (see .env.example) — every canonical/OG/JSON-LD URL depends on it."
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`NEXT_PUBLIC_SITE_URL is not a valid absolute URL: "${raw}"`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`NEXT_PUBLIC_SITE_URL must use http or https, got "${url.protocol}" ("${raw}")`);
  }

  return url;
}

/** Site origin as a plain string with no trailing slash, e.g. "https://brawlranks.com". */
export function getSiteOrigin(): string {
  return getSiteUrl().origin;
}
