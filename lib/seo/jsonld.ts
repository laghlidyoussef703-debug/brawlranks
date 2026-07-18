/**
 * Typed, server-only JSON-LD builders for the schemas Phase 6A actually
 * needs (PHASE6.md Section 16/21): WebSite, Organization, BreadcrumbList.
 * Every other schema type (ItemList, Article, ...) belongs to the page
 * that has real data to back it and is deliberately not built here.
 *
 * Never build: Product, Review, AggregateRating, SoftwareApplication,
 * HowTo, FAQPage without real visible FAQ content, or Person without a
 * real named author — see PHASE6.md Section 21's JSON-LD matrix.
 */
import { SITE_NAME } from "@/lib/seo/metadata";
import { absoluteUrl } from "@/lib/seo/canonicalUrl";

export interface JsonLdWebSite {
  "@context": "https://schema.org";
  "@type": "WebSite";
  name: string;
  url: string;
}

export function buildWebSiteJsonLd(): JsonLdWebSite {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: absoluteUrl("/"),
  };
}

export interface JsonLdOrganization {
  "@context": "https://schema.org";
  "@type": "Organization";
  name: string;
  url: string;
  logo?: string;
}

/**
 * Only ever includes fields BrawlRanks can state truthfully today: name,
 * url, and (once the derived asset exists) logo. No sameAs/social links —
 * spec Section 17.2 confirms no social accounts are confirmed at MVP, and
 * inventing one would misrepresent the organization.
 */
export function buildOrganizationJsonLd(options: { logoPathname?: string } = {}): JsonLdOrganization {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: absoluteUrl("/"),
    ...(options.logoPathname ? { logo: absoluteUrl(options.logoPathname) } : {}),
  };
}

export interface BreadcrumbItem {
  /** Visible label. */
  name: string;
  /** App-relative path. */
  path: string;
}

export interface JsonLdBreadcrumbList {
  "@context": "https://schema.org";
  "@type": "BreadcrumbList";
  itemListElement: Array<{
    "@type": "ListItem";
    position: number;
    name: string;
    item: string;
  }>;
}

export function buildBreadcrumbListJsonLd(items: BreadcrumbItem[]): JsonLdBreadcrumbList {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export interface JsonLdArticle {
  "@context": "https://schema.org";
  "@type": "Article";
  headline: string;
  description: string;
  mainEntityOfPage: string;
  publisher: {
    "@type": "Organization";
    name: string;
  };
}

/** Static trust-page article schema with no invented author, date, or review details. */
export function buildArticleJsonLd(input: {
  headline: string;
  description: string;
  pathname: string;
}): JsonLdArticle {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.headline,
    description: input.description,
    mainEntityOfPage: absoluteUrl(input.pathname),
    publisher: {
      "@type": "Organization",
      name: SITE_NAME,
    },
  };
}

// The two JSON-legal line-terminator codepoints that are NOT legal inside a
// raw HTML <script> body. Built via String.fromCharCode rather than a
// literal escape in source to avoid any editor/encoding ambiguity.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * Serializes JSON-LD for safe embedding inside a <script> tag. Escapes
 * "<" (blocks a "</script>" break-out) and U+2028/U+2029 (valid in JSON
 * strings, invalid inside a raw <script> body) — the standard
 * safe-JSON-in-HTML escaping set.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .split("<")
    .join("\\u003c")
    .split(LINE_SEPARATOR)
    .join("\\u2028")
    .split(PARAGRAPH_SEPARATOR)
    .join("\\u2029");
}
