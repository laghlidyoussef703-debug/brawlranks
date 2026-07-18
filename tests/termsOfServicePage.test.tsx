import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { renderStatic } from "./testUtils/renderStatic";
import {
  TermsOfServiceContent,
  TERMS_OF_SERVICE_METADATA,
  type TermsImageSrcs,
} from "@/components/terms-of-service/TermsOfServiceContent";

process.env.NEXT_PUBLIC_SITE_URL = "https://brawlranks.com";
process.env.APP_ENV = "production";

const FIXTURE_IMAGES: TermsImageSrcs = {
  iconQuest: "/local-icon-quest.png",
  tick: "/local-tick.png",
  warningIcon: "/local-warning-icon.png",
  iconMagnet: "/local-magnet.png",
  wipeoutIcon: "/local-wipeout.png",
  warningExclamation: "/local-warning-exclamation.png",
  iconGym: "/local-gym.png",
  iconSpeed: "/local-speed.png",
  iconSettings: "/local-settings.png",
  iconKnockout: "/local-knockout.png",
  mapMaker: "/local-map-maker.png",
  gemRed: "/local-gem-red.png",
  iconInbox: "/local-icon-inbox.png",
};

function renderPage() {
  return renderStatic(<TermsOfServiceContent images={FIXTURE_IMAGES} />);
}

test("/terms-of-service: renders exactly one h1 with the correct title", () => {
  const doc = renderPage();
  assert.equal(doc.querySelectorAll("h1").length, 1);
  assert.equal(doc.querySelector("h1")?.textContent, "Terms of Service");
});

test("/terms-of-service: renders the yellow subtitle and truthful acceptance intro", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /Please read these terms carefully\./);
  assert.match(text, /By accessing or using BrawlRanks, you agree to be bound by these Terms of Service/i);
  assert.match(text, /If you do not agree, please do not use our website/i);
});

test("/terms-of-service: renders the centered breadcrumb ending on Terms of Service", () => {
  const doc = renderPage();
  const breadcrumb = doc.querySelector('nav[aria-label="Breadcrumb"]');
  assert.ok(breadcrumb);
  assert.ok(breadcrumb?.querySelector('a[href="/"]'));
  assert.equal(breadcrumb?.querySelector('[aria-current="page"]')?.textContent, "Terms of Service");
  // Current page is not itself a link.
  assert.equal(breadcrumb?.querySelector('a[href="/terms-of-service"]'), null);
});

test("/terms-of-service: emits BreadcrumbList JSON-LD (and no invented Article metadata)", () => {
  const doc = renderPage();
  const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) =>
    JSON.parse(s.textContent ?? "{}")
  );
  const breadcrumb = scripts.find((s) => s["@type"] === "BreadcrumbList");
  assert.ok(breadcrumb);
  assert.equal(breadcrumb.itemListElement.at(-1)?.item, "https://brawlranks.com/terms-of-service");
  assert.equal(scripts.find((s) => s["@type"] === "Article"), undefined, "no Article schema for this page");
});

test("/terms-of-service: relies on the global layout header/footer without page-specific duplicates", async () => {
  const source = await readFile("components/terms-of-service/TermsOfServiceContent.tsx", "utf8");
  assert.doesNotMatch(source, /TrustPageHeader|TrustPageFooter|<footer/);
  assert.equal(renderPage().querySelector("main"), null);
  const layout = await readFile("app/layout.tsx", "utf8");
  assert.match(layout, /<Header /);
  assert.match(layout, /<Footer /);
});

test("/terms-of-service: sidebar lists all 13 sections in order with valid same-page anchors", () => {
  const doc = renderPage();
  const nav = doc.querySelector('nav[aria-label="On this page"]');
  assert.ok(nav);
  const anchors = [...(nav?.querySelectorAll("a") ?? [])];
  assert.equal(anchors.length, 13);
  const expected = [
    "1. Acceptance of Terms",
    "2. Permitted Use",
    "3. Prohibited Use",
    "4. Intellectual Property",
    "5. User Submissions",
    "6. Disclaimer of Warranties",
    "7. Limitation of Liability",
    "8. External Links",
    "9. Service Changes",
    "10. Termination",
    "11. Governing Law",
    "12. Changes to These Terms",
    "13. Contact Us",
  ];
  anchors.forEach((a, i) => {
    assert.match(a.textContent ?? "", new RegExp(expected[i].replace(/[.]/g, "\\.")));
    const href = a.getAttribute("href") ?? "";
    assert.match(href, /^#[a-z-]+$/);
    assert.ok(doc.getElementById(href.slice(1)), `missing anchor target ${href}`);
  });
  // First item is the current one, not communicated by color alone.
  assert.equal(anchors[0]?.getAttribute("aria-current"), "true");
  assert.match(anchors[0]?.textContent ?? "", /Current section:/);
  // No Methodology item.
  assert.doesNotMatch(nav?.textContent ?? "", /methodology/i);
});

test("/terms-of-service: renders exactly twelve numbered legal cards in numerical DOM order", () => {
  const doc = renderPage();
  const cardHeadings = [...doc.querySelectorAll("section[id] h2")]
    .map((h) => h.textContent ?? "")
    .filter((t) => /^\d+\./.test(t));
  assert.equal(cardHeadings.length, 12);
  const numbers = cardHeadings.map((t) => parseInt(t, 10));
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("/terms-of-service: acceptance and permitted-use wording is truthful (no account contract)", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /which has no user accounts or registration/i);
  assert.match(text, /lawful, personal, and informational purposes/i);
  assert.match(text, /viewing rankings, browsing Brawler information, reading guides, comparing builds/i);
});

test("/terms-of-service: prohibited-use allows legitimate indexing but bars abusive automation", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /Automated access that violates robots rules, bypasses controls, or creates unreasonable load is prohibited/i);
  assert.match(text, /introduce malicious code|impersonate/i);
});

test("/terms-of-service: intellectual-property distinguishes BrawlRanks content from Supercell assets", () => {
  const doc = renderPage();
  const text = doc.body.textContent ?? "";
  assert.match(text, /BrawlRanks branding, layout, original text, and original analysis belong to BrawlRanks/i);
  assert.match(text, /Brawl Stars, Supercell, characters, logos, artwork, and trademarks belong to their respective rights holders/i);
  assert.match(text, /independent fan site/i);
  // Cross-references the real /disclaimer route.
  assert.ok(doc.querySelector('a[href="/disclaimer"]'));
  assert.doesNotMatch(text, /BrawlRanks owns Brawl Stars|owns Supercell/i);
});

test("/terms-of-service: user-submissions invents no current posting/storage system", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /does not currently store website form submissions, reviews, comments, or uploaded content/i);
  assert.match(text, /future interactive features may carry additional terms/i);
  assert.doesNotMatch(text, /you grant us a license to your (?:content|submissions|uploads)/i);
});

test("/terms-of-service: warranty and liability sections carry the lawful qualification", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /"as is" and "as available"/i);
  assert.match(text, /to the extent permitted by applicable law/i);
  assert.match(text, /Nothing in these Terms excludes liability that cannot legally be excluded/i);
  // No invented monetary cap / total immunity.
  assert.doesNotMatch(text, /\$\s?\d|maximum liability|liable for no more than/i);
});

test("/terms-of-service: external-links and service-changes wording is present and measured", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /may link to third-party websites/i);
  assert.match(text, /including a link does not necessarily imply endorsement/i);
  assert.match(text, /may modify, add, remove, suspend, or discontinue features/i);
  assert.match(text, /service availability is not guaranteed/i);
});

test("/terms-of-service: termination wording does not invent user accounts", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /may restrict or block access where reasonably necessary/i);
  assert.match(text, /no user accounts to suspend/i);
  assert.doesNotMatch(text, /suspend your account|terminate your account|delete your account/i);
});

test("/terms-of-service: governing-law card invents no jurisdiction, and no arbitration/legal entity anywhere", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /Governing law and jurisdiction will be finalized before production legal approval/i);
  assert.match(text, /is a current placeholder and is not final/i);
  assert.doesNotMatch(text, /\barbitration\b/i);
  assert.doesNotMatch(text, /\bState of [A-Z]|\bcourts of\b|\bLLC\b|\bLtd\b|\bInc\b|\bGmbH\b|incorporated in/i);
});

test("/terms-of-service: changes-to-terms wording promises no email notice and no fake freshness", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /may update these Terms as the website or legal requirements change/i);
  assert.match(text, /Any update date shown changes only after a real update/i);
  assert.doesNotMatch(text, /we will email you|notify you by email/i);
});

test("/terms-of-service: sidebar legal note makes no fully-reviewed-agreement claim", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /These Terms explain the rules for using BrawlRanks/i);
  assert.doesNotMatch(text, /fully reviewed legal agreement|legally binding contract reviewed by/i);
});

test("/terms-of-service: shows no invented dates or legal-approval claims", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /Current Terms of Service/i);
  assert.doesNotMatch(
    text,
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/
  );
  assert.doesNotMatch(text, /Effective date|Last updated/i);
  assert.doesNotMatch(text, /\[LEGAL REVIEW REQUIRED\]/);
  assert.doesNotMatch(text, /approved by counsel|legally approved|legal approval has been|reviewed by our legal team/i);
});

test("/terms-of-service: invents no legal team, address, or phone number", () => {
  const text = renderPage().body.textContent ?? "";
  assert.doesNotMatch(text, /legal department|legal team|support team|our lawyers/i);
  assert.doesNotMatch(text, /postal address|mailing address|P\.?O\.? Box/i);
  assert.doesNotMatch(text, /\+?\d[\d\s().-]{7,}\d/);
  assert.doesNotMatch(text, /respond within \d+|response within \d+/i);
});

test("/terms-of-service: contact banner links to /contact only because that route exists; no unimplemented links", async () => {
  await access("app/contact/page.tsx");
  const doc = renderPage();
  const banner = doc.querySelector("#contact-us");
  assert.ok(banner);
  assert.ok(banner?.querySelector('a[href="/contact"]'), "banner CTA must link to the real /contact route");
  for (const unimplemented of ["/methodology", "/terms", "/tier-list", "/meta", "/brawlers"]) {
    assert.equal(doc.querySelector(`a[href="${unimplemented}"]`), null, `must not link to ${unimplemented}`);
  }
});

test("/terms-of-service: contains no Methodology reference anywhere", async () => {
  assert.doesNotMatch(renderPage().body.textContent ?? "", /methodology/i);
  const source = await readFile("components/terms-of-service/TermsOfServiceContent.tsx", "utf8");
  assert.doesNotMatch(source, /methodology/i);
  const page = await readFile("app/terms-of-service/page.tsx", "utf8");
  assert.doesNotMatch(page, /methodology/i);
});

test("/terms-of-service: uses only local Terms-folder assets — no hotlinked or external images", async () => {
  const page = await readFile("app/terms-of-service/page.tsx", "utf8");
  const content = await readFile("components/terms-of-service/TermsOfServiceContent.tsx", "utf8");
  for (const source of [page, content]) {
    assert.doesNotMatch(source, /https?:\/\/[^\s"']*\.(png|jpg|jpeg|webp|gif|svg)/i);
  }
  assert.match(page, /reference_pages\/Terms of Service\//);
  for (const asset of [
    "gem_red.png",
    "icon_in_game_BrawlersMagnet_1_active.png",
    "icon_knockout_5v5_power_level.png",
    "icon_quest.png",
    "icon_settings.png",
    "icon_skin_category_gym.png",
    "icon_speed.png",
    "image_warning_pop_up_exclamation.png",
    "map_maker_icon.png",
    "tick.png",
    "warning_icon.png",
    "wipeout_icon.png",
    "icon_inbox.png",
  ]) {
    assert.ok(page.includes(asset), `page.tsx must import local asset ${asset}`);
    await access(`reference_pages/Terms of Service/${asset}`);
  }
});

test("/terms-of-service: hides all decorative artwork from assistive technology", () => {
  const doc = renderPage();
  const images = [...doc.querySelectorAll("img")];
  assert.ok(images.length > 0);
  for (const img of images) {
    assert.equal(img.getAttribute("alt"), "");
    assert.equal(img.getAttribute("aria-hidden"), "true");
  }
});

test("/terms-of-service: uses no prohibited icon library or inline SVG", async () => {
  const source = await readFile("components/terms-of-service/TermsOfServiceContent.tsx", "utf8");
  assert.doesNotMatch(source, /lucide|fontawesome|react-icons|<svg/i);
});

test("/terms-of-service: emits unique canonical, Open Graph, Twitter, and robots metadata", async () => {
  const { buildMetadata } = await import("@/lib/seo/metadata");
  const metadata = buildMetadata(TERMS_OF_SERVICE_METADATA);
  assert.equal(metadata.title, "Terms of Service | BrawlRanks");
  assert.equal(metadata.alternates?.canonical, "https://brawlranks.com/terms-of-service");
  assert.deepEqual(metadata.robots, { index: true, follow: true });
  assert.equal(metadata.openGraph?.url, "https://brawlranks.com/terms-of-service");
  assert.ok(metadata.twitter);
  assert.match(metadata.description ?? "", /permitted use, prohibited conduct, intellectual property/i);
  assert.doesNotMatch(metadata.description ?? "", /…$/, "description must fit without truncation");
});
