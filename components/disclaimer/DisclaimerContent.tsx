import Image from "next/image";
import Link from "next/link";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildBreadcrumbListJsonLd } from "@/lib/seo/jsonld";

export const DISCLAIMER_METADATA = {
  title: "Disclaimer",
  description:
    "Read the BrawlRanks disclaimer covering independent rankings, sampled Brawl Stars data, Supercell non-affiliation, asset ownership, and accuracy limits.",
  pathname: "/disclaimer",
} as const;

/**
 * Image sources are passed in as plain strings (set by app/disclaimer/
 * page.tsx's static imports) rather than imported directly here — PNG
 * imports need Next.js's bundler asset loader, which the plain
 * node:test/tsx runner used by tests/disclaimerPage.test.tsx doesn't
 * have. Same pattern as the sibling About/Contact content components.
 */
export interface DisclaimerImageSrcs {
  iconHunters: string;
  imageWarningBan: string;
  brawlStarsLogo: string;
  iconQuest: string;
  iconLeaderboard: string;
  iconMobaCenter: string;
  iconKnockout: string;
  iconGold: string;
  shieldFront: string;
  iconRebound: string;
  iconCalendar: string;
  iconInbox: string;
  character: string;
}

/** Real intrinsic pixel dimensions of each PNG (read from IHDR), so next/image reserves layout space without distortion. */
const IMAGE_DIMENSIONS = {
  iconHunters: { width: 300, height: 300 },
  imageWarningBan: { width: 180, height: 158 },
  brawlStarsLogo: { width: 1129, height: 907 },
  iconQuest: { width: 146, height: 197 },
  iconLeaderboard: { width: 300, height: 282 },
  iconMobaCenter: { width: 120, height: 120 },
  iconKnockout: { width: 70, height: 64 },
  iconGold: { width: 258, height: 177 },
  shieldFront: { width: 2880, height: 1620 },
  iconRebound: { width: 130, height: 139 },
  iconCalendar: { width: 121, height: 128 },
  iconInbox: { width: 136, height: 109 },
  character: { width: 2106, height: 3435 },
} as const satisfies Record<keyof DisclaimerImageSrcs, { width: number; height: number }>;

const CARD_SHELL =
  "rounded-[11px] border-[2px] border-[#061936] bg-[linear-gradient(165deg,rgb(10_38_92_/_0.96),rgb(6_25_63_/_0.97))] shadow-[0_3px_0_#061936,0_9px_18px_rgb(0_0_0_/_0.22)]";

const CARD_TITLE =
  "font-display text-[0.84rem] uppercase leading-[1.15] text-white [text-shadow:1.5px_1.5px_0_#03102b,-1px_-1px_0_#03102b,1px_-1px_0_#03102b,-1px_1px_0_#03102b]";

interface DisclaimerSection {
  number: number;
  title: string;
  body: string;
  imageKey: keyof DisclaimerImageSrcs;
  /** Per-asset sizing — each PNG has different intrinsic/transparent bounds, so no single class fits all. */
  imageClass: string;
  /**
   * The Brawl Stars logo identifies whose trademarks the card is about —
   * meaningful, not decorative. Everything else is decoration beside text
   * that already carries the information.
   */
  imageAlt?: string;
}

const SECTIONS: readonly DisclaimerSection[] = [
  {
    number: 1,
    title: "Independent fan site",
    body: "BrawlRanks is an independent Brawl Stars fan website made by fans, for fans. It does not represent Supercell and is not an official Brawl Stars service.",
    imageKey: "iconHunters",
    imageClass: "h-14 w-auto",
  },
  {
    number: 2,
    title: "No affiliation or endorsement",
    body: "BrawlRanks is not affiliated with Supercell and is not sponsored, approved, or endorsed by Supercell in any way. Use of Brawl Stars assets must not imply endorsement.",
    imageKey: "imageWarningBan",
    imageClass: "h-14 w-auto",
  },
  {
    number: 3,
    title: "Trademarks & game assets",
    body: "Brawl Stars, Supercell, characters, logos, art, and related game assets belong to their respective rights holders. Fan Kit material is third-party fan-content material and is not owned by BrawlRanks.",
    imageKey: "brawlStarsLogo",
    imageClass: "h-16 w-auto",
    imageAlt: "Brawl Stars logo, a trademark of its rights holder",
  },
  {
    number: 4,
    title: "API & data source",
    body: "BrawlRanks uses data obtained through the official Brawl Stars API, processed by the BrawlRanks automated pipeline. The site's public output is independently calculated.",
    imageKey: "iconQuest",
    imageClass: "h-16 w-auto",
  },
  {
    number: 5,
    title: "Independent rankings",
    body: "BrawlRanks rankings are independently calculated and are not official Supercell rankings. Tier positions and scores reflect this project's own methodology.",
    imageKey: "iconLeaderboard",
    imageClass: "h-14 w-auto",
  },
  {
    number: 6,
    title: "Sampled data",
    body: "The dataset is sampled and does not represent every battle played globally. Some modes, trophy brackets, matchups, regions, or periods may have less evidence.",
    imageKey: "iconMobaCenter",
    imageClass: "h-14 w-auto",
  },
  {
    number: 7,
    title: "Gameplay variability",
    body: "Results depend on game mode, map, team composition, trophy bracket, player skill, sample size, balance changes, and patch boundaries. Counters, tiers, and matchup observations are tendencies, not guaranteed outcomes.",
    imageKey: "iconKnockout",
    imageClass: "h-12 w-auto",
  },
  {
    number: 8,
    title: "No guarantee of results",
    body: "BrawlRanks does not guarantee wins, rank progression, or gameplay outcomes. Rankings and guides are informational only — player results can differ significantly.",
    imageKey: "iconGold",
    imageClass: "h-14 w-auto",
  },
  {
    number: 9,
    title: "Accuracy & availability",
    body: "BrawlRanks aims to provide accurate information, but complete accuracy and uninterrupted availability cannot be guaranteed. Data can be delayed, incomplete, unavailable, or temporarily held.",
    imageKey: "shieldFront",
    // 2880x1620 canvas whose visible shield fills only the middle ~30% —
    // oversized inside a clipping frame so the shield itself lands at icon scale.
    imageClass: "h-28 w-auto max-w-none",
  },
  {
    number: 10,
    title: "Updates & revisions",
    body: "Published information may change as new data is collected. Rankings may be updated after aggregation and publication safeguards, and corrections are made when verifiable evidence shows an issue.",
    imageKey: "iconRebound",
    imageClass: "h-14 w-auto",
  },
  {
    number: 11,
    title: "Data timing & freshness",
    body: "Technical failures or upstream official API limits may affect data freshness. When a candidate update fails safety checks, the previous valid published snapshot may stay live.",
    imageKey: "iconCalendar",
    imageClass: "h-14 w-auto",
  },
] as const;

function SectionCard({ section, src }: { section: DisclaimerSection; src: string }) {
  const dimensions = IMAGE_DIMENSIONS[section.imageKey];
  return (
    <section aria-labelledby={`disclaimer-section-${section.number}`} className={`${CARD_SHELL} flex flex-col items-center px-4 py-5 text-center`}>
      <span className="flex h-16 w-full items-center justify-center overflow-hidden">
        <Image
          src={src}
          alt={section.imageAlt ?? ""}
          aria-hidden={section.imageAlt ? undefined : "true"}
          width={dimensions.width}
          height={dimensions.height}
          className={`${section.imageClass} object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.4)]`}
        />
      </span>
      <h2 id={`disclaimer-section-${section.number}`} className={`mt-3 ${CARD_TITLE}`}>
        {section.number}. {section.title}
      </h2>
      <p className="mt-2.5 text-[0.73rem] leading-[1.55] text-[#c6d4ee]">{section.body}</p>
    </section>
  );
}

export function DisclaimerContent({ images }: { images: DisclaimerImageSrcs }) {
  const breadcrumbItems = [{ name: "Home", path: "/" }, { name: "Disclaimer", path: "/disclaimer" }];

  return (
    <div className="disclaimer-page min-h-screen bg-[linear-gradient(rgb(8_112_239_/_0.2),rgb(5_83_213_/_0.15)),var(--site-background-image)] bg-cover bg-top">
      <JsonLd data={buildBreadcrumbListJsonLd(breadcrumbItems)} />

      <div className="mx-auto max-w-[85rem] px-4 pb-8">
        <header className="pb-4 pt-3 text-center">
          <h1 className="mx-auto max-w-[820px] font-display text-[2.1rem] uppercase leading-none tracking-[-0.01em] text-white [text-shadow:2.5px_2.5px_0_#03102b,-2px_-2px_0_#03102b,2px_-2px_0_#03102b,-2px_2px_0_#03102b,0_8px_14px_rgb(0_0_0_/_0.34)] tablet:text-[2.9rem] desktop:text-[3.2rem]">
            Disclaimer
          </h1>
          <p className="mt-3 font-display text-[0.95rem] text-[#ffd529] [text-shadow:1px_1px_0_#493200] tablet:text-[1.05rem]">
            Important information about BrawlRanks
          </p>
          <p className="mx-auto mt-3 max-w-[680px] text-[0.82rem] font-semibold leading-[1.55] text-white [text-shadow:0_1px_1px_rgb(0_0_0_/_0.5)] tablet:text-[0.9rem]">
            BrawlRanks provides independently calculated Brawl Stars information built from sampled match data.
            Please read this disclaimer to understand the site&apos;s limits and its unofficial fan-site status.
          </p>
          {/* TODO: Final legal review recommended before production launch */}
        </header>

        <nav aria-label="Breadcrumb" className="flex justify-center pb-6">
          <ol className="flex w-full max-w-[440px] items-center justify-center gap-4 rounded-[8px] border-[2px] border-[#061936] bg-[rgb(7_30_74_/_0.85)] px-5 py-2">
            <li>
              <Link
                href="/"
                className="rounded-[4px] font-display text-[0.74rem] uppercase tracking-wide text-white hover:text-[#ffd529] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
              >
                Home
              </Link>
            </li>
            <li aria-hidden="true" className="font-display text-[0.74rem] text-[#8fa3c6]">
              &rsaquo;
            </li>
            <li>
              <span aria-current="page" className="font-display text-[0.74rem] uppercase tracking-wide text-[#ffd529]">
                Disclaimer
              </span>
            </li>
          </ol>
        </nav>

        <div className="grid gap-3 tablet:grid-cols-2 desktop:grid-cols-3 wide:grid-cols-6">
          {SECTIONS.slice(0, 6).map((section) => (
            <SectionCard key={section.number} section={section} src={images[section.imageKey]} />
          ))}
        </div>
        <div className="mt-3 grid gap-3 tablet:grid-cols-2 desktop:grid-cols-3 wide:grid-cols-5">
          {SECTIONS.slice(6).map((section) => (
            <SectionCard key={section.number} section={section} src={images[section.imageKey]} />
          ))}
        </div>

        <section
          aria-labelledby="disclaimer-acknowledgement"
          className="mt-5 rounded-[11px] border-[2px] border-[#a97a00] bg-[linear-gradient(165deg,rgb(10_38_92_/_0.96),rgb(6_25_63_/_0.97))] px-6 py-5 text-center shadow-[0_3px_0_#061936,0_9px_18px_rgb(0_0_0_/_0.22)]"
        >
          <h2 id="disclaimer-acknowledgement" className={`${CARD_TITLE} text-[0.95rem]`}>
            Please remember
          </h2>
          <p className="mx-auto mt-3 max-w-[760px] font-display text-[0.88rem] leading-[1.4] text-[#ffd529] [text-shadow:1px_1px_0_#493200]">
            BrawlRanks rankings are independently calculated and are not official Supercell rankings.
          </p>
          <p className="mx-auto mt-2.5 max-w-[760px] text-[0.78rem] leading-[1.55] text-[#c6d4ee]">
            BrawlRanks is an independent fan site. It is not affiliated with, sponsored by, or endorsed by
            Supercell. Brawl Stars and related assets belong to their respective rights holders.
          </p>
        </section>

        <section
          aria-labelledby="disclaimer-contact"
          className="relative mt-5 flex min-h-[112px] flex-col items-center gap-5 overflow-hidden rounded-[11px] border-[2px] border-[#061936] bg-[linear-gradient(105deg,#3c2b96,#241a67)] px-6 py-5 shadow-[0_3px_0_#061936,0_9px_18px_rgb(0_0_0_/_0.22)] tablet:flex-row tablet:items-center tablet:gap-6 tablet:py-4 tablet:pl-[132px]"
        >
          <Image
            src={images.character}
            alt=""
            aria-hidden="true"
            width={IMAGE_DIMENSIONS.character.width}
            height={IMAGE_DIMENSIONS.character.height}
            className="h-32 w-auto shrink-0 object-contain tablet:absolute tablet:bottom-[-26px] tablet:left-5 tablet:h-[154px]"
          />
          <div className="flex-1 text-center tablet:text-left">
            <h2 id="disclaimer-contact" className={`${CARD_TITLE} text-[1rem] tablet:text-[1.1rem]`}>
              Questions or found an issue?
            </h2>
            <p className="mt-2 text-[0.78rem] leading-[1.5] text-white tablet:max-w-[540px]">
              You can report incorrect data, technical issues, copyright or asset-usage concerns, and correction
              requests. If you believe something is incorrect, outdated, or missing, please let us know.
            </p>
          </div>
          <Link
            href="/contact"
            className="flex shrink-0 items-center gap-2.5 rounded-[9px] border-[2px] border-[#a97a00] bg-[linear-gradient(180deg,#ffd529,#f5a623)] px-5 py-2.5 font-display text-[0.86rem] uppercase tracking-wide text-[#3a2a00] shadow-[0_3px_0_#a97a00] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            <Image
              src={images.iconInbox}
              alt=""
              aria-hidden="true"
              width={IMAGE_DIMENSIONS.iconInbox.width}
              height={IMAGE_DIMENSIONS.iconInbox.height}
              className="h-5 w-6 object-contain"
            />
            Contact us
          </Link>
        </section>
      </div>
    </div>
  );
}
