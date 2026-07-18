import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SITE_URL = "https://brawlranks.com";

test("buildTitle: falls back to the site default when no page title is given", async () => {
  const { buildTitle, DEFAULT_TITLE } = await import("@/lib/seo/metadata");
  assert.equal(buildTitle(), DEFAULT_TITLE);
  assert.equal(buildTitle(undefined), DEFAULT_TITLE);
});

test("buildTitle: appends the site name to a page title", async () => {
  const { buildTitle } = await import("@/lib/seo/metadata");
  assert.equal(buildTitle("Tier List"), "Tier List | BrawlRanks");
});

test("normalizeDescription: collapses internal whitespace", async () => {
  const { normalizeDescription } = await import("@/lib/seo/metadata");
  assert.equal(normalizeDescription("Hello   world\n\tfoo"), "Hello world foo");
});

test("normalizeDescription: returns short input unchanged", async () => {
  const { normalizeDescription } = await import("@/lib/seo/metadata");
  assert.equal(normalizeDescription("Short description."), "Short description.");
});

test("normalizeDescription: truncates long input on a word boundary with an ellipsis", async () => {
  const { normalizeDescription } = await import("@/lib/seo/metadata");
  const long = "word ".repeat(60).trim();
  const result = normalizeDescription(long, 50);
  assert.ok(result.length <= 51, `expected <=51 chars, got ${result.length}`);
  assert.ok(result.endsWith("…"));
  assert.doesNotMatch(result, /\sword$/, "must not cut mid-word before the ellipsis");
});

test("robotsDirective: non-indexable when APP_ENV is not 'production'", async () => {
  process.env.APP_ENV = "staging";
  const { robotsDirective } = await import("@/lib/seo/metadata");
  const robots = robotsDirective();
  assert.equal(robots.index, false);
  assert.equal(robots.follow, false);
});

test("robotsDirective: indexable when APP_ENV is 'production' and forceNoIndex is not set", async () => {
  process.env.APP_ENV = "production";
  const { robotsDirective } = await import("@/lib/seo/metadata");
  const robots = robotsDirective();
  assert.equal(robots.index, true);
  assert.equal(robots.follow, true);
});

test("robotsDirective: forceNoIndex overrides production indexability", async () => {
  process.env.APP_ENV = "production";
  const { robotsDirective } = await import("@/lib/seo/metadata");
  const robots = robotsDirective({ forceNoIndex: true });
  assert.equal(robots.index, false);
  assert.equal(robots.follow, false);
});

test("buildMetadata: produces a canonical URL and title from the given pathname", async () => {
  process.env.APP_ENV = "production";
  const { buildMetadata } = await import("@/lib/seo/metadata");
  const metadata = buildMetadata({ title: "Tier List", description: "A description.", pathname: "/tier-list" });
  assert.equal(metadata.alternates?.canonical, "https://brawlranks.com/tier-list");
  assert.equal(metadata.title, "Tier List | BrawlRanks");
  assert.equal(metadata.description, "A description.");
});
