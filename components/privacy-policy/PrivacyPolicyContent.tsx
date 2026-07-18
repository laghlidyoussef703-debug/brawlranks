import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildArticleJsonLd, buildBreadcrumbListJsonLd } from "@/lib/seo/jsonld";

/**
 * Image sources are passed in as plain strings (set by
 * app/privacy-policy/page.tsx's static PNG imports) rather than imported
 * directly here — a PNG import needs the bundler-level asset loader that
 * Next.js's build provides but the plain tsx test runner does not, matching
 * the sibling DisclaimerContent / EditorialPolicyContent pattern. Every
 * asset lives in reference_pages/Privacy/ and is used locally; no remote
 * image URL is ever referenced.
 */
export interface PrivacyImageSrcs {
  iconAnalytics: string; // icon_achievements_tv.png
  iconCookies: string; // emoji_moba_center.png
  iconDevice: string; // wipeout_icon.png
  iconLogs: string; // icon_modifier_timedeto.png
  iconContact: string; // icon_inbox.png
  iconPublic: string; // icon_leaderboard_demonic.png
  tick: string; // tick.png
  iconRebound: string; // icon_rebound.png
  iconGem: string; // gem_grab_icon.png
  character: string; // barley_maple_barley_001.png
}

/** Real intrinsic pixel dimensions (read from each PNG's IHDR chunk) so next/image reserves layout space without cropping or stretching any asset. */
const DIMS = {
  iconAnalytics: { width: 120, height: 100 },
  iconCookies: { width: 120, height: 120 },
  iconDevice: { width: 500, height: 448 },
  iconLogs: { width: 136, height: 128 },
  iconContact: { width: 136, height: 109 },
  iconPublic: { width: 300, height: 282 },
  tick: { width: 187, height: 171 },
  iconRebound: { width: 130, height: 139 },
  iconGem: { width: 159, height: 171 },
  character: { width: 2106, height: 3435 },
} as const satisfies Record<keyof PrivacyImageSrcs, { width: number; height: number }>;

export const PRIVACY_POLICY_METADATA = {
  title: "Privacy Policy",
  description:
    "Learn what information BrawlRanks processes, how public Brawl Stars data and website information may be used, and the privacy choices available to visitors.",
  pathname: "/privacy-policy",
} as const;

const CARD =
  "relative flex flex-col rounded-[12px] border-2 border-[#081a3d] bg-[linear-gradient(160deg,#123a74_0%,#0c2a5c_55%,#081f47_100%)] shadow-[0_3px_0_#050f2b,0_10px_22px_rgb(0_0_0_/_0.30)]";

const CARD_TITLE =
  "font-display uppercase leading-[1.1] text-white [text-shadow:1.5px_1.5px_0_#03102b,-1px_-1px_0_#03102b,1px_-1px_0_#03102b,-1px_1px_0_#03102b]";

interface Icon {
  src: string;
  width: number;
  height: number;
}

type IconTileTone = "cyan" | "purple" | "gold" | "blue" | "green";

const TILE_TONE: Record<IconTileTone, string> = {
  cyan: "border-[#0a4f7a] bg-[linear-gradient(160deg,#38bdf0,#1173c4)]",
  purple: "border-[#3a1a7a] bg-[linear-gradient(160deg,#9a53e6,#5a25b8)]",
  gold: "border-[#8a5a06] bg-[linear-gradient(160deg,#ffd45c,#f0a91d)]",
  blue: "border-[#0a2a63] bg-[linear-gradient(160deg,#3f8ef0,#1e5fca)]",
  green: "border-[#136b3a] bg-[linear-gradient(160deg,#4bd06a,#1f9d4d)]",
};

function IconTile({ icon, tone, tile, glyph }: { icon: Icon; tone: IconTileTone; tile: number; glyph: number }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-[13px] border-2 shadow-[inset_0_2px_0_rgb(255_255_255_/_0.28),0_3px_0_rgb(0_0_0_/_0.38)] ${TILE_TONE[tone]}`}
      style={{ width: tile, height: tile }}
    >
      <Image
        src={icon.src}
        alt=""
        aria-hidden="true"
        width={icon.width}
        height={icon.height}
        className="max-w-none object-contain drop-shadow-[0_2px_1px_rgb(0_0_0_/_0.4)]"
        style={{ width: glyph, height: "auto" }}
      />
    </span>
  );
}

function Check({ tick, children }: { tick: Icon; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[0.78rem] leading-[1.4] text-[#e4ebf7]">
      <span className="mt-[2px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-[#1f9d4d] bg-[linear-gradient(160deg,#4bd06a,#1f9d4d)] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.35)]">
        <Image src={tick.src} alt="" aria-hidden="true" width={tick.width} height={tick.height} className="h-[9px] w-auto" />
      </span>
      <span>{children}</span>
    </li>
  );
}

/**
 * A truthful, non-interactive label styled like the reference's button
 * strip. Deliberately not a link/button and not keyboard-focusable — it
 * performs no action, because no cookie-consent manager, analytics
 * dashboard, or "full details" route exists to point it at.
 */
function CtaLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mt-auto flex min-h-9 items-center justify-center rounded-[6px] border-2 border-[#37507e] bg-[rgb(8_24_54_/_0.85)] px-2 py-1 text-center font-display text-[0.66rem] uppercase leading-tight tracking-wide text-[#9db4d8]">
      {children}
    </span>
  );
}

/** The 11 in-page sections, matching the reference's numbered sidebar. Every anchor below resolves to a real heading id on the page. */
const SIDEBAR: readonly {
  n: number;
  label: string;
  anchor: string;
  iconKey: keyof PrivacyImageSrcs;
}[] = [
  { n: 1, label: "Information We Collect", anchor: "information-we-collect", iconKey: "iconAnalytics" },
  { n: 2, label: "How We Use Information", anchor: "how-we-use-information", iconKey: "tick" },
  { n: 3, label: "Cookies", anchor: "cookies", iconKey: "iconCookies" },
  { n: 4, label: "Analytics", anchor: "analytics", iconKey: "iconAnalytics" },
  { n: 5, label: "Data Retention", anchor: "data-retention", iconKey: "iconLogs" },
  { n: 6, label: "Data Sharing", anchor: "data-sharing", iconKey: "iconDevice" },
  { n: 7, label: "Data Security", anchor: "data-security", iconKey: "iconRebound" },
  { n: 8, label: "Your Rights", anchor: "your-rights", iconKey: "iconGem" },
  { n: 9, label: "Children’s Privacy", anchor: "childrens-privacy", iconKey: "iconCookies" },
  { n: 10, label: "Policy Updates", anchor: "policy-updates", iconKey: "iconRebound" },
  { n: 11, label: "Contact Us", anchor: "contact-us", iconKey: "iconContact" },
];

interface InfoCard {
  title: string;
  body: string;
  iconKey: keyof PrivacyImageSrcs;
  tone: IconTileTone;
  glyph: number;
}

/**
 * The six "Information We Collect" cards. Every claim is verified against
 * the actual codebase: no third-party analytics provider is wired in
 * (lib/analytics/events.ts is a no-op), no cookies are intentionally set
 * (no document.cookie / Set-Cookie / cookies() anywhere), and the contact
 * form has no backend (components/contact/ContactForm.tsx is mailto-only).
 */
const INFO_CARDS: readonly InfoCard[] = [
  {
    title: "Analytics Data",
    iconKey: "iconAnalytics",
    tone: "cyan",
    glyph: 40,
    body: "BrawlRanks does not currently use a third-party analytics service such as Google Analytics. If that changes, this policy will be updated first.",
  },
  {
    title: "Cookies",
    iconKey: "iconCookies",
    tone: "gold",
    glyph: 40,
    body: "BrawlRanks does not intentionally set tracking or advertising cookies. Only strictly necessary cookies, if any, would support core site functionality.",
  },
  {
    title: "Device & Technical Data",
    iconKey: "iconDevice",
    tone: "blue",
    glyph: 54,
    body: "When you visit, standard technical details such as browser type, device type, and request timestamps may be processed by our hosting infrastructure.",
  },
  {
    title: "Server Logs",
    iconKey: "iconLogs",
    tone: "purple",
    glyph: 40,
    body: "Our hosting provider may automatically record standard server-log data such as IP address, request time, requested path, and user agent to operate and secure the site.",
  },
  {
    title: "Contact Data",
    iconKey: "iconContact",
    tone: "cyan",
    glyph: 44,
    body: "The website itself does not transmit or store contact-form submissions. When you email us, your email provider processes the message you choose to send.",
  },
  {
    title: "Public Game Data",
    iconKey: "iconPublic",
    tone: "green",
    glyph: 48,
    body: "BrawlRanks processes public Brawl Stars game data — such as public player tags, trophies, Brawlers, and battle information — to generate rankings and statistics.",
  },
];

interface PolicyCard {
  n: number;
  anchor: string;
  title: string;
  iconKey: keyof PrivacyImageSrcs;
  tone: IconTileTone;
  glyph: number;
  intro: string;
  checks: readonly string[];
  cta: string;
}

/** The lower five policy cards (sections 2–6). Claims mirror the six info cards' verified behavior — no invented providers, cookies, or retention periods. */
const POLICY_CARDS: readonly PolicyCard[] = [
  {
    n: 2,
    anchor: "how-we-use-information",
    title: "How We Use Information",
    iconKey: "tick",
    tone: "green",
    glyph: 26,
    intro: "We use information only to run and protect BrawlRanks:",
    checks: [
      "Operate and maintain the website",
      "Provide rankings, statistics, and public pages",
      "Improve the visitor experience",
      "Detect abuse and security issues",
      "Respond to emails you send us",
      "Comply with valid legal obligations",
    ],
    cta: "Why We Process Data",
  },
  {
    n: 3,
    anchor: "cookies",
    title: "Cookies",
    iconKey: "iconCookies",
    tone: "gold",
    glyph: 30,
    intro: "BrawlRanks does not intentionally set tracking cookies:",
    checks: ["No advertising cookies", "No third-party tracking cookies", "Only strictly necessary cookies, if any"],
    cta: "Cookie Details",
  },
  {
    n: 4,
    anchor: "analytics",
    title: "Analytics",
    iconKey: "iconAnalytics",
    tone: "cyan",
    glyph: 34,
    intro: "No third-party analytics provider is active on this website:",
    checks: ["No Google Analytics", "No advertising or ad-tech analytics", "No cross-site tracking"],
    cta: "Analytics Details",
  },
  {
    n: 5,
    anchor: "data-retention",
    title: "Data Retention",
    iconKey: "iconLogs",
    tone: "purple",
    glyph: 32,
    intro: "We keep information only as long as reasonably necessary:",
    checks: [
      "The website stores no contact-form messages",
      "Public game data is kept for the ranking pipeline",
      "Providers apply their own retention periods",
    ],
    cta: "Retention Details",
  },
  {
    n: 6,
    anchor: "data-sharing",
    title: "Data Sharing",
    iconKey: "iconDevice",
    tone: "blue",
    glyph: 44,
    intro: "BrawlRanks does not sell personal data:",
    checks: [
      "Hosting and infrastructure providers",
      "Your email provider when you email us",
      "Disclosure when required by law",
    ],
    cta: "Sharing Details",
  },
];

interface DetailSection {
  n: number;
  anchor: string;
  title: string;
  iconKey: keyof PrivacyImageSrcs;
  tone: IconTileTone;
  glyph: number;
  paragraphs: readonly ReactNode[];
}

export function PrivacyPolicyContent({ images }: { images: PrivacyImageSrcs }) {
  const icon = (key: keyof PrivacyImageSrcs): Icon => ({ src: images[key], ...DIMS[key] });
  const breadcrumbItems = [
    { name: "Home", path: "/" },
    { name: "Privacy Policy", path: "/privacy-policy" },
  ];

  /** Sections 7–11 — required privacy content that continues below the reference's visible first viewport, styled to match. */
  const DETAIL_SECTIONS: readonly DetailSection[] = [
    {
      n: 7,
      anchor: "data-security",
      title: "Data Security",
      iconKey: "iconRebound",
      tone: "blue",
      glyph: 30,
      paragraphs: [
        "BrawlRanks uses reasonable technical and organizational safeguards — such as access controls, encrypted transport where applicable, monitoring, and least-privilege practices — to help protect information it handles.",
        "No internet service can guarantee complete security, and we do not claim absolute protection.",
      ],
    },
    {
      n: 8,
      anchor: "your-rights",
      title: "Your Rights",
      iconKey: "iconGem",
      tone: "gold",
      glyph: 34,
      paragraphs: [
        "Depending on your location, you may have rights regarding access, correction, deletion, objection, restriction, or portability of personal information.",
        <>
          To ask a privacy question or make a request, you can reach us at{" "}
          <a
            href="mailto:support@brawlranks.com"
            className="font-semibold text-[#ffd529] underline underline-offset-2 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            support@brawlranks.com
          </a>{" "}
          or through our{" "}
          <Link
            href="/contact"
            className="font-semibold text-[#ffd529] underline underline-offset-2 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            contact page
          </Link>
          . We handle requests where they reasonably apply.
        </>,
      ],
    },
    {
      n: 9,
      anchor: "childrens-privacy",
      title: "Children’s Privacy",
      iconKey: "iconCookies",
      tone: "purple",
      glyph: 32,
      paragraphs: [
        "BrawlRanks is a general-audience fan website. It has no user account registration and is not designed to knowingly collect personal information directly from children.",
        "If a parent or guardian believes personal information was submitted to us, they may contact us and we will address it.",
      ],
    },
    {
      n: 10,
      anchor: "policy-updates",
      title: "Policy Updates",
      iconKey: "iconRebound",
      tone: "cyan",
      glyph: 30,
      paragraphs: [
        "This policy may change when the website's practices or legal requirements change. Material updates will be reflected on this page.",
        "Any date or version shown on this page changes only after a real update — we do not fake freshness.",
      ],
    },
    {
      n: 11,
      anchor: "contact-us",
      title: "Contact Us",
      iconKey: "iconContact",
      tone: "green",
      glyph: 44,
      paragraphs: [
        <>
          Privacy questions can be sent to{" "}
          <a
            href="mailto:support@brawlranks.com"
            className="font-semibold text-[#ffd529] underline underline-offset-2 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            support@brawlranks.com
          </a>{" "}
          or via our{" "}
          <Link
            href="/contact"
            className="font-semibold text-[#ffd529] underline underline-offset-2 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            contact page
          </Link>
          .
        </>,
      ],
    },
  ];

  return (
    <div className="privacy-policy-page min-h-screen bg-[linear-gradient(rgb(11_74_209_/_0.34),rgb(9_58_176_/_0.4)),var(--site-background-image)] bg-cover bg-top">
      <JsonLd data={buildBreadcrumbListJsonLd(breadcrumbItems)} />
      <JsonLd
        data={buildArticleJsonLd({
          headline: "Privacy Policy",
          description: PRIVACY_POLICY_METADATA.description,
          pathname: PRIVACY_POLICY_METADATA.pathname,
        })}
      />

      <div className="mx-auto w-full max-w-[1240px] px-4 pb-8 tablet:px-6">
        {/* ---- Hero ---- */}
        <header className="pt-3 text-center desktop:pt-4">
          <h1 className="mx-auto max-w-[900px] font-display text-[2.55rem] uppercase leading-[0.95] tracking-[-0.01em] text-white [text-shadow:2.5px_2.5px_0_#03102b,-2px_-2px_0_#03102b,2px_-2px_0_#03102b,-2px_2px_0_#03102b,0_8px_16px_rgb(0_0_0_/_0.36)] tablet:text-[3.5rem] desktop:text-[4rem]">
            Privacy Policy
          </h1>
          <p className="mt-2 font-display text-[1.05rem] text-[#ffd529] [text-shadow:1.5px_1.5px_0_#4a3200] tablet:text-[1.3rem]">
            Your privacy matters to us.
          </p>
          <p className="mx-auto mt-3 max-w-[680px] text-[0.83rem] font-semibold leading-[1.5] text-white [text-shadow:0_1px_1px_rgb(0_0_0_/_0.5)] tablet:text-[0.93rem]">
            This Privacy Policy explains what information BrawlRanks processes, why it may be used, how long it may be
            retained, and what choices you have regarding your data.
          </p>
        </header>

        {/* ---- Breadcrumb (compact, centered pill) ---- */}
        <nav aria-label="Breadcrumb" className="flex justify-center pb-4 pt-3">
          <ol className="inline-flex items-center gap-3 rounded-[9px] border-2 border-[#0a234f] bg-[rgb(5_24_60_/_0.92)] px-5 py-2 text-[0.8rem] shadow-[0_3px_0_#050f2b]">
            <li>
              <Link href="/" className="rounded-[4px] font-semibold text-[#e4ebf7] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]">
                Home
              </Link>
            </li>
            <li aria-hidden="true">
              <span className="block h-2 w-2 rotate-45 border-r-2 border-t-2 border-[#6f86ac]" />
            </li>
            <li>
              <span aria-current="page" className="font-semibold text-[#ffd529]">
                Privacy Policy
              </span>
            </li>
          </ol>
        </nav>

        {/* ---- Status strip: no verified effective/updated date exists, so a
             truthful neutral status is shown instead of an invented date. ---- */}
        <div className="mb-5 flex justify-center">
          <p className="inline-flex items-center gap-2.5 rounded-[8px] border-2 border-[#0a234f] bg-[rgb(5_24_60_/_0.85)] px-4 py-2 text-[0.76rem] text-[#c6d4ee] shadow-[0_3px_0_#050f2b]">
            <span aria-hidden="true" className="block h-3.5 w-3.5 rounded-[3px] border-2 border-[#7fa2d8]" />
            Policy version: <span className="font-semibold text-white">Current public draft</span>
          </p>
        </div>

        {/* ---- Two-column: section nav + main content ---- */}
        <div className="grid gap-4 desktop:grid-cols-[224px_1fr] desktop:items-start">
          {/* Left section navigation. Horizontal scroll on mobile/tablet, vertical rail on desktop. */}
          <nav
            aria-label="Privacy policy sections"
            className="flex gap-2 overflow-x-auto pb-1 desktop:flex-col desktop:gap-2 desktop:overflow-visible desktop:pb-0"
          >
            {SIDEBAR.map((item) => {
              const current = item.n === 1;
              return (
                <a
                  key={item.anchor}
                  href={`#${item.anchor}`}
                  aria-current={current ? "true" : undefined}
                  className={`group flex min-w-[188px] shrink-0 items-center gap-2.5 rounded-[10px] border-2 px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] desktop:min-w-0 ${
                    current
                      ? "border-[#8a5a06] bg-[linear-gradient(160deg,#ffd45c,#f0a91d)] shadow-[0_3px_0_#8a5a06]"
                      : "border-[#081a3d] bg-[linear-gradient(160deg,#123a74,#0c2a5c)] shadow-[0_3px_0_#050f2b] hover:brightness-110"
                  }`}
                >
                  {current && <span className="sr-only">Current section: </span>}
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-[7px] border ${
                      current ? "border-[#a9740a] bg-[rgb(255_255_255_/_0.3)]" : "border-[#0a2a63] bg-[rgb(6_25_63_/_0.7)]"
                    }`}
                  >
                    <Image
                      src={images[item.iconKey]}
                      alt=""
                      aria-hidden="true"
                      width={DIMS[item.iconKey].width}
                      height={DIMS[item.iconKey].height}
                      className="h-4 w-auto max-w-none object-contain"
                    />
                  </span>
                  <span
                    className={`font-display text-[0.72rem] uppercase leading-[1.1] ${
                      current ? "text-[#3a2400]" : "text-white"
                    }`}
                  >
                    {item.n}. {item.label}
                  </span>
                </a>
              );
            })}
          </nav>

          {/* Main content panel */}
          <div className="min-w-0">
            {/* ---- Section 1: Information We Collect ---- */}
            <h2
              id="information-we-collect"
              className={`${CARD_TITLE} scroll-mt-24 text-[1.25rem] tablet:text-[1.5rem]`}
            >
              1. Information We Collect
            </h2>

            <div className="mt-3 grid gap-3 tablet:grid-cols-2 desktop:grid-cols-3 wide:grid-cols-6">
              {INFO_CARDS.map((card) => (
                <section key={card.title} className={`${CARD} items-center px-3 py-4 text-center`}>
                  <IconTile icon={icon(card.iconKey)} tone={card.tone} tile={58} glyph={card.glyph} />
                  <h3 className={`${CARD_TITLE} mt-2.5 text-[0.82rem]`}>{card.title}</h3>
                  <p className="mt-2 text-[0.72rem] leading-[1.5] text-[#c6d4ee]">{card.body}</p>
                </section>
              ))}
            </div>

            {/* ---- Safety + Quick Summary row ---- */}
            <div className="mt-4 grid gap-3 desktop:grid-cols-[1.6fr_1fr]">
              <section
                aria-labelledby="privacy-sensitive"
                className={`${CARD} flex-row items-center gap-4 px-5 py-4`}
              >
                {/* Barley character art, contained within the placeholder icon's
                    original h-14 w-12 footprint so the card layout and spacing stay unchanged. */}
                <span className="flex h-14 w-12 shrink-0 items-center justify-center">
                  <Image
                    src={images.character}
                    alt=""
                    aria-hidden="true"
                    width={DIMS.character.width}
                    height={DIMS.character.height}
                    className="h-14 w-auto max-w-none object-contain drop-shadow-[0_2px_1px_rgb(0_0_0_/_0.4)]"
                  />
                </span>
                <div className="min-w-0">
                  <h2 id="privacy-sensitive" className={`${CARD_TITLE} text-[0.86rem]`}>
                    Sensitive Personal Information
                  </h2>
                  <p className="mt-1.5 text-[0.75rem] leading-[1.5] text-[#c6d4ee]">
                    BrawlRanks does not intentionally request passwords, payment-card details, government
                    identification, or other highly sensitive personal information through the public website.
                  </p>
                </div>
              </section>

              <section
                aria-labelledby="privacy-summary"
                className="relative flex flex-col justify-center rounded-[12px] border-2 border-[#3a1a7a] bg-[linear-gradient(150deg,#5a2db4,#331a7e)] px-5 py-4 shadow-[0_3px_0_#1e0d4a,0_10px_22px_rgb(0_0_0_/_0.30)]"
              >
                <h2 id="privacy-summary" className={`${CARD_TITLE} text-[0.86rem]`}>
                  Quick Summary
                </h2>
                <ul className="mt-2 space-y-1.5 text-[0.74rem] leading-[1.4] text-[#ece3ff]">
                  <li>BrawlRanks processes only the information needed to operate, secure, improve, and explain the service.</li>
                  <li>Public Brawl Stars game data is used to create rankings and statistics.</li>
                  <li>BrawlRanks does not sell personal data.</li>
                </ul>
              </section>
            </div>

            {/* ---- Lower policy cards (sections 2–6) ---- */}
            <h2 className="sr-only">Privacy policy details</h2>
            <div className="mt-4 grid gap-3 tablet:grid-cols-2 desktop:grid-cols-3 wide:grid-cols-5">
              {POLICY_CARDS.map((card) => (
                <section key={card.anchor} id={card.anchor} className={`${CARD} scroll-mt-24 p-3.5`}>
                  <div className="flex items-center gap-2.5">
                    <IconTile icon={icon(card.iconKey)} tone={card.tone} tile={44} glyph={card.glyph} />
                    <h2 className={`${CARD_TITLE} text-[0.76rem]`}>
                      {card.n}. {card.title}
                    </h2>
                  </div>
                  <p className="mb-2.5 mt-2.5 border-t border-[#79aaf2]/40 pt-2.5 text-[0.72rem] leading-[1.4] text-[#d7e0f0]">
                    {card.intro}
                  </p>
                  <ul className="mb-3 space-y-1.5">
                    {card.checks.map((check) => (
                      <Check key={check} tick={icon("tick")}>
                        {check}
                      </Check>
                    ))}
                  </ul>
                  <CtaLabel>{card.cta}</CtaLabel>
                </section>
              ))}
            </div>

            {/* ---- Additional required sections (7–11) ---- */}
            <div className="mt-4 grid gap-3 tablet:grid-cols-2 desktop:grid-cols-3">
              {DETAIL_SECTIONS.map((section) => (
                <section key={section.anchor} id={section.anchor} className={`${CARD} scroll-mt-24 p-4`}>
                  <div className="flex items-center gap-2.5">
                    <IconTile icon={icon(section.iconKey)} tone={section.tone} tile={44} glyph={section.glyph} />
                    <h2 className={`${CARD_TITLE} text-[0.82rem]`}>
                      {section.n}. {section.title}
                    </h2>
                  </div>
                  <div className="mt-2.5 space-y-2 border-t border-[#79aaf2]/40 pt-2.5 text-[0.74rem] leading-[1.45] text-[#d7e0f0]">
                    {section.paragraphs.map((paragraph, index) => (
                      <p key={index}>{paragraph}</p>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>

        {/* ---- Transparency banner ---- */}
        <section
          aria-labelledby="privacy-transparency"
          className="relative mt-6 flex flex-col items-center gap-4 overflow-hidden rounded-[12px] border-2 border-[#3a1a7a] bg-[linear-gradient(105deg,#5a2db4,#2a1670)] px-5 py-5 shadow-[0_3px_0_#1e0d4a,0_10px_22px_rgb(0_0_0_/_0.30)] tablet:flex-row tablet:items-center tablet:gap-6"
        >
          <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[13px] border-2 border-[#8a5a06] bg-[linear-gradient(160deg,#ffd45c,#f0a91d)] shadow-[inset_0_2px_0_rgb(255_255_255_/_0.3),0_3px_0_#8a5a06]">
            <Image
              src={images.iconCookies}
              alt=""
              aria-hidden="true"
              width={DIMS.iconCookies.width}
              height={DIMS.iconCookies.height}
              className="h-8 w-auto object-contain"
            />
          </span>
          <div className="flex-1 text-center tablet:text-left">
            <h2 id="privacy-transparency" className={`${CARD_TITLE} text-[1.15rem] tablet:text-[1.4rem]`}>
              Transparency First
            </h2>
            <p className="mt-2 text-[0.8rem] leading-[1.45] text-white tablet:max-w-[620px]">
              We believe in being open and honest about what information is processed and why. If you have any
              questions about your privacy, we&apos;re here to help.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3" aria-hidden="true">
            <Image src={images.iconPublic} alt="" aria-hidden="true" width={DIMS.iconPublic.width} height={DIMS.iconPublic.height} className="h-11 w-11 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]" />
            <Image src={images.iconDevice} alt="" aria-hidden="true" width={DIMS.iconDevice.width} height={DIMS.iconDevice.height} className="h-11 w-11 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]" />
            <Image src={images.iconGem} alt="" aria-hidden="true" width={DIMS.iconGem.width} height={DIMS.iconGem.height} className="h-11 w-11 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]" />
            <Image src={images.iconCookies} alt="" aria-hidden="true" width={DIMS.iconCookies.width} height={DIMS.iconCookies.height} className="h-11 w-11 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]" />
          </div>
        </section>
      </div>
    </div>
  );
}
