import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderStatic } from "./testUtils/renderStatic";
import { EditorialPolicyContent, EDITORIAL_POLICY_METADATA, type EditorialImageSrcs } from "@/components/editorial-policy/EditorialPolicyContent";
import { Footer } from "@/components/layout/Footer";
import { LIVE_FOOTER_GROUPS } from "@/components/layout/navigation";

process.env.NEXT_PUBLIC_SITE_URL = "https://brawlranks.com";
process.env.APP_ENV = "production";

const FIXTURE_IMAGES: EditorialImageSrcs = {
  iconAutomated: "/local-icon-settings.png",
  iconAiAssisted: "/local-foldable-robot-pin.png",
  iconHuman: "/local-icon-hunters.png",
  tick: "/local-tick.png",
  noteStar: "/local-emoji-moba-center.png",
  stepDataCollection: "/local-shield-front.png",
  stepValidation: "/local-mystery-icon.png",
  stepQualityChecks: "/local-icon-quest.png",
  stepPublish: "/local-icon-calendar-league-day.png",
  policyUnsupported: "/local-icon-leaderboard-demonic.png",
  policyCorrections: "/local-warning-icon.png",
  policyConflict: "/local-wipeout-icon.png",
  policyFreshness: "/local-icon-modifier-timedeto.png",
  policySource: "/local-icon-quest.png",
  policyRankings: "/local-pin-battle-button.png",
  bannerCharacter: "/local-barley-maple-barley-001.png",
  decorStar: "/local-emoji-moba-center.png",
  decorSkull: "/local-wipeout-icon.png",
  decorFace: "/local-gem-grab-icon.png",
  decorGem: "/local-gem-red.png",
};

function renderPage() {
  return renderStatic(<EditorialPolicyContent images={FIXTURE_IMAGES} />);
}

test("/editorial-policy: renders exactly one h1, the yellow subtitle, and a compact breadcrumb", () => {
  const doc = renderPage();
  assert.equal(doc.querySelectorAll("h1").length, 1);
  assert.equal(doc.querySelector("h1")?.textContent, "Editorial Policy");

  const text = doc.body.textContent ?? "";
  assert.match(text, /Transparency\. Accuracy\. Fairness\./);
  assert.match(text, /At BrawlRanks, our goal is to publish useful and reliable Brawl Stars information/i);

  const crumb = doc.querySelector('nav[aria-label="Breadcrumb"]');
  assert.ok(crumb, "breadcrumb nav present");
  assert.ok(crumb?.querySelector('a[href="/"]'), "Home is a link");
  assert.equal(doc.querySelector('[aria-current="page"]')?.textContent, "Editorial Policy");
});

test("/editorial-policy: renders the three primary content-type cards in order", () => {
  const headings = [...renderPage().querySelectorAll(".editorial-content h2")].map((h) => h.textContent?.trim());
  assert.deepEqual(headings.slice(0, 3), ["1. What Is Automated", "2. What Is AI-Assisted", "3. Human Editorial Content"]);
});

test("/editorial-policy: distinguishes automated, AI-assisted, and human editorial content truthfully", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /generated automatically using collected data and predefined rules/i);
  assert.match(text, /they are not manually written numbers/i);
  assert.match(text, /AI may help turn already-calculated information/i);
  assert.match(text, /AI does not independently choose tier scores or invent ranking numbers/i);
  assert.match(text, /Human-written editorial content may be reviewed before it is published/i);
});

test("/editorial-policy: renders the five review steps in the correct order", () => {
  const steps = [...renderPage().querySelectorAll("ol h3")].map((h) => h.textContent?.replace(/\s+/g, " ").trim());
  assert.deepEqual(steps, [
    "1. Data Collection",
    "2. Validation",
    "3. Quality Checks",
    "4. Review Decision",
    "5. Publish & Update",
  ]);
});

test("/editorial-policy: renders the six lower policy cards in the correct order", () => {
  const doc = renderPage();
  const titles = [...doc.querySelectorAll(".editorial-content h2")]
    .map((h) => h.textContent?.trim())
    .filter((t): t is string =>
      [
        "Preventing Unsupported Claims",
        "Corrections Policy",
        "Conflict of Interest",
        "Update & Freshness",
        "Source Attribution",
        "Rankings vs Opinion",
      ].includes(t ?? ""),
    );
  assert.deepEqual(titles, [
    "Preventing Unsupported Claims",
    "Corrections Policy",
    "Conflict of Interest",
    "Update & Freshness",
    "Source Attribution",
    "Rankings vs Opinion",
  ]);
});

test("/editorial-policy: never links to or names the cancelled /methodology page", () => {
  const doc = renderPage();
  assert.equal(doc.querySelector('a[href="/methodology"]'), null, "must not link to removed /methodology");
  const text = doc.body.textContent ?? "";
  assert.doesNotMatch(text, /methodology/i, "must not name Methodology as a public label or CTA");
  assert.doesNotMatch(text, /Read Methodology|View Methodology/i);
});

test("/editorial-policy: links only to implemented trust routes (contact + disclaimer)", () => {
  const doc = renderPage();
  assert.ok(doc.querySelector('a[href="/disclaimer"]'), "links to /disclaimer");
  assert.ok(doc.querySelector('a[href="/contact"]'), "links to /contact");
  for (const unimplemented of ["/privacy-policy", "/terms-of-service", "/sources", "/methodology", "/updates-schedule"]) {
    assert.equal(doc.querySelector(`a[href="${unimplemented}"]`), null, `must not link to ${unimplemented}`);
  }
});

test("/editorial-policy: non-clickable CTAs are truthful labels, not links or focusable buttons", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /Updated When Data Changes/);
  assert.match(text, /Understand the Difference/);
  // These informational labels are spans, so they never appear as anchors/buttons.
  const doc = renderPage();
  const anchors = [...doc.querySelectorAll("a")].map((a) => a.textContent);
  assert.ok(!anchors.includes("Updated When Data Changes"));
  assert.ok(!anchors.includes("Understand the Difference"));
});

test("/editorial-policy: decorative artwork is hidden from assistive technology with empty alt", () => {
  const artworks = [...renderPage().querySelectorAll('img[aria-hidden="true"]')];
  assert.ok(artworks.length > 0);
  for (const artwork of artworks) {
    assert.equal(artwork.getAttribute("alt"), "");
  }
});

test("/editorial-policy: references only local assets, no external image URLs", () => {
  const srcs = [...renderPage().querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "");
  assert.ok(srcs.length > 0);
  for (const src of srcs) {
    assert.doesNotMatch(src, /^https?:\/\//, `image src must be local, got ${src}`);
  }
});

test("/editorial-policy: relies on shared layout chrome without page-specific header/footer/main", async () => {
  const source = await readFile("components/editorial-policy/EditorialPolicyContent.tsx", "utf8");
  // No page-specific site chrome: no duplicate footer, no bespoke trust-page header/footer, no <main> (the shared layout owns those).
  assert.doesNotMatch(source, /TrustPageHeader|TrustPageFooter|EditorialHeader|EditorialFooter|<footer|<main/);
  assert.doesNotMatch(source, /@\/components\/layout\/(Header|Footer)/, "must not import site Header/Footer directly — they come from the layout");
  const doc = renderPage();
  assert.equal(doc.querySelector("main"), null);
  assert.equal(doc.querySelector("footer"), null);
});

test("/editorial-policy: the shared footer carries no Methodology entry", () => {
  const footer = renderStatic(<Footer groups={LIVE_FOOTER_GROUPS} />);
  assert.equal(footer.querySelector('a[href="/methodology"]'), null);
  assert.doesNotMatch(footer.body.textContent ?? "", /methodology/i);
});

test("/editorial-policy: contains no fabricated staff, dates, or guaranteed-frequency claims", async () => {
  const source = await readFile("components/editorial-policy/EditorialPolicyContent.tsx", "utf8");
  assert.doesNotMatch(source, /editorial team|full-time|named editor|named writer|journalist|legal reviewer|moderator|24\/7/i);
  assert.doesNotMatch(source, /updated (every day|daily|hourly|every hour)|every single page|guaranteed/i);
  // No icon-library usage and no inline SVG — every icon is a supplied local <Image> asset.
  assert.doesNotMatch(source, /placeholder|fixture|lucide|fontawesome|react-icons|<svg/i);
  // No emoji glyphs used as substitutes for the supplied art (checked against rendered text, not filename comments).
  const emojiGlyphs = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  assert.doesNotMatch(renderPage().body.textContent ?? "", emojiGlyphs);
});

test("/editorial-policy: page.tsx wires the exact local editorial-policy asset filenames", async () => {
  const source = await readFile("app/editorial-policy/page.tsx", "utf8");
  for (const file of [
    "icon_settings.png",
    "foldable_robot_pin.png",
    "icon_hunters.png",
    "tick.png",
    "emoji_moba_center.png",
    "shield_front.png",
    "mystery_icon.png",
    "icon_quest.png",
    "icon_calendar_league_day.png",
    "icon_leaderboard_demonic.png",
    "warning_icon.png",
    "wipeout_icon.png",
    "icon_modifier_timedeto.png",
    "pin_battle_button.png",
    "barley_maple_barley_001.png",
    "gem_grab_icon.png",
    "gem_red.png",
  ]) {
    assert.ok(source.includes(`reference_pages/editorial-policy/${file}`), `page.tsx must import ${file}`);
  }
  assert.doesNotMatch(source, /https?:\/\//, "no remote asset URLs");
});

test("/editorial-policy: emits truthful breadcrumb and article structured data", () => {
  const doc = renderPage();
  const schemas = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((node) => JSON.parse(node.textContent ?? "{}"));
  const breadcrumb = schemas.find((schema) => schema["@type"] === "BreadcrumbList");
  assert.ok(breadcrumb, "BreadcrumbList schema present");
  assert.equal(breadcrumb.itemListElement.at(-1)?.name, "Editorial Policy");
  const article = schemas.find((schema) => schema["@type"] === "Article");
  assert.equal(article?.headline, "Editorial Policy");
  assert.equal(article?.publisher?.name, "BrawlRanks");
  assert.equal(article?.mainEntityOfPage, "https://brawlranks.com/editorial-policy");
  assert.equal(article?.author, undefined, "no invented author");
  assert.equal(article?.datePublished, undefined, "no invented publication date");
});

test("/editorial-policy: uses truthful route metadata through the shared helper", async () => {
  const { buildMetadata } = await import("@/lib/seo/metadata");
  const metadata = buildMetadata(EDITORIAL_POLICY_METADATA);
  assert.equal(metadata.title, "Editorial Policy | BrawlRanks");
  assert.equal(metadata.alternates?.canonical, "https://brawlranks.com/editorial-policy");
  assert.deepEqual(metadata.robots, { index: true, follow: true });
  assert.match(metadata.description ?? "", /automated rankings, AI-assisted explanations, and human editorial content/i);
  assert.equal(metadata.openGraph?.url, "https://brawlranks.com/editorial-policy");
  assert.ok(metadata.twitter);
});
