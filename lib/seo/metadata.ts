/**
 * Reusable server-only metadata helpers (Phase 6A foundation only — see
 * PHASE6.md Section 9/15). These produce valid root/foundation metadata and
 * the shared building blocks every later Phase 6 page reuses; they do not
 * assign final per-page title/description copy for pages that don't exist
 * yet in this subphase.
 */
import type { Metadata } from "next";
import { isProduction } from "@/lib/env";
import { absoluteUrl, canonicalUrl } from "@/lib/seo/canonicalUrl";

export const SITE_NAME = "BrawlRanks";

export const DEFAULT_TITLE = `${SITE_NAME} — Brawl Stars Tier List & Meta`;

export const DEFAULT_DESCRIPTION =
  "BrawlRanks tracks real Brawl Stars match data to calculate Brawler tiers, meta shifts, and counters — an independent fan project, not an official Supercell service.";

/** "{page title} | BrawlRanks", or the site default when no page title is given. */
export function buildTitle(pageTitle?: string): string {
  const trimmed = pageTitle?.trim();
  return trimmed ? `${trimmed} | ${SITE_NAME}` : DEFAULT_TITLE;
}

/**
 * Collapses whitespace and hard-truncates on a word boundary at
 * `maxLength` (default 160, the practical meta-description ceiling) —
 * never mid-word, never mid-entity. Truncation is a display safeguard for
 * accidentally long input, not a content-authoring tool.
 */
export function normalizeDescription(input: string, maxLength = 160): string {
  const collapsed = input.trim().replace(/\s+/g, " ");
  if (collapsed.length <= maxLength) return collapsed;

  const cut = collapsed.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const safeCut = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${safeCut.trimEnd()}…`;
}

export interface RobotsDirective {
  index: boolean;
  follow: boolean;
}

/**
 * Environment-aware robots directive: only APP_ENV=production ever permits
 * indexing (spec Section 17.1 — "Hostinger preview/staging domains are
 * always noindexed"). `forceNoIndex` lets an individual page (e.g. the
 * Phase 6A root preview scaffold, PHASE6.md Section 20) stay noindexed even
 * in production, for a reason unrelated to environment.
 *
 * Returns a deliberately narrower type than Next's own `Metadata["robots"]`
 * (which also allows a plain shorthand string) — this function always
 * builds the object form, so callers get real index/follow properties to
 * read without an extra type guard.
 */
export function robotsDirective(options: { forceNoIndex?: boolean } = {}): RobotsDirective {
  const indexable = isProduction() && !options.forceNoIndex;
  return {
    index: indexable,
    follow: indexable,
  };
}

export interface BuildMetadataInput {
  /** Page-specific title fragment; omit for the site default. */
  title?: string;
  /** Required — every page must supply a real, truthful description. */
  description: string;
  /** App-relative path, e.g. "/tier-list", used for canonical + OG url. */
  pathname: string;
  /** See robotsDirective — defaults to false (environment alone decides). */
  forceNoIndex?: boolean;
  /** Open Graph image path (app-relative); omitted entirely if not supplied, never a guessed default. */
  ogImagePathname?: string;
}

/**
 * Builds a Metadata object covering title, description, canonical,
 * baseline Open Graph properties, and environment-aware robots. Individual
 * pages may spread this and override/extend fields it doesn't cover
 * (structured data, Twitter card variants, etc.) once those pages exist.
 */
export function buildMetadata(input: BuildMetadataInput): Metadata {
  const description = normalizeDescription(input.description);
  const url = canonicalUrl(input.pathname);
  const title = buildTitle(input.title);

  return {
    title,
    description,
    alternates: {
      canonical: url,
    },
    robots: robotsDirective({ forceNoIndex: input.forceNoIndex }),
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      type: "website",
      ...(input.ogImagePathname ? { images: [{ url: absoluteUrl(input.ogImagePathname) }] } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}
