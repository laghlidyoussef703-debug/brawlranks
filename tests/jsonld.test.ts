import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SITE_URL = "https://brawlranks.com";

test("buildWebSiteJsonLd: produces a valid WebSite shape", async () => {
  const { buildWebSiteJsonLd } = await import("@/lib/seo/jsonld");
  const data = buildWebSiteJsonLd();
  assert.equal(data["@type"], "WebSite");
  assert.equal(data.name, "BrawlRanks");
  assert.equal(data.url, "https://brawlranks.com/");
});

test("buildOrganizationJsonLd: omits logo when not supplied (never a guessed/fabricated field)", async () => {
  const { buildOrganizationJsonLd } = await import("@/lib/seo/jsonld");
  const data = buildOrganizationJsonLd();
  assert.equal(data["@type"], "Organization");
  assert.equal("logo" in data, false);
});

test("buildOrganizationJsonLd: includes an absolute logo URL when a pathname is supplied", async () => {
  const { buildOrganizationJsonLd } = await import("@/lib/seo/jsonld");
  const data = buildOrganizationJsonLd({ logoPathname: "/brand/logo-wordmark.png" });
  assert.equal(data.logo, "https://brawlranks.com/brand/logo-wordmark.png");
});

test("buildBreadcrumbListJsonLd: builds a positioned ListItem array with absolute URLs", async () => {
  const { buildBreadcrumbListJsonLd } = await import("@/lib/seo/jsonld");
  const data = buildBreadcrumbListJsonLd([
    { name: "Home", path: "/" },
    { name: "Brawlers", path: "/brawlers" },
    { name: "Mortis", path: "/brawlers/mortis" },
  ]);
  assert.equal(data.itemListElement.length, 3);
  assert.equal(data.itemListElement[0].position, 1);
  assert.equal(data.itemListElement[2].position, 3);
  assert.equal(data.itemListElement[2].item, "https://brawlranks.com/brawlers/mortis");
});

test("serializeJsonLd: escapes '<' so a '</script>' break-out is impossible", async () => {
  const { serializeJsonLd } = await import("@/lib/seo/jsonld");
  const malicious = { name: "</script><script>alert(1)</script>" };
  const serialized = serializeJsonLd(malicious);
  // Every "<" becomes "<" — the browser's HTML parser can no longer
  // recognize a "</script>" closing sequence without a literal "<",
  // regardless of the trailing ">" (which doesn't need escaping too).
  assert.doesNotMatch(serialized, /<\/script>/);
  assert.match(serialized, /\\u003c\/script>/);
  assert.equal(serialized.includes("<"), false, "no raw '<' should survive serialization");
});

test("serializeJsonLd: produces valid JSON once the escape sequences are reversed", async () => {
  const { serializeJsonLd } = await import("@/lib/seo/jsonld");
  const data = { a: 1, b: "text" };
  const serialized = serializeJsonLd(data);
  const roundTripped = JSON.parse(serialized.split("\\u003c").join("<"));
  assert.deepEqual(roundTripped, data);
});
