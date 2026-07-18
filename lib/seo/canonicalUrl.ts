/**
 * The single canonical/absolute URL builder every page, metadata helper,
 * and JSON-LD builder must go through (PHASE6.md Section 9 — "no duplicate
 * canonical-building logic"). Always derived from lib/env.ts's
 * getSiteUrl(), never a hardcoded production domain or localhost.
 */
import { getSiteUrl } from "@/lib/env";

/** Absolute URL for an app-relative pathname, e.g. absoluteUrl("/tier-list") -> "https://brawlranks.com/tier-list". */
export function absoluteUrl(pathname: string): string {
  const site = getSiteUrl();
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return new URL(normalized, site).toString();
}

/**
 * Canonical URL for a pathname: strips any query string/hash (spec Section
 * 17.4 — filtered/sorted views always canonicalize back to the clean base
 * route, never a query-param variant) and any trailing slash beyond the
 * root.
 */
export function canonicalUrl(pathname: string): string {
  const [pathOnly] = pathname.split("?");
  const [clean] = pathOnly.split("#");
  const trimmed = clean.length > 1 && clean.endsWith("/") ? clean.slice(0, -1) : clean;
  return absoluteUrl(trimmed);
}
