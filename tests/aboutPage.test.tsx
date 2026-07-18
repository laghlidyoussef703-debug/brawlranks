import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderStatic } from "./testUtils/renderStatic";
import { AboutContent, ABOUT_METADATA, type AboutImageSrcs } from "@/components/about/AboutContent";

process.env.NEXT_PUBLIC_SITE_URL = "https://brawlranks.com";
process.env.APP_ENV = "production";

const FIXTURE_IMAGES: AboutImageSrcs = {
  iconWhatIsBrawlranks: "/local-icon-what-is-brawlranks.png",
  iconWhyWeExist: "/local-icon-why-we-exist.png",
  iconAutomation: "/local-icon-automation.png",
  iconTrust: "/local-icon-trust.png",
  iconUnofficial: "/local-icon-unofficial.png",
  iconQuestion: "/local-icon-question.png",
  bannerCharacter: "/local-banner-character.png",
  decorGem: "/local-decor-gem.png",
  decorEmblem: "/local-decor-emblem.png",
  decorPyramid: "/local-decor-pyramid.png",
};

function renderPage() {
  return renderStatic(<AboutContent images={FIXTURE_IMAGES} />);
}

test("/about: renders one clear h1 and breadcrumb structure", () => {
  const doc = renderPage();
  assert.equal(doc.querySelectorAll("h1").length, 1);
  assert.match(doc.querySelector("h1")?.textContent ?? "", /About BrawlRanks/i);
  assert.ok(doc.querySelector('a[href="/"]'));
  assert.equal(doc.querySelector('[aria-current="page"]')?.textContent, "About");
});

test("/about: renders the six main feature cards as headings, in order", () => {
  const doc = renderPage();
  const headings = [...doc.querySelectorAll(".about-content h2")].map((h) => h.textContent);
  assert.deepEqual(headings.slice(0, 6), [
    "What is BrawlRanks?",
    "Why we exist",
    "Automation & data transparency",
    "Trust & editorial standards",
    "Unofficial fan site",
    "Have a question?",
  ]);
});

test("/about: relies on the global layout header and footer without page-specific duplicates", async () => {
  const source = await readFile("components/about/AboutContent.tsx", "utf8");
  assert.doesNotMatch(source, /TrustPageHeader|TrustPageFooter|<footer/);
  assert.equal(renderPage().querySelector("main"), null);
});

test("/about: states its independent fan-site status and Supercell non-affiliation", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /independent Brawl Stars fan website/i);
  assert.match(text, /not affiliated with, endorsed by, or sponsored by Supercell/i);
  assert.match(text, /not official Supercell rankings/i);
});

test("/about: explains the official API, automated data-driven approach, and sampled-data limitation", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /official Brawl Stars API/i);
  assert.match(text, /automated data pipeline/i);
  assert.match(text, /does not represent every battle played globally/i);
});

test("/about: links each card CTA to its intended destination", () => {
  const doc = renderPage();
  for (const href of ["/editorial-policy", "/disclaimer", "/contact"]) {
    assert.ok(doc.querySelector(`a[href="${href}"]`), `missing link to ${href}`);
  }
  for (const unimplemented of ["/tier-list", "/meta", "/guides", "/builds"]) {
    assert.equal(doc.querySelector(`a[href="${unimplemented}"]`), null, `must not link to ${unimplemented}`);
  }
});

test("/about: hides decorative artwork from assistive technology", () => {
  const artworks = [...renderPage().querySelectorAll('img[aria-hidden="true"]')];
  assert.ok(artworks.length > 0);
  for (const artwork of artworks) {
    assert.equal(artwork.getAttribute("alt"), "");
  }
});

test("/about: uses truthful metadata through the shared helper", async () => {
  const { buildMetadata } = await import("@/lib/seo/metadata");
  const metadata = buildMetadata(ABOUT_METADATA);
  assert.equal(metadata.title, "About BrawlRanks | BrawlRanks");
  assert.equal(metadata.alternates?.canonical, "https://brawlranks.com/about");
  assert.deepEqual(metadata.robots, { index: true, follow: true });
  assert.equal(metadata.openGraph?.url, "https://brawlranks.com/about");
  assert.ok(metadata.twitter);
  assert.match(metadata.description ?? "", /independent fan site/i);
});

test("/about: contains no placeholder/fake language or prohibited icon-library usage", async () => {
  const source = await readFile("components/about/AboutContent.tsx", "utf8");
  assert.doesNotMatch(source, /fixture|placeholder|founder|team member|testimonial|award|user count/i);
  assert.doesNotMatch(source, /lucide|fontawesome|react-icons|<svg|emoji/i);
});
