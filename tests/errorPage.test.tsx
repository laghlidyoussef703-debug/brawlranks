import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { renderStatic } from "./testUtils/renderStatic";
import { ErrorContent, type ErrorImageSrcs } from "@/components/error/ErrorContent";

const FIXTURE_IMAGES: ErrorImageSrcs = {
  character: "/local-character.png",
  tierList: "/local-tier-list.png",
  brawlers: "/local-brawlers.png",
  gameModes: "/local-game-modes.png",
  guides: "/local-guides.png",
  help: "/local-help.png",
};

function renderPage() {
  return renderStatic(<ErrorContent images={FIXTURE_IMAGES} onRetry={() => {}} />);
}

test("error: renders exactly one h1 stating a server error occurred", () => {
  const doc = renderPage();
  assert.equal(doc.querySelectorAll("h1").length, 1);
  const h1 = doc.querySelector("h1")?.textContent ?? "";
  assert.match(h1, /500/);
  assert.match(h1, /Something went wrong/i);
});

test("error: communicates a temporary problem, not a not-found state", () => {
  const text = renderPage().body.textContent ?? "";
  assert.match(text, /We couldn’t load this page right now|We couldn't load this page right now/i);
  assert.match(text, /Please try again in a few moments/i);
  // Must not read like a 404.
  assert.doesNotMatch(text, /couldn’t find that page|couldn't find that page|page not found/i);
});

test("error: offers an honest Try Again action wired to a retry callback", () => {
  const doc = renderPage();
  const retry = [...doc.querySelectorAll("button")].find((b) => /try again/i.test(b.textContent ?? ""));
  assert.ok(retry, "a Try Again button must exist");
  assert.equal(retry?.getAttribute("type"), "button");
});

test("error: offers Back to Home plus four links to implemented routes", () => {
  const doc = renderPage();
  assert.ok(doc.querySelector('a[href="/"]'), "Back to Home must link to /");
  for (const href of ["/about", "/editorial-policy", "/privacy-policy", "/terms-of-service"]) {
    assert.ok(doc.querySelector(`a[href="${href}"]`), `missing suggested link ${href}`);
  }
  assert.ok(doc.querySelector('a[href="/contact"]'), "help banner must link to /contact");
});

test("error: shows the popular-pages panel and help banner headings", () => {
  const text = renderPage().body.textContent ?? "";
  for (const label of ["Still Looking for Something?", "Need More Help?", "About", "Terms of Service"]) {
    assert.match(text, new RegExp(label.replace(/[?]/g, "\\?"), "i"));
  }
});

test("error: contains no Methodology reference and only known internal links", () => {
  const doc = renderPage();
  assert.doesNotMatch(doc.body.textContent ?? "", /methodology/i);
  const allowed = new Set(["/", "/contact", "/about", "/editorial-policy", "/privacy-policy", "/terms-of-service"]);
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    assert.ok(allowed.has(href), `unexpected link target: ${href}`);
  }
});

test("error: makes no fake support-team or response-time promise", () => {
  const text = renderPage().body.textContent ?? "";
  assert.doesNotMatch(text, /our team will|as soon as possible|response within|within \d+ (?:hours|days)/i);
});

test("error: hides all decorative artwork from assistive technology", () => {
  const doc = renderPage();
  const images = [...doc.querySelectorAll("img")];
  assert.ok(images.length > 0);
  for (const img of images) {
    assert.equal(img.getAttribute("alt"), "");
    assert.equal(img.getAttribute("aria-hidden"), "true");
  }
});

test("error: uses no prohibited icon library or inline SVG in the content component", async () => {
  const source = await readFile("components/error/ErrorContent.tsx", "utf8");
  assert.doesNotMatch(source, /lucide|fontawesome|react-icons|<svg/i);
});

test("error: boundary is a client component that logs but never renders the error detail", async () => {
  const boundary = await readFile("app/error.tsx", "utf8");
  assert.match(boundary, /^"use client";/);
  assert.match(boundary, /reset/);
  assert.match(boundary, /console\.error\(error\)/);
  // The raw error must never be placed into the rendered UI.
  assert.doesNotMatch(boundary, /\{error\.message\}|\{error\.stack\}|\{error\.digest\}/);
  const content = await readFile("components/error/ErrorContent.tsx", "utf8");
  assert.doesNotMatch(content, /error\.message|error\.stack|error\.digest/);
});

test("error: boundary imports only local reference_pages/Error assets", async () => {
  const boundary = await readFile("app/error.tsx", "utf8");
  assert.doesNotMatch(boundary, /https?:\/\/[^\s"']*\.(png|jpg|jpeg|webp|gif|svg)/i);
  assert.match(boundary, /reference_pages\/Error\//);
  for (const asset of [
    "error1.png",
    "icon_skin_cursed.png",
    "icon_in_game_BrawlersMagnet_1_active.png",
    "htt_summer_game_mode_icons_800x800.png",
    "icon_map_info.png",
    "showdown_icon.png",
  ]) {
    assert.ok(boundary.includes(asset), `error.tsx must import local asset ${asset}`);
    await access(`reference_pages/Error/${asset}`);
  }
});

test("error: content component relies on the global layout header/footer without duplicates", async () => {
  const source = await readFile("components/error/ErrorContent.tsx", "utf8");
  assert.doesNotMatch(source, /TrustPageHeader|TrustPageFooter|<footer|<header/);
  assert.equal(renderPage().querySelector("main"), null);
});
