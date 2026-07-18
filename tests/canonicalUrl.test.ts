import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SITE_URL = "https://brawlranks.com";

test("absoluteUrl: joins an app-relative path onto the site origin", async () => {
  const { absoluteUrl } = await import("@/lib/seo/canonicalUrl");
  assert.equal(absoluteUrl("/tier-list"), "https://brawlranks.com/tier-list");
});

test("absoluteUrl: tolerates a path with no leading slash", async () => {
  const { absoluteUrl } = await import("@/lib/seo/canonicalUrl");
  assert.equal(absoluteUrl("tier-list"), "https://brawlranks.com/tier-list");
});

test("canonicalUrl: strips a query string", async () => {
  const { canonicalUrl } = await import("@/lib/seo/canonicalUrl");
  assert.equal(canonicalUrl("/tier-list?rarity=chromatic"), "https://brawlranks.com/tier-list");
});

test("canonicalUrl: strips a hash fragment", async () => {
  const { canonicalUrl } = await import("@/lib/seo/canonicalUrl");
  assert.equal(canonicalUrl("/brawlers/mortis#build"), "https://brawlranks.com/brawlers/mortis");
});

test("canonicalUrl: strips a trailing slash beyond the root", async () => {
  const { canonicalUrl } = await import("@/lib/seo/canonicalUrl");
  assert.equal(canonicalUrl("/tier-list/"), "https://brawlranks.com/tier-list");
});

test("canonicalUrl: the root path itself stays exactly '/'", async () => {
  const { canonicalUrl } = await import("@/lib/seo/canonicalUrl");
  assert.equal(canonicalUrl("/"), "https://brawlranks.com/");
});
