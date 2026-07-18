import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildBreadcrumbListJsonLd } from "@/lib/seo/jsonld";

/**
 * Image sources are passed in as plain strings (set by
 * app/terms-of-service/page.tsx's static PNG imports) rather than imported
 * directly here — a PNG import needs the bundler-level asset loader that
 * Next.js's build provides but the plain tsx test runner does not, matching
 * the sibling Disclaimer / Privacy / Editorial content components. Every
 * asset lives in "reference_pages/Terms of Service/" and is used locally;
 * no remote image URL is ever referenced.
 */
export interface TermsImageSrcs {
  iconQuest: string; // icon_quest.png
  tick: string; // tick.png
  warningIcon: string; // warning_icon.png
  iconMagnet: string; // icon_in_game_BrawlersMagnet_1_active.png
  wipeoutIcon: string; // wipeout_icon.png
  warningExclamation: string; // image_warning_pop_up_exclamation.png
  iconGym: string; // icon_skin_category_gym.png
  iconSpeed: string; // icon_speed.png
  iconSettings: string; // icon_settings.png
  iconKnockout: string; // icon_knockout_5v5_power_level.png
  mapMaker: string; // map_maker_icon.png
  gemRed: string; // gem_red.png
  iconInbox: string; // icon_inbox.png (contact banner)
}

/** Real intrinsic pixel dimensions (read from each PNG's IHDR chunk) so next/image reserves layout space without cropping or stretching any asset. */
const DIMS = {
  iconQuest: { width: 146, height: 197 },
  tick: { width: 187, height: 171 },
  warningIcon: { width: 300, height: 300 },
  iconMagnet: { width: 110, height: 113 },
  wipeoutIcon: { width: 500, height: 448 },
  warningExclamation: { width: 65, height: 174 },
  iconGym: { width: 550, height: 550 },
  iconSpeed: { width: 100, height: 106 },
  iconSettings: { width: 128, height: 138 },
  iconKnockout: { width: 70, height: 64 },
  mapMaker: { width: 1850, height: 1753 },
  gemRed: { width: 96, height: 109 },
  iconInbox: { width: 136, height: 109 },
} as const satisfies Record<keyof TermsImageSrcs, { width: number; height: number }>;

export const TERMS_OF_SERVICE_METADATA = {
  title: "Terms of Service",
  description:
    "Read the BrawlRanks Terms of Service covering permitted use, prohibited conduct, intellectual property, disclaimers, external links, and service changes.",
  pathname: "/terms-of-service",
} as const;

const CARD =
  "relative flex flex-col rounded-[12px] border-2 border-[#081a3d] bg-[linear-gradient(160deg,#123a74_0%,#0c2a5c_55%,#081f47_100%)] shadow-[0_3px_0_#050f2b,0_10px_22px_rgb(0_0_0_/_0.30)]";

const CARD_TITLE =
  "font-display uppercase leading-[1.1] text-white [text-shadow:1.5px_1.5px_0_#03102b,-1px_-1px_0_#03102b,1px_-1px_0_#03102b,-1px_1px_0_#03102b]";

type Tone = "cyan" | "green" | "red" | "gold" | "purple" | "blue" | "slate";

const TILE_TONE: Record<Tone, string> = {
  cyan: "border-[#0a4f7a] bg-[linear-gradient(160deg,#38bdf0,#1173c4)]",
  green: "border-[#136b3a] bg-[linear-gradient(160deg,#4bd06a,#1f9d4d)]",
  red: "border-[#7a1520] bg-[linear-gradient(160deg,#ff5a5f,#c62330)]",
  gold: "border-[#8a5a06] bg-[linear-gradient(160deg,#ffd45c,#f0a91d)]",
  purple: "border-[#3a1a7a] bg-[linear-gradient(160deg,#9a53e6,#5a25b8)]",
  blue: "border-[#0a2a63] bg-[linear-gradient(160deg,#3f8ef0,#1e5fca)]",
  slate: "border-[#2a3654] bg-[linear-gradient(160deg,#6b7a97,#3c4763)]",
};

interface Icon {
  src: string;
  width: number;
  height: number;
}

/**
 * Contains an icon of any aspect ratio inside a square tile: the image is
 * bounded by a `glyph`×`glyph` box and object-contain preserves its ratio,
 * so tall/narrow assets (the exclamation mark) and wide ones alike land at
 * a consistent visual scale without per-asset tuning.
 */
function IconTile({ icon, tone, tile, glyph }: { icon: Icon; tone: Tone; tile: number; glyph: number }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-[12px] border-2 shadow-[inset_0_2px_0_rgb(255_255_255_/_0.28),0_3px_0_rgb(0_0_0_/_0.38)] ${TILE_TONE[tone]}`}
      style={{ width: tile, height: tile }}
    >
      <Image
        src={icon.src}
        alt=""
        aria-hidden="true"
        width={icon.width}
        height={icon.height}
        className="object-contain drop-shadow-[0_2px_1px_rgb(0_0_0_/_0.4)]"
        style={{ maxWidth: glyph, maxHeight: glyph, width: "auto", height: "auto" }}
      />
    </span>
  );
}

interface TermsCard {
  n: number;
  anchor: string;
  title: string;
  iconKey: keyof TermsImageSrcs;
  tone: Tone;
  glyph: number;
  body: ReactNode;
}

/**
 * The twelve legal cards, in the spec Section 17.26 order. Every claim is
 * verified against the actual project: the public site has no user
 * accounts, no stored form submissions (the contact page is mailto-only),
 * no confirmed governing-law jurisdiction (spec §52 — TBD), and no
 * effective/last-updated date has been approved. Card 13 (Contact) is the
 * bottom banner, not a grid card.
 */
const CARDS: readonly TermsCard[] = [
  {
    n: 1,
    anchor: "acceptance-of-terms",
    title: "Acceptance of Terms",
    iconKey: "iconQuest",
    tone: "cyan",
    glyph: 30,
    body: "By accessing or using BrawlRanks, you agree to be bound by these Terms of Service. If you do not agree, please do not use the website. These Terms apply to your use of the public BrawlRanks website, which has no user accounts or registration.",
  },
  {
    n: 2,
    anchor: "permitted-use",
    title: "Permitted Use",
    iconKey: "tick",
    tone: "green",
    glyph: 28,
    body: "You may use BrawlRanks for lawful, personal, and informational purposes — such as viewing rankings, browsing Brawler information, reading guides, comparing builds, and accessing public pages.",
  },
  {
    n: 3,
    anchor: "prohibited-use",
    title: "Prohibited Use",
    iconKey: "warningIcon",
    tone: "red",
    glyph: 30,
    body: "You must not use BrawlRanks unlawfully; attempt to disrupt, damage, or gain unauthorized access to it; introduce malicious code; impersonate others; or misuse content. Automated access that violates robots rules, bypasses controls, or creates unreasonable load is prohibited.",
  },
  {
    n: 4,
    anchor: "intellectual-property",
    title: "Intellectual Property",
    iconKey: "iconMagnet",
    tone: "blue",
    glyph: 30,
    body: (
      <>
        BrawlRanks branding, layout, original text, and original analysis belong to BrawlRanks or its licensors. Brawl
        Stars, Supercell, characters, logos, artwork, and trademarks belong to their respective rights holders.
        BrawlRanks is an independent fan site, and use of official assets does not imply endorsement. See our{" "}
        <Link
          href="/disclaimer"
          className="font-semibold text-[#ffd529] underline underline-offset-2 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        >
          Disclaimer
        </Link>{" "}
        for more.
      </>
    ),
  },
  {
    n: 5,
    anchor: "user-submissions",
    title: "User Submissions",
    iconKey: "wipeoutIcon",
    tone: "cyan",
    glyph: 34,
    body: "BrawlRanks does not currently store website form submissions, reviews, comments, or uploaded content. If you choose to email us, your message should not contain unlawful, abusive, or infringing material. Any future interactive features may carry additional terms introduced at that time.",
  },
  {
    n: 6,
    anchor: "disclaimer-of-warranties",
    title: "Disclaimer of Warranties",
    iconKey: "warningExclamation",
    tone: "gold",
    glyph: 34,
    body: 'BrawlRanks is provided on an "as is" and "as available" basis. Rankings, statistics, builds, counters, and guides are informational, and — to the extent permitted by applicable law — we do not guarantee their accuracy, completeness, freshness, availability, or fitness for a particular purpose. Gameplay outcomes are not guaranteed, and upstream API availability may affect content.',
  },
  {
    n: 7,
    anchor: "limitation-of-liability",
    title: "Limitation of Liability",
    iconKey: "iconGym",
    tone: "purple",
    glyph: 34,
    body: "To the extent permitted by applicable law, BrawlRanks is not responsible for indirect or consequential losses arising from reliance on the site. You remain responsible for how you use the information provided. Nothing in these Terms excludes liability that cannot legally be excluded.",
  },
  {
    n: 8,
    anchor: "external-links",
    title: "External Links",
    iconKey: "iconSpeed",
    tone: "cyan",
    glyph: 28,
    body: "BrawlRanks may link to third-party websites that have their own content, terms, privacy practices, and security. We do not control those websites, and including a link does not necessarily imply endorsement.",
  },
  {
    n: 9,
    anchor: "service-changes",
    title: "Service Changes",
    iconKey: "iconSettings",
    tone: "slate",
    glyph: 30,
    body: "BrawlRanks may modify, add, remove, suspend, or discontinue features at any time. Rankings and content may change as data and game conditions change, and service availability is not guaranteed. Reasonable notice may be provided where practical, but is not guaranteed.",
  },
  {
    n: 10,
    anchor: "termination",
    title: "Termination",
    iconKey: "iconKnockout",
    tone: "red",
    glyph: 30,
    body: "BrawlRanks may restrict or block access where reasonably necessary to address abuse, security threats, unlawful activity, or violations of these Terms. The public website has no user accounts to suspend.",
  },
  {
    n: 11,
    anchor: "governing-law",
    title: "Governing Law",
    iconKey: "mapMaker",
    tone: "gold",
    glyph: 34,
    body: "Governing law and jurisdiction will be finalized before production legal approval. This section is a current placeholder and is not final.",
  },
  {
    n: 12,
    anchor: "changes-to-these-terms",
    title: "Changes to These Terms",
    iconKey: "iconKnockout",
    tone: "gold",
    glyph: 30,
    body: "We may update these Terms as the website or legal requirements change. Any update date shown changes only after a real update, and material changes may be highlighted on this page. Continued use after an update may indicate acceptance where legally permitted.",
  },
];

/** Sidebar rows: the twelve cards plus the Contact Us banner (#13). Every anchor resolves to a real element id on the page. */
const SIDEBAR: readonly { n: number; label: string; anchor: string; iconKey: keyof TermsImageSrcs }[] = [
  ...CARDS.map((c) => ({ n: c.n, label: c.title, anchor: c.anchor, iconKey: c.iconKey })),
  { n: 13, label: "Contact Us", anchor: "contact-us", iconKey: "iconQuest" },
];

export function TermsOfServiceContent({ images }: { images: TermsImageSrcs }) {
  const icon = (key: keyof TermsImageSrcs): Icon => ({ src: images[key], ...DIMS[key] });
  const breadcrumbItems = [
    { name: "Home", path: "/" },
    { name: "Terms of Service", path: "/terms-of-service" },
  ];

  return (
    <div className="terms-of-service-page min-h-screen bg-[linear-gradient(rgb(11_74_209_/_0.34),rgb(9_58_176_/_0.4)),var(--site-background-image)] bg-cover bg-top">
      <JsonLd data={buildBreadcrumbListJsonLd(breadcrumbItems)} />

      <div className="mx-auto w-full max-w-[1240px] px-4 pb-8 tablet:px-6">
        {/* ---- Hero ---- */}
        <header className="pt-3 text-center desktop:pt-4">
          <h1 className="mx-auto max-w-[960px] font-display text-[2.5rem] uppercase leading-[0.95] tracking-[-0.01em] text-white [text-shadow:2.5px_2.5px_0_#03102b,-2px_-2px_0_#03102b,2px_-2px_0_#03102b,-2px_2px_0_#03102b,0_8px_16px_rgb(0_0_0_/_0.36)] tablet:text-[3.5rem] desktop:text-[4rem]">
            Terms of Service
          </h1>
          <p className="mt-2 font-display text-[1.05rem] text-[#ffd529] [text-shadow:1.5px_1.5px_0_#4a3200] tablet:text-[1.3rem]">
            Please read these terms carefully.
          </p>
          <p className="mx-auto mt-3 max-w-[700px] text-[0.83rem] font-semibold leading-[1.5] text-white [text-shadow:0_1px_1px_rgb(0_0_0_/_0.5)] tablet:text-[0.93rem]">
            By accessing or using BrawlRanks, you agree to be bound by these Terms of Service. If you do not agree,
            please do not use our website.
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
                Terms of Service
              </span>
            </li>
          </ol>
        </nav>

        {/* ---- Status strip: no verified effective/updated date exists (spec §17.26
             marks this page draft, pending legal review), so a truthful neutral
             label is shown instead of an invented date. ---- */}
        <div className="mb-5 flex justify-center">
          <p className="inline-flex items-center gap-2.5 rounded-[8px] border-2 border-[#0a234f] bg-[rgb(5_24_60_/_0.85)] px-4 py-2 text-[0.76rem] text-[#c6d4ee] shadow-[0_3px_0_#050f2b]">
            <span aria-hidden="true" className="block h-3.5 w-3.5 rounded-[3px] border-2 border-[#7fa2d8]" />
            <span className="font-semibold text-white">Current Terms of Service</span>
          </p>
        </div>

        {/* ---- Two-column: On This Page nav + legal-card grid ---- */}
        <div className="grid gap-4 desktop:grid-cols-[244px_1fr] desktop:items-start">
          <div className="min-w-0">
            <nav
              aria-label="On this page"
              className="flex gap-2 overflow-x-auto pb-1 desktop:flex-col desktop:gap-2 desktop:overflow-visible desktop:pb-0"
            >
              <h2 className="sr-only desktop:not-sr-only desktop:mb-1 desktop:px-1 desktop:font-display desktop:text-[0.78rem] desktop:uppercase desktop:tracking-wide desktop:text-[#9db4d8]">
                On This Page
              </h2>
              {SIDEBAR.map((item) => {
                const current = item.n === 1;
                return (
                  <a
                    key={item.anchor}
                    href={`#${item.anchor}`}
                    aria-current={current ? "true" : undefined}
                    className={`group flex min-w-[186px] shrink-0 items-center gap-2.5 rounded-[10px] border-2 px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] desktop:min-w-0 ${
                      current
                        ? "border-[#8a5a06] bg-[linear-gradient(160deg,#ffd45c,#f0a91d)] shadow-[0_3px_0_#8a5a06]"
                        : "border-[#081a3d] bg-[linear-gradient(160deg,#123a74,#0c2a5c)] shadow-[0_3px_0_#050f2b] hover:brightness-110"
                    }`}
                  >
                    {current && <span className="sr-only">Current section: </span>}
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border ${
                        current ? "border-[#a9740a] bg-[rgb(255_255_255_/_0.3)]" : "border-[#0a2a63] bg-[rgb(6_25_63_/_0.7)]"
                      }`}
                    >
                      <Image
                        src={images[item.iconKey]}
                        alt=""
                        aria-hidden="true"
                        width={DIMS[item.iconKey].width}
                        height={DIMS[item.iconKey].height}
                        className="object-contain"
                        style={{ maxWidth: 14, maxHeight: 14, width: "auto", height: "auto" }}
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

            {/* Sidebar legal note */}
            <div className="mt-3 hidden items-start gap-3 rounded-[10px] border-2 border-[#8a5a06] bg-[linear-gradient(160deg,#123a74,#0c2a5c)] p-3 shadow-[0_3px_0_#050f2b] desktop:flex">
              <Image
                src={images.gemRed}
                alt=""
                aria-hidden="true"
                width={DIMS.gemRed.width}
                height={DIMS.gemRed.height}
                className="mt-0.5 h-7 w-auto shrink-0 object-contain drop-shadow-[0_2px_1px_rgb(0_0_0_/_0.4)]"
              />
              <p className="text-[0.72rem] leading-[1.45] text-[#c6d4ee]">
                These Terms explain the rules for using BrawlRanks. Please read them carefully before using the website.
              </p>
            </div>
          </div>

          {/* Legal-card grid — flows row-major so DOM order is the exact numerical order (1,2,3,…). */}
          <div className="grid min-w-0 gap-3 tablet:grid-cols-2">
            {CARDS.map((card) => (
              <section key={card.anchor} id={card.anchor} className={`${CARD} scroll-mt-24 p-4`}>
                <div className="flex items-start gap-3">
                  <IconTile icon={icon(card.iconKey)} tone={card.tone} tile={48} glyph={card.glyph} />
                  <div className="min-w-0">
                    <h2 className={`${CARD_TITLE} text-[0.86rem]`}>
                      {card.n}. {card.title}
                    </h2>
                    <p className="mt-1.5 text-[0.75rem] leading-[1.45] text-[#d7e0f0]">{card.body}</p>
                  </div>
                </div>
              </section>
            ))}
          </div>
        </div>

        {/* ---- Contact banner (section 13) ---- */}
        <section
          id="contact-us"
          aria-labelledby="terms-contact"
          className="relative mt-6 flex scroll-mt-24 flex-col items-center gap-4 overflow-hidden rounded-[12px] border-2 border-[#081a3d] bg-[linear-gradient(105deg,#134a8f,#0a2650)] px-5 py-5 shadow-[0_3px_0_#050f2b,0_10px_22px_rgb(0_0_0_/_0.30)] tablet:flex-row tablet:items-center tablet:gap-6"
        >
          <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[13px] border-2 border-[#8a5a06] bg-[linear-gradient(160deg,#ffd45c,#f0a91d)] shadow-[inset_0_2px_0_rgb(255_255_255_/_0.3),0_3px_0_#8a5a06]">
            <Image
              src={images.iconInbox}
              alt=""
              aria-hidden="true"
              width={DIMS.iconInbox.width}
              height={DIMS.iconInbox.height}
              className="object-contain"
              style={{ maxWidth: 30, maxHeight: 30, width: "auto", height: "auto" }}
            />
          </span>
          <div className="flex-1 text-center tablet:text-left">
            <h2 id="terms-contact" className={`${CARD_TITLE} text-[1.05rem] tablet:text-[1.25rem]`}>
              Questions About These Terms?
            </h2>
            <p className="mt-1.5 text-[0.8rem] leading-[1.45] text-white tablet:max-w-[560px]">
              If you have questions about these Terms, contact BrawlRanks.
            </p>
          </div>
          <Link
            href="/contact"
            className="flex w-full shrink-0 items-center justify-center gap-2.5 rounded-[9px] border-2 border-[#8a5a06] bg-[linear-gradient(180deg,#ffe066,#f5ac00)] px-6 py-3 font-display text-[0.95rem] uppercase tracking-wide text-[#3a2400] shadow-[0_4px_0_#8a5a06] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] tablet:w-auto"
          >
            Contact Us
          </Link>
        </section>
      </div>
    </div>
  );
}
