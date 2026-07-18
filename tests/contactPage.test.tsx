/**
 * /contact — static structure/content tests (renderStatic) plus the one
 * set of tests needing real DOM interactivity (form validation and the
 * honest no-backend submission behavior), following the mobileNav.test
 * domEnv pattern. Each node:test file runs in its own process, so
 * installing jsdom globals here affects no other test file.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installDomEnv } from "./testUtils/domEnv";

installDomEnv();

process.env.NEXT_PUBLIC_SITE_URL = "https://brawlranks.com";
process.env.APP_ENV = "production";

// Dynamically loaded (inside before()) after jsdom globals are installed.
let React: any;
let createRoot: any;
let act: any;
let renderStatic: any;
let ContactContent: any;
let CONTACT_METADATA: any;
let ContactForm: any;
let CONTACT_CATEGORIES: any;

const FIXTURE_IMAGES = {
  iconInbox: "/local-icon-inbox.png",
  iconCalendar: "/local-icon-calendar.png",
  iconWarning: "/local-icon-warning.png",
  iconTick: "/local-icon-tick.png",
  iconSilentRed: "/local-icon-silent-red.png",
  iconHunters: "/local-icon-hunters.png",
  iconSettings: "/local-icon-settings.png",
  iconPinBattle: "/local-icon-pin-battle.png",
  character: "/local-character.png",
  gemGrab: "/local-gem-grab.png",
  gemRed: "/local-gem-red.png",
};

before(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ renderStatic } = await import("./testUtils/renderStatic"));
  ({ ContactContent, CONTACT_METADATA } = await import("@/components/contact/ContactContent"));
  ({ ContactForm, CONTACT_CATEGORIES } = await import("@/components/contact/ContactForm"));
});

function renderPage() {
  return renderStatic(React.createElement(ContactContent, { images: FIXTURE_IMAGES }));
}

test("/contact: renders one clear h1 and the centered breadcrumb structure", () => {
  const doc = renderPage();
  assert.equal(doc.querySelectorAll("h1").length, 1);
  assert.match(doc.querySelector("h1")?.textContent ?? "", /Contact BrawlRanks/i);
  const breadcrumb = doc.querySelector('nav[aria-label="Breadcrumb"]');
  assert.ok(breadcrumb);
  assert.ok(breadcrumb?.querySelector('a[href="/"]'));
  assert.equal(breadcrumb?.querySelector('[aria-current="page"]')?.textContent, "Contact");
});

test("/contact: relies on the global layout header and footer without page-specific duplicates", async () => {
  const source = await readFile("components/contact/ContactContent.tsx", "utf8");
  assert.doesNotMatch(source, /TrustPageHeader|TrustPageFooter|<footer/);
  assert.equal(renderPage().querySelector("main"), null);
  const layout = await readFile("app/layout.tsx", "utf8");
  assert.match(layout, /<Header /);
  assert.match(layout, /<Footer /);
});

test("/contact: every form field has a visible, associated label (never placeholder-only)", () => {
  const doc = renderPage();
  for (const labelText of ["Your Name", "Your Email", "Category", "Message", "Your Website"]) {
    const label = [...doc.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes(labelText));
    assert.ok(label, `missing label: ${labelText}`);
    const forId = label!.getAttribute("for");
    assert.ok(forId, `label ${labelText} has no htmlFor`);
    assert.ok(doc.getElementById(forId!), `label ${labelText} points to a missing field`);
  }
});

test("/contact: the category select offers exactly the six truthful categories", () => {
  const doc = renderPage();
  const options = [...doc.querySelectorAll("select option")]
    .map((o) => o.textContent)
    .filter((t) => t !== "Select a category");
  assert.deepEqual(options, [
    "Report wrong data",
    "Suggest a correction",
    "Copyright request",
    "Partnership inquiry",
    "Technical issue",
    "General inquiry",
  ]);
  assert.equal(CONTACT_CATEGORIES.length, 6);
});

test("/contact: displays the verified support email as a real mailto link, never an invented address", () => {
  const doc = renderPage();
  assert.ok(doc.querySelector('a[href="mailto:support@brawlranks.com"]'));
  const mailtos = [...doc.querySelectorAll('a[href^="mailto:"]')];
  for (const link of mailtos) {
    assert.match(link.getAttribute("href") ?? "", /^mailto:support@brawlranks\.com/);
  }
});

test("/contact: renders the six contact-category rows from the reference", () => {
  const text = renderPage().body.textContent ?? "";
  for (const title of [
    "Report wrong data",
    "Suggest correction",
    "Copyright request",
    "Partnership",
    "Technical issue",
    "General inquiry",
  ]) {
    assert.ok(text.includes(title), `missing category row: ${title}`);
  }
  assert.match(text, /What can you contact us about\?/i);
});

test("/contact: privacy notice renders without linking to the unimplemented /privacy-policy route", () => {
  const doc = renderPage();
  assert.match(doc.body.textContent ?? "", /BrawlRanks may use your details to respond to your request/i);
  for (const unimplemented of ["/privacy-policy", "/terms-of-service", "/tier-list", "/meta"]) {
    assert.equal(doc.querySelector(`a[href="${unimplemented}"]`), null, `must not link to ${unimplemented}`);
  }
});

test("/contact: hides decorative artwork from assistive technology", () => {
  const artworks = [...renderPage().querySelectorAll('img[aria-hidden="true"]')];
  assert.ok(artworks.length > 0);
  for (const artwork of artworks) {
    assert.equal(artwork.getAttribute("alt"), "");
  }
});

test("/contact: uses only local assets — no hotlinked or external images", async () => {
  const page = await readFile("app/contact/page.tsx", "utf8");
  const content = await readFile("components/contact/ContactContent.tsx", "utf8");
  const form = await readFile("components/contact/ContactForm.tsx", "utf8");
  for (const source of [page, content, form]) {
    assert.doesNotMatch(source, /https?:\/\/[^\s"']*\.(png|jpg|jpeg|webp|gif|svg)/i);
  }
  assert.match(page, /reference_pages\/contact\//);
  for (const filename of [
    "barley_maple_barley_001.png",
    "gem_grab_icon.png",
    "gem_red.png",
    "icon_calendar_league_day.png",
    "icon_hunters.png",
    "icon_inbox.png",
    "icon_settings.png",
    "img_silent_red.png",
    "pin_battle_button.png",
    "tick.png",
    "warning_icon.png",
  ]) {
    assert.ok(page.includes(filename), `missing exact Contact asset import: ${filename}`);
  }
});

test("/contact: uses truthful metadata through the shared helper", async () => {
  const { buildMetadata } = await import("@/lib/seo/metadata");
  const metadata = buildMetadata(CONTACT_METADATA);
  assert.equal(metadata.title, "Contact BrawlRanks | BrawlRanks");
  assert.equal(metadata.alternates?.canonical, "https://brawlranks.com/contact");
  assert.deepEqual(metadata.robots, { index: true, follow: true });
  assert.equal(metadata.openGraph?.url, "https://brawlranks.com/contact");
  assert.ok(metadata.twitter);
  assert.match(metadata.description ?? "", /report incorrect Brawl Stars data/i);
});

test("/contact: form source contains no fake backend, fake success claim, or invented guarantees", async () => {
  const form = await readFile("components/contact/ContactForm.tsx", "utf8");
  assert.doesNotMatch(form, /fetch\(|axios|XMLHttpRequest|\/api\/contact/);
  assert.doesNotMatch(form, /message sent|sent successfully|we'?ll get back to you within|24 hours/i);
  assert.match(form, /was not sent/i);
  assert.match(form, /still being prepared/i);
});

test("/contact form: submitting empty fields shows accessible inline validation, not a submission", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ContactForm, { inboxIconSrc: "/i.png", calendarIconSrc: "/c.png" })
    );
  });

  const form = container.querySelector("form") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });

  const text = container.textContent ?? "";
  assert.match(text, /Please enter your name/i);
  assert.match(text, /Please enter a valid email address/i);
  assert.match(text, /Please select a category/i);
  assert.match(text, /Please describe your request/i);
  assert.doesNotMatch(text, /was not sent/i, "the not-sent notice must only appear for a valid submission");

  const invalidInputs = container.querySelectorAll('[aria-invalid="true"]');
  assert.ok(invalidInputs.length >= 4);
  for (const field of invalidInputs) {
    const describedBy = field.getAttribute("aria-describedby");
    assert.ok(describedBy, "invalid field missing aria-describedby");
    assert.ok(
      describedBy!.split(" ").some((id) => container.querySelector(`[id="${id}"]`)),
      "aria-describedby points at no rendered element"
    );
  }

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("/contact form: a valid submission never fakes success — it shows the honest not-sent notice with the support email", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ContactForm, { inboxIconSrc: "/i.png", calendarIconSrc: "/c.png" })
    );
  });

  const setInput = async (element: Element, value: string, proto: any, eventType: string) => {
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    await act(async () => {
      setter.call(element, value);
      element.dispatchEvent(new window.Event(eventType, { bubbles: true }));
    });
  };

  const inputs = [...container.querySelectorAll('input[type="text"], input[type="email"]')];
  const nameInput = inputs.find((i) => i.getAttribute("name") === "name")!;
  const emailInput = container.querySelector('input[name="email"]')!;
  const websiteInput = container.querySelector('input[name="website"]')!;
  const select = container.querySelector("select")!;
  const textarea = container.querySelector("textarea")!;

  const message = "One Brawler's tier looks wrong on the tier list page.";
  await setInput(nameInput, "Test Player", window.HTMLInputElement.prototype, "input");
  await setInput(emailInput, "player@example.com", window.HTMLInputElement.prototype, "input");
  await setInput(select, "Report wrong data", window.HTMLSelectElement.prototype, "change");
  await setInput(textarea, message, window.HTMLTextAreaElement.prototype, "input");

  // Accessible character counter reflects the typed message length.
  assert.ok((container.textContent ?? "").includes(`${message.length}/2000`));

  const form = container.querySelector("form") as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });

  const status = container.querySelector('[role="status"]');
  assert.ok(status);
  assert.match(status?.textContent ?? "", /was not sent/i);
  assert.match(status?.textContent ?? "", /still being prepared/i);
  assert.ok(status?.querySelector('a[href^="mailto:support@brawlranks.com"]'));
  assert.doesNotMatch(container.textContent ?? "", /sent successfully|thanks for your message/i);

  // Honeypot: a non-empty website value must fail validation instead.
  await setInput(websiteInput, "https://spam.example", window.HTMLInputElement.prototype, "input");
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.match(container.textContent ?? "", /Please leave this field blank/i);
  assert.doesNotMatch(container.querySelector('[role="status"]')?.textContent ?? "", /was not sent/i);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
