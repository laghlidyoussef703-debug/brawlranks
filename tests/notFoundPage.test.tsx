import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { renderStatic } from "./testUtils/renderStatic";
import { NotFoundContent, type NotFoundImageSrcs } from "@/components/not-found/NotFoundContent";

const FIXTURE_IMAGES: NotFoundImageSrcs = {
  character: "/local-character.png",
  tierList: "/local-tier-list.png",
  brawlers: "/local-brawlers.png",
  gameModes: "/local-game-modes.png",
  guides: "/local-guides.png",
  help: "/local-help.png",
};

function renderPage() {
  return renderStatic(<NotFoundContent images={FIXTURE_IMAGES} />);
}

test("404: renders exactly one h1 that clearly states the page was not found", () => {
  const doc = renderPage();
  assert.equal(doc.querySelectorAll("h1").length, 1);
  const h1 = doc.querySelector("h1")?.textContent ?? "";
  assert.match(h1, /404/);
  assert.match(h1, /We couldn’t find that page|We couldn't find that page/i);
});

test("404: shows the supporting not-found copy", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /this page went missing or the link is broken/i);
});

test("404: relies on the global layout header/footer without page-specific duplicates", async () => {
  const source = await readFile("components/not-found/NotFoundContent.tsx", "utf8");
  assert.doesNotMatch(source, /TrustPageHeader|TrustPageFooter|<footer|<header/);
  assert.equal(renderPage().querySelector("main"), null);
  const layout = await readFile("app/layout.tsx", "utf8");
  assert.match(layout, /<Header /);
  assert.match(layout, /<Footer /);
});

test("404: keeps a visually-present search UI without faking results", () => {
  const doc = renderPage();
  const form = doc.querySelector('form[role="search"]');
  assert.ok(form, "search form should be present");
  assert.ok(form?.querySelector('input[type="search"]'));
  assert.ok(form?.querySelector('button[type="submit"]'));
  // Initial render shows no results and no fabricated result list.
  assert.equal(doc.querySelectorAll('[data-search-result], .search-result').length, 0);
});

test("404: offers a Back to Home CTA and four suggested links to implemented routes", () => {
  const doc = renderPage();
  assert.ok(doc.querySelector('a[href="/"]'), "Back to Home must link to /");
  for (const href of ["/about", "/editorial-policy", "/privacy-policy", "/terms-of-service"]) {
    assert.ok(doc.querySelector(`a[href="${href}"]`), `missing suggested link ${href}`);
  }
  // Support banner contacts the real /contact route.
  assert.ok(doc.querySelector('a[href="/contact"]'));
});

test("404: popular-page cards carry the expected labels", () => {
  const text = renderPage().body.textContent ?? "";
  for (const label of ["About", "Editorial Policy", "Privacy Policy", "Terms of Service", "Popular Pages", "Still Need Help?"]) {
    assert.match(text, new RegExp(label.replace(/[?]/g, "\\?"), "i"));
  }
});

test("404: contains no Methodology reference and no invented routes", () => {
  const doc = renderPage();
  assert.doesNotMatch(doc.body.textContent ?? "", /methodology/i);
  assert.equal(doc.querySelector('a[href="/methodology"]'), null);
  // Every internal link points to an implemented project route.
  const allowed = new Set([
    "/",
    "/contact",
    "/about",
    "/editorial-policy",
    "/privacy-policy",
    "/terms-of-service",
  ]);
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    assert.ok(allowed.has(href), `unexpected link target: ${href}`);
  }
});

test("404: hides all decorative artwork from assistive technology", () => {
  const doc = renderPage();
  const images = [...doc.querySelectorAll("img")];
  assert.ok(images.length > 0);
  for (const img of images) {
    assert.equal(img.getAttribute("alt"), "");
    assert.equal(img.getAttribute("aria-hidden"), "true");
  }
});

test("404: uses no prohibited icon library or inline SVG in the content component", async () => {
  const source = await readFile("components/not-found/NotFoundContent.tsx", "utf8");
  assert.doesNotMatch(source, /lucide|fontawesome|react-icons|<svg/i);
});

test("404: route file imports only local reference_pages/404 assets and sets a noindex title", async () => {
  const page = await readFile("app/not-found.tsx", "utf8");
  assert.doesNotMatch(page, /https?:\/\/[^\s"']*\.(png|jpg|jpeg|webp|gif|svg)/i);
  assert.match(page, /reference_pages\/404\//);
  assert.match(page, /Page Not Found \| BrawlRanks/);
  assert.match(page, /index:\s*false/);
  for (const asset of [
    "character.png",
    "icon_skin_cursed.png",
    "icon_in_game_BrawlersMagnet_1_active.png",
    "htt_summer_game_mode_icons_800x800.png",
    "icon_map_info.png",
    "showdown_icon.png",
  ]) {
    assert.ok(page.includes(asset), `not-found.tsx must import local asset ${asset}`);
    await access(`reference_pages/404/${asset}`);
  }
});
