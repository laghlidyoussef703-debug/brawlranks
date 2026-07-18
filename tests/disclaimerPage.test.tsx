import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { renderStatic } from "./testUtils/renderStatic";
import {
  DisclaimerContent,
  DISCLAIMER_METADATA,
  type DisclaimerImageSrcs,
} from "@/components/disclaimer/DisclaimerContent";

process.env.NEXT_PUBLIC_SITE_URL = "https://brawlranks.com";
process.env.APP_ENV = "production";

const FIXTURE_IMAGES: DisclaimerImageSrcs = {
  iconHunters: "/local-icon-hunters.png",
  imageWarningBan: "/local-image-warning-ban.png",
  brawlStarsLogo: "/local-brawl-stars-logo.png",
  iconQuest: "/local-icon-quest.png",
  iconLeaderboard: "/local-icon-leaderboard.png",
  iconMobaCenter: "/local-icon-moba-center.png",
  iconKnockout: "/local-icon-knockout.png",
  iconGold: "/local-icon-gold.png",
  shieldFront: "/local-shield-front.png",
  iconRebound: "/local-icon-rebound.png",
  iconCalendar: "/local-icon-calendar.png",
  iconInbox: "/local-icon-inbox.png",
  character: "/local-character.png",
};

function renderPage() {
  return renderStatic(<DisclaimerContent images={FIXTURE_IMAGES} />);
}

test("/disclaimer: renders one clear h1, the yellow subtitle, and the centered breadcrumb structure", () => {
  const doc = renderPage();
  assert.equal(doc.querySelectorAll("h1").length, 1);
  assert.equal(doc.querySelector("h1")?.textContent, "Disclaimer");
  assert.match(doc.body.textContent ?? "", /Important information about BrawlRanks/);
  const breadcrumb = doc.querySelector('nav[aria-label="Breadcrumb"]');
  assert.ok(breadcrumb);
  assert.ok(breadcrumb?.querySelector('a[href="/"]'));
  assert.equal(breadcrumb?.querySelector('[aria-current="page"]')?.textContent, "Disclaimer");
  const schema = JSON.parse(doc.querySelector('script[type="application/ld+json"]')?.textContent ?? "{}");
  assert.equal(schema["@type"], "BreadcrumbList");
  assert.equal(schema.itemListElement.at(-1)?.item, "https://brawlranks.com/disclaimer");
});

test("/disclaimer: relies on the global layout header and footer without page-specific duplicates", async () => {
  const source = await readFile("components/disclaimer/DisclaimerContent.tsx", "utf8");
  assert.doesNotMatch(source, /TrustPageHeader|TrustPageFooter|<footer/);
  assert.equal(renderPage().querySelector("main"), null);
  const layout = await readFile("app/layout.tsx", "utf8");
  assert.match(layout, /<Header /);
  assert.match(layout, /<Footer /);
});

test("/disclaimer: renders the eleven numbered reference cards plus acknowledgement and contact callout", () => {
  const doc = renderPage();
  const headings = [...doc.querySelectorAll("h2")].map((h) => h.textContent ?? "");
  for (const expected of [
    "1. Independent fan site",
    "2. No affiliation or endorsement",
    "3. Trademarks & game assets",
    "4. API & data source",
    "5. Independent rankings",
    "6. Sampled data",
    "7. Gameplay variability",
    "8. No guarantee of results",
    "9. Accuracy & availability",
    "10. Updates & revisions",
    "11. Data timing & freshness",
    "Please remember",
    "Questions or found an issue?",
  ]) {
    assert.ok(headings.some((heading) => heading.includes(expected)), `missing section heading: ${expected}`);
  }
});

test("/disclaimer: states independent fan-site status and complete Supercell non-affiliation", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /independent Brawl Stars fan website/i);
  assert.match(text, /does not represent Supercell/i);
  assert.match(text, /not an official Brawl Stars service/i);
  assert.match(text, /not affiliated with Supercell/i);
  assert.match(text, /not sponsored, approved, or endorsed by Supercell/i);
});

test("/disclaimer: attributes trademarks, game assets, and Fan Kit material to their rights holders", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /belong to their respective rights holders/i);
  assert.match(text, /Fan Kit material is third-party fan-content material and is not owned by BrawlRanks/i);
  assert.match(text, /must not imply endorsement/i);
});

test("/disclaimer: explains official API sourcing and independent, unofficial rankings", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /official Brawl Stars API/i);
  assert.match(text, /BrawlRanks automated pipeline/i);
  assert.match(text, /independently calculated/i);
  assert.match(text, /are not official Supercell rankings/i);
});

test("/disclaimer: discloses sampling, gameplay variability, and no guaranteed outcomes", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /dataset is sampled/i);
  assert.match(text, /does not represent every battle played globally/i);
  assert.match(text, /game mode, map, team composition, trophy bracket, player skill, sample size, balance changes, and patch boundaries/i);
  assert.match(text, /tendencies, not guaranteed outcomes/i);
  assert.match(text, /does not guarantee wins, rank progression, or gameplay outcomes/i);
});

test("/disclaimer: states accuracy, availability, and publication-safeguard limitations", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /complete accuracy and uninterrupted availability cannot be guaranteed/i);
  assert.match(text, /delayed, incomplete, unavailable, or temporarily held/i);
  assert.match(text, /previous valid published snapshot may stay live/i);
});

test("/disclaimer: does not expose any legal-review status to users and has no fabricated approval", async () => {
  const text = renderPage().body.textContent ?? "";
  assert.doesNotMatch(text, /\[LEGAL REVIEW REQUIRED\]/);
  assert.doesNotMatch(text, /Policy status: Draft/i);
  assert.doesNotMatch(text, /Last reviewed|reviewed on|approved by counsel|legal approval|legally approved/i);
  assert.doesNotMatch(text, /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/);
  // Verify internal code comment exists in source
  const source = await readFile("components/disclaimer/DisclaimerContent.tsx", "utf8");
  assert.match(source, /TODO:.*legal review/i);
});

test("/disclaimer: links the contact callout only because /contact actually exists", async () => {
  await access("app/contact/page.tsx");
  const doc = renderPage();
  const contactLink = doc.querySelector('a[href="/contact"]');
  assert.ok(contactLink, "contact CTA must link to the implemented /contact route");
  assert.match(contactLink?.textContent ?? "", /Contact us/i);
  for (const unimplemented of ["/privacy-policy", "/terms-of-service", "/tier-list", "/meta", "/brawlers"]) {
    assert.equal(doc.querySelector(`a[href="${unimplemented}"]`), null, `must not link to ${unimplemented}`);
  }
});

test("/disclaimer: hides decorative artwork from assistive technology, keeps rights-holder logo meaningful", () => {
  const doc = renderPage();
  const decorative = [...doc.querySelectorAll('img[aria-hidden="true"]')];
  assert.ok(decorative.length >= 10);
  for (const artwork of decorative) {
    assert.equal(artwork.getAttribute("alt"), "");
  }
  const logo = [...doc.querySelectorAll("img")].find((img) =>
    /Brawl Stars logo/i.test(img.getAttribute("alt") ?? "")
  );
  assert.ok(logo, "the trademarks card must keep a meaningful Brawl Stars logo alt");
  assert.notEqual(logo?.getAttribute("aria-hidden"), "true");
});

test("/disclaimer: uses only local Disclaimer-folder assets — no hotlinked or external images", async () => {
  const page = await readFile("app/disclaimer/page.tsx", "utf8");
  const content = await readFile("components/disclaimer/DisclaimerContent.tsx", "utf8");
  for (const source of [page, content]) {
    assert.doesNotMatch(source, /https?:\/\/[^\s"']*\.(png|jpg|jpeg|webp|gif|svg)/i);
  }
  assert.match(page, /reference_pages\/Disclaimer\//);
  for (const asset of [
    "icon_hunters.png",
    "image_warning_pop_up_ban.png",
    "zBrawl Stars Logo 2_starr_parkk.png",
    "icon_quest.png",
    "icon_leaderboard_demonic.png",
    "emoji_moba_center.png",
    "icon_knockout_5v5_power_level.png",
    "icon_gold_1.png",
    "shield_front.png",
    "icon_rebound.png",
    "icon_calendar_league_day.png",
    "icon_inbox.png",
    "barley_maple_barley_001.png",
  ]) {
    assert.ok(page.includes(asset), `page.tsx must import local asset ${asset}`);
    await access(`reference_pages/Disclaimer/${asset}`);
  }
});

test("/disclaimer: emits unique canonical, Open Graph, Twitter, and robots metadata", async () => {
  const { buildMetadata } = await import("@/lib/seo/metadata");
  const metadata = buildMetadata(DISCLAIMER_METADATA);
  assert.equal(metadata.title, "Disclaimer | BrawlRanks");
  assert.equal(metadata.alternates?.canonical, "https://brawlranks.com/disclaimer");
  assert.deepEqual(metadata.robots, { index: true, follow: true });
  assert.equal(metadata.openGraph?.url, "https://brawlranks.com/disclaimer");
  assert.ok(metadata.twitter);
  assert.match(metadata.description ?? "", /independent rankings, sampled Brawl Stars data/i);
  assert.doesNotMatch(metadata.description ?? "", /…$/, "description must fit without truncation");
});

test("/disclaimer: contains no prohibited icon library or invented legal personnel claims", async () => {
  const source = await readFile("components/disclaimer/DisclaimerContent.tsx", "utf8");
  assert.doesNotMatch(source, /lucide|fontawesome|react-icons|<svg/i);
  assert.doesNotMatch(source, /legal team|legal representative|attorney|lawyer|counsel approved/i);
});
