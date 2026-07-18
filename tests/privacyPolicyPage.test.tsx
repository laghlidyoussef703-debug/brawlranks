import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { renderStatic } from "./testUtils/renderStatic";
import {
  PrivacyPolicyContent,
  PRIVACY_POLICY_METADATA,
  type PrivacyImageSrcs,
} from "@/components/privacy-policy/PrivacyPolicyContent";

process.env.NEXT_PUBLIC_SITE_URL = "https://brawlranks.com";
process.env.APP_ENV = "production";

const FIXTURE_IMAGES: PrivacyImageSrcs = {
  iconAnalytics: "/local-icon-achievements-tv.png",
  iconCookies: "/local-emoji-moba-center.png",
  iconDevice: "/local-wipeout-icon.png",
  iconLogs: "/local-icon-modifier-timedeto.png",
  iconContact: "/local-icon-inbox.png",
  iconPublic: "/local-icon-leaderboard-demonic.png",
  tick: "/local-tick.png",
  iconRebound: "/local-icon-rebound.png",
  iconGem: "/local-gem-grab-icon.png",
  character: "/local-barley-maple.png",
};

function renderPage() {
  return renderStatic(<PrivacyPolicyContent images={FIXTURE_IMAGES} />);
}

test("/privacy-policy: renders exactly one h1 with the correct title", () => {
  const doc = renderPage();
  assert.equal(doc.querySelectorAll("h1").length, 1);
  assert.equal(doc.querySelector("h1")?.textContent, "Privacy Policy");
});

test("/privacy-policy: renders the yellow subtitle and truthful intro copy", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /Your privacy matters to us\./);
  assert.match(text, /what information BrawlRanks processes/i);
  assert.match(text, /how long it may be\s+retained/i);
});

test("/privacy-policy: renders the centered breadcrumb ending on Privacy Policy", () => {
  const doc = renderPage();
  const breadcrumb = doc.querySelector('nav[aria-label="Breadcrumb"]');
  assert.ok(breadcrumb);
  assert.ok(breadcrumb?.querySelector('a[href="/"]'));
  assert.equal(breadcrumb?.querySelector('[aria-current="page"]')?.textContent, "Privacy Policy");
});

test("/privacy-policy: emits BreadcrumbList and Article JSON-LD with correct canonical", () => {
  const doc = renderPage();
  const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) =>
    JSON.parse(s.textContent ?? "{}")
  );
  const breadcrumb = scripts.find((s) => s["@type"] === "BreadcrumbList");
  const article = scripts.find((s) => s["@type"] === "Article");
  assert.ok(breadcrumb);
  assert.equal(breadcrumb.itemListElement.at(-1)?.item, "https://brawlranks.com/privacy-policy");
  assert.ok(article);
  assert.equal(article.mainEntityOfPage, "https://brawlranks.com/privacy-policy");
  assert.equal(article.headline, "Privacy Policy");
});

test("/privacy-policy: relies on the global layout header/footer without page-specific duplicates", async () => {
  const source = await readFile("components/privacy-policy/PrivacyPolicyContent.tsx", "utf8");
  assert.doesNotMatch(source, /TrustPageHeader|TrustPageFooter|<footer/);
  assert.equal(renderPage().querySelector("main"), null);
  const layout = await readFile("app/layout.tsx", "utf8");
  assert.match(layout, /<Header /);
  assert.match(layout, /<Footer /);
});

test("/privacy-policy: renders the 11-item section navigation with valid same-page anchors", () => {
  const doc = renderPage();
  const nav = doc.querySelector('nav[aria-label="Privacy policy sections"]');
  assert.ok(nav);
  const anchors = [...(nav?.querySelectorAll("a") ?? [])];
  assert.equal(anchors.length, 11);
  // First section is the current one, marked non-color-only via aria-current + sr-only text.
  assert.equal(anchors[0]?.getAttribute("aria-current"), "true");
  assert.match(anchors[0]?.textContent ?? "", /Current section:/);
  // Every sidebar anchor target exists as an element id on the page.
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") ?? "";
    assert.match(href, /^#[a-z-]+$/, `anchor href should be an in-page fragment, got ${href}`);
    const id = href.slice(1);
    assert.ok(doc.getElementById(id), `missing anchor target #${id}`);
  }
});

test("/privacy-policy: includes all required numbered section headings", () => {
  const headings = [...renderPage().querySelectorAll("h2, h3")].map((h) => h.textContent ?? "");
  for (const expected of [
    "1. Information We Collect",
    "2. How We Use Information",
    "3. Cookies",
    "4. Analytics",
    "5. Data Retention",
    "6. Data Sharing",
    "7. Data Security",
    "8. Your Rights",
    "9. Children",
    "10. Policy Updates",
    "11. Contact Us",
  ]) {
    assert.ok(headings.some((h) => h.includes(expected)), `missing heading: ${expected}`);
  }
});

test("/privacy-policy: describes the six information categories and public game data", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /Analytics Data/);
  assert.match(text, /Device & Technical Data/);
  assert.match(text, /Server Logs/);
  assert.match(text, /Contact Data/);
  assert.match(text, /Public Game Data/);
  assert.match(text, /public player tags, trophies, Brawlers, and battle information/i);
  assert.match(text, /generate rankings and statistics/i);
});

test("/privacy-policy: analytics claims match the real no-provider implementation (no fake GA/GA4)", async () => {
  const text = renderPage().body.textContent ?? "";
  // The real project wires NO analytics vendor (lib/analytics/events.ts is a no-op).
  assert.match(text, /does not currently use a third-party analytics service/i);
  assert.match(text, /No Google Analytics/);
  // Must never affirmatively claim it uses Google Analytics / GA4.
  assert.doesNotMatch(text, /We use Google Analytics/i);
  assert.doesNotMatch(text, /Google Analytics 4|\bGA4\b/i);
  // Cross-check against the actual analytics module.
  const analytics = await readFile("lib/analytics/events.ts", "utf8");
  assert.doesNotMatch(analytics, /gtag|googletagmanager|G-[A-Z0-9]{6,}/);
});

test("/privacy-policy: cookie claims match the real no-cookie implementation and add no fake manager", () => {
  const doc = renderPage();
  const text = doc.body.textContent ?? "";
  assert.match(text, /does not intentionally set tracking or advertising cookies/i);
  // No fake "Manage cookies" control — the reference button becomes a non-interactive label.
  assert.doesNotMatch(text, /Manage cookies/i);
  assert.equal(doc.querySelector("button"), null, "no interactive cookie/consent controls exist");
  // The only cookie-related link is the in-page section-nav anchor, never an action control.
  const cookieLinks = [...doc.querySelectorAll('a[href*="cookie"]')];
  assert.ok(cookieLinks.every((a) => (a.getAttribute("href") ?? "").startsWith("#")));
});

test("/privacy-policy: contact-data wording reflects the real mailto/no-backend flow", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /does not transmit or store contact-form submissions/i);
  assert.match(text, /your email provider processes the message/i);
  // Must not claim BrawlRanks stores form data or runs a ticket system.
  assert.doesNotMatch(text, /support[- ]?ticket system|we store your message|stored in our database/i);
});

test("/privacy-policy: retention wording invents no specific periods", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /only as long as reasonably necessary/i);
  assert.match(text, /website stores no contact-form messages/i);
  assert.match(text, /Providers apply their own retention periods/i);
  // None of the reference's sample durations may appear as our own claims.
  assert.doesNotMatch(text, /up to 12 months|up to 26 months|up to 30 days|up to 90 days/i);
  assert.doesNotMatch(text, /\b\d+\s+(?:days|months|years)\b/i);
});

test("/privacy-policy: data-sharing states no data sale and lists only real processor categories", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /does not sell personal data/i);
  assert.match(text, /Hosting and infrastructure providers/i);
  assert.match(text, /Disclosure when required by law/i);
});

test("/privacy-policy: shows no invented dates or legal-approval claims", async () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /Current public draft/i);
  assert.doesNotMatch(
    text,
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/
  );
  assert.doesNotMatch(text, /Effective date|Last updated/i);
  assert.doesNotMatch(text, /\[LEGAL REVIEW REQUIRED\]/);
  assert.doesNotMatch(text, /approved by counsel|legally approved|legal approval|reviewed by our legal team/i);
});

test("/privacy-policy: invents no support team, DPO, postal address, or phone number", () => {
  const text = renderPage().body.textContent ?? "";
  assert.doesNotMatch(text, /Data Protection Officer|\bDPO\b/i);
  assert.doesNotMatch(text, /postal address|mailing address|P\.?O\.? Box/i);
  assert.doesNotMatch(text, /\+?\d[\d\s().-]{7,}\d/); // phone-number shape
  assert.doesNotMatch(text, /response within \d+|respond within \d+ (?:hours|days)/i);
});

test("/privacy-policy: links to /contact only because that route exists, and links no unimplemented routes", async () => {
  await access("app/contact/page.tsx");
  const doc = renderPage();
  assert.ok(doc.querySelector('a[href="/contact"]'), "should link to the real /contact route");
  for (const unimplemented of ["/methodology", "/terms-of-service", "/tier-list", "/meta", "/brawlers"]) {
    assert.equal(doc.querySelector(`a[href="${unimplemented}"]`), null, `must not link to ${unimplemented}`);
  }
});

test("/privacy-policy: contains no Methodology reference anywhere", async () => {
  const text = renderPage().body.textContent ?? "";
  assert.doesNotMatch(text, /methodology/i);
  const source = await readFile("components/privacy-policy/PrivacyPolicyContent.tsx", "utf8");
  assert.doesNotMatch(source, /methodology/i);
  const page = await readFile("app/privacy-policy/page.tsx", "utf8");
  assert.doesNotMatch(page, /methodology/i);
});

test("/privacy-policy: uses only local Privacy-folder assets — no hotlinked or external images", async () => {
  const page = await readFile("app/privacy-policy/page.tsx", "utf8");
  const content = await readFile("components/privacy-policy/PrivacyPolicyContent.tsx", "utf8");
  for (const source of [page, content]) {
    assert.doesNotMatch(source, /https?:\/\/[^\s"']*\.(png|jpg|jpeg|webp|gif|svg)/i);
  }
  assert.match(page, /reference_pages\/Privacy\//);
  for (const asset of [
    "icon_achievements_tv.png",
    "emoji_moba_center.png",
    "wipeout_icon.png",
    "icon_modifier_timedeto.png",
    "icon_inbox.png",
    "icon_leaderboard_demonic.png",
    "tick.png",
    "icon_rebound.png",
    "gem_grab_icon.png",
    "barley_maple_barley_001.png",
  ]) {
    assert.ok(page.includes(asset), `page.tsx must import local asset ${asset}`);
    await access(`reference_pages/Privacy/${asset}`);
  }
});

test("/privacy-policy: hides all decorative artwork from assistive technology", () => {
  const doc = renderPage();
  const images = [...doc.querySelectorAll("img")];
  assert.ok(images.length > 0);
  for (const img of images) {
    assert.equal(img.getAttribute("alt"), "", "every Privacy asset is decorative and must use alt=''");
    assert.equal(img.getAttribute("aria-hidden"), "true");
  }
});

test("/privacy-policy: uses no prohibited icon library or inline SVG", async () => {
  const source = await readFile("components/privacy-policy/PrivacyPolicyContent.tsx", "utf8");
  assert.doesNotMatch(source, /lucide|fontawesome|react-icons|<svg/i);
});

test("/privacy-policy: emits unique canonical, Open Graph, Twitter, and robots metadata", async () => {
  const { buildMetadata } = await import("@/lib/seo/metadata");
  const metadata = buildMetadata(PRIVACY_POLICY_METADATA);
  assert.equal(metadata.title, "Privacy Policy | BrawlRanks");
  assert.equal(metadata.alternates?.canonical, "https://brawlranks.com/privacy-policy");
  assert.deepEqual(metadata.robots, { index: true, follow: true });
  assert.equal(metadata.openGraph?.url, "https://brawlranks.com/privacy-policy");
  assert.ok(metadata.twitter);
  assert.match(metadata.description ?? "", /what information BrawlRanks processes/i);
  assert.doesNotMatch(metadata.description ?? "", /…$/, "description must fit without truncation");
});
