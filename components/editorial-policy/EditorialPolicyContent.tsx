import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildArticleJsonLd, buildBreadcrumbListJsonLd } from "@/lib/seo/jsonld";

/**
 * Image sources are passed in as plain strings (set by
 * app/editorial-policy/page.tsx's static PNG imports) rather than imported
 * directly here — a PNG import needs the bundler-level asset loader that
 * Next.js's build provides but the plain tsx test runner does not, matching
 * the sibling AboutContent pattern. Every asset lives in
 * reference_pages/editorial-policy/ and is used locally; no remote image
 * URL is ever referenced.
 */
export interface EditorialImageSrcs {
  iconAutomated: string; // icon_settings.png
  iconAiAssisted: string; // foldable_robot_pin.png
  iconHuman: string; // icon_hunters.png
  tick: string; // tick.png (checklist + review-decision step)
  noteStar: string; // emoji_moba_center.png (automated note badge)
  stepDataCollection: string; // shield_front.png
  stepValidation: string; // mystery_icon.png
  stepQualityChecks: string; // icon_quest.png
  stepPublish: string; // icon_calendar_league_day.png
  policyUnsupported: string; // icon_leaderboard_demonic.png
  policyCorrections: string; // warning_icon.png
  policyConflict: string; // wipeout_icon.png
  policyFreshness: string; // icon_modifier_timedeto.png
  policySource: string; // icon_quest.png
  policyRankings: string; // pin_battle_button.png
  bannerCharacter: string; // barley_maple_barley_001.png
  decorStar: string; // emoji_moba_center.png
  decorSkull: string; // wipeout_icon.png
  decorFace: string; // gem_grab_icon.png
  decorGem: string; // gem_red.png
}

/** Real intrinsic pixel dimensions (read from each PNG's IHDR chunk) so next/image reserves layout space without cropping or stretching any asset. */
const DIMS = {
  iconAutomated: { width: 128, height: 138 },
  iconAiAssisted: { width: 881, height: 881 },
  iconHuman: { width: 300, height: 300 },
  tick: { width: 187, height: 171 },
  noteStar: { width: 120, height: 120 },
  stepDataCollection: { width: 2880, height: 1620 },
  stepValidation: { width: 320, height: 320 },
  stepQualityChecks: { width: 146, height: 197 },
  stepPublish: { width: 121, height: 128 },
  policyUnsupported: { width: 300, height: 282 },
  policyCorrections: { width: 300, height: 300 },
  policyConflict: { width: 500, height: 448 },
  policyFreshness: { width: 136, height: 128 },
  policySource: { width: 146, height: 197 },
  policyRankings: { width: 165, height: 145 },
  bannerCharacter: { width: 2106, height: 3435 },
  decorStar: { width: 120, height: 120 },
  decorSkull: { width: 500, height: 448 },
  decorFace: { width: 159, height: 171 },
  decorGem: { width: 96, height: 109 },
} as const satisfies Record<keyof EditorialImageSrcs, { width: number; height: number }>;

export const EDITORIAL_POLICY_METADATA = {
  title: "Editorial Policy",
  description:
    "Learn how BrawlRanks separates automated rankings, AI-assisted explanations, and human editorial content while handling corrections, source attribution, updates, and editorial transparency.",
  pathname: "/editorial-policy",
} as const;

type TileTone = "cyan" | "purple" | "gold" | "blue" | "green";

const TILE_TONE: Record<TileTone, string> = {
  cyan: "border-[#0a4f7a] bg-[linear-gradient(160deg,#38bdf0,#1173c4)]",
  purple: "border-[#3a1a7a] bg-[linear-gradient(160deg,#9a53e6,#5a25b8)]",
  gold: "border-[#8a5a06] bg-[linear-gradient(160deg,#ffd45c,#f0a91d)]",
  blue: "border-[#0a2a63] bg-[linear-gradient(160deg,#3f8ef0,#1e5fca)]",
  green: "border-[#136b3a] bg-[linear-gradient(160deg,#4bd06a,#1f9d4d)]",
};

const CARD =
  "relative flex flex-col rounded-[12px] border-2 border-[#081a3d] bg-[linear-gradient(160deg,#123a74_0%,#0c2a5c_55%,#081f47_100%)] shadow-[0_3px_0_#050f2b,0_10px_22px_rgb(0_0_0_/_0.30)]";

const CARD_TITLE =
  "font-display uppercase leading-[1.05] text-white [text-shadow:1.5px_1.5px_0_#03102b,-1px_-1px_0_#03102b,1px_-1px_0_#03102b,-1px_1px_0_#03102b]";

interface Icon {
  src: string;
  width: number;
  height: number;
}

function IconTile({ icon, tone, tile, glyph }: { icon: Icon; tone: TileTone; tile: number; glyph: number }) {
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
    <li className="flex items-start gap-2.5 text-[0.82rem] leading-[1.4] text-[#e4ebf7]">
      <span className="mt-[2px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-[#1f9d4d] bg-[linear-gradient(160deg,#4bd06a,#1f9d4d)] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.35)]">
        <Image src={tick.src} alt="" aria-hidden="true" width={tick.width} height={tick.height} className="h-[9px] w-auto" />
      </span>
      <span>{children}</span>
    </li>
  );
}

type NoteTone = "blue" | "purple" | "gold";

function Note({ tone, icon, children }: { tone: NoteTone; icon: Icon; children: ReactNode }) {
  const shell: Record<NoteTone, string> = {
    blue: "border-[#2f7fd6] bg-[linear-gradient(160deg,#1f6fc9,#123f86)]",
    purple: "border-[#7a3fd0] bg-[linear-gradient(160deg,#7a3ccb,#3f1a8e)]",
    gold: "border-[#b9820c] bg-[linear-gradient(160deg,#e6ab1e,#9a6a08)]",
  };
  const text: Record<NoteTone, string> = {
    blue: "text-[#e6f2ff]",
    purple: "text-[#f2e6ff]",
    gold: "text-[#241a02]",
  };
  return (
    <div className={`mt-3 flex items-center gap-2.5 rounded-[9px] border-2 px-3 py-2 ${shell[tone]}`}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] bg-black/25">
        <Image src={icon.src} alt="" aria-hidden="true" width={icon.width} height={icon.height} className="h-5 w-auto object-contain" />
      </span>
      <p className={`text-[0.72rem] font-semibold leading-[1.3] ${text[tone]}`}>{children}</p>
    </div>
  );
}

function Chevron() {
  return (
    <span aria-hidden="true" className="hidden shrink-0 self-center desktop:block">
      <span className="block h-2.5 w-2.5 rotate-45 border-r-[3px] border-t-[3px] border-[#5b9be8]" />
    </span>
  );
}

function ReviewStep({ number, title, icon, tone, tile, glyph, children }: { number: string; title: string; icon: Icon; tone: TileTone; tile: number; glyph: number; children: ReactNode }) {
  return (
    <li className={`${CARD} min-w-0 flex-1 basis-0 flex-row items-center gap-3 p-3`}>
      <IconTile icon={icon} tone={tone} tile={tile} glyph={glyph} />
      <div className="min-w-0">
        <h3 className={`${CARD_TITLE} text-[0.8rem]`}>
          {number}. {title}
        </h3>
        <p className="mt-1 text-[0.72rem] leading-[1.35] text-[#cdd8ea]">{children}</p>
      </div>
    </li>
  );
}

type CtaTone = "blue" | "gold";

function CtaLink({ href, tone, children }: { href: string; tone: CtaTone; children: ReactNode }) {
  const t =
    tone === "gold"
      ? "border-[#8a5a06] bg-[linear-gradient(180deg,#ffd35c,#f5a623)] text-[#3a2400] shadow-[0_3px_0_#8a5a06]"
      : "border-[#0a2a63] bg-[linear-gradient(180deg,#3384ef,#1a5fca)] text-white shadow-[0_3px_0_#0a2a63]";
  return (
    <Link
      href={href}
      className={`mt-auto flex min-h-9 items-center justify-center rounded-[6px] border-2 px-2 py-1 text-center font-display text-[0.66rem] uppercase leading-tight tracking-wide hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${t}`}
    >
      {children}
    </Link>
  );
}

/** A truthful, non-interactive label styled like the reference's button strip. Deliberately not a link/button and not keyboard-focusable — it performs no action. */
function CtaLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mt-auto flex min-h-9 items-center justify-center rounded-[6px] border-2 border-[#37507e] bg-[rgb(8_24_54_/_0.85)] px-2 py-1 text-center font-display text-[0.66rem] uppercase leading-tight tracking-wide text-[#9db4d8]">
      {children}
    </span>
  );
}

function PolicyCard({ icon, title, cta, children }: { icon: Icon; title: string; cta: ReactNode; children: ReactNode }) {
  return (
    <section className={`${CARD} p-3.5`}>
      <div className="flex items-center gap-2.5">
        <Image src={icon.src} alt="" aria-hidden="true" width={icon.width} height={icon.height} className="h-9 w-9 shrink-0 object-contain drop-shadow-[0_2px_1px_rgb(0_0_0_/_0.45)]" />
        <h2 className={`${CARD_TITLE} text-[0.74rem]`}>{title}</h2>
      </div>
      <p className="mb-3 mt-2.5 border-t border-[#79aaf2]/40 pt-2.5 text-[0.72rem] leading-[1.4] text-[#d7e0f0]">{children}</p>
      {cta}
    </section>
  );
}

export function EditorialPolicyContent({ images }: { images: EditorialImageSrcs }) {
  const icon = (key: keyof EditorialImageSrcs): Icon => ({ src: images[key], ...DIMS[key] });
  const breadcrumbItems = [
    { name: "Home", path: "/" },
    { name: "Editorial Policy", path: "/editorial-policy" },
  ];

  return (
    <div className="editorial-policy-page min-h-screen bg-[linear-gradient(rgb(11_74_209_/_0.34),rgb(9_58_176_/_0.4)),var(--site-background-image)] bg-cover bg-top">
      <JsonLd data={buildBreadcrumbListJsonLd(breadcrumbItems)} />
      <JsonLd
        data={buildArticleJsonLd({
          headline: "Editorial Policy",
          description: EDITORIAL_POLICY_METADATA.description,
          pathname: EDITORIAL_POLICY_METADATA.pathname,
        })}
      />

      <div className="mx-auto w-full max-w-[1200px] px-4 pb-6 tablet:px-6">
        {/* ---- Hero ---- */}
        <header className="pt-3 text-center desktop:pt-4">
          <h1 className="mx-auto max-w-[900px] font-display text-[2.55rem] uppercase leading-[0.95] tracking-[-0.01em] text-white [text-shadow:2.5px_2.5px_0_#03102b,-2px_-2px_0_#03102b,2px_-2px_0_#03102b,-2px_2px_0_#03102b,0_8px_16px_rgb(0_0_0_/_0.36)] tablet:text-[3.5rem] desktop:text-[4rem]">
            Editorial Policy
          </h1>
          <p className="mt-2 font-display text-[1.05rem] text-[#ffd529] [text-shadow:1.5px_1.5px_0_#4a3200] tablet:text-[1.3rem]">
            Transparency. Accuracy. Fairness.
          </p>
          <p className="mx-auto mt-3 max-w-[680px] text-[0.83rem] font-semibold leading-[1.5] text-white [text-shadow:0_1px_1px_rgb(0_0_0_/_0.5)] tablet:text-[0.93rem]">
            At BrawlRanks, our goal is to publish useful and reliable Brawl Stars information. This policy explains how
            automated data, AI-assisted explanations, and human-reviewed content are created, reviewed, and published.
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
                Editorial Policy
              </span>
            </li>
          </ol>
        </nav>

        <div className="editorial-content relative z-10">
          {/* ---- Row 1: three primary content-type cards ---- */}
          <div className="grid gap-3 tablet:grid-cols-2 desktop:grid-cols-3">
            <section className={`${CARD} p-4`}>
              <div className="flex items-center gap-3">
                <IconTile icon={icon("iconAutomated")} tone="cyan" tile={62} glyph={38} />
                <div className="min-w-0">
                  <h2 className={`${CARD_TITLE} text-[0.98rem]`}>1. What Is Automated</h2>
                  <p className="mt-1 text-[0.76rem] leading-[1.35] text-[#c6d2e6]">
                    These parts of BrawlRanks are generated automatically using collected data and predefined rules.
                  </p>
                </div>
              </div>
              <ul className="mt-3 flex-1 space-y-1.5">
                <Check tick={icon("tick")}>Ranking scores and tier placement</Check>
                <Check tick={icon("tick")}>Build recommendations based on available data</Check>
                <Check tick={icon("tick")}>Counter and matchup statistics</Check>
                <Check tick={icon("tick")}>Statistical aggregation</Check>
                <Check tick={icon("tick")}>Data-quality checks</Check>
                <Check tick={icon("tick")}>Scheduled publishing workflow</Check>
              </ul>
              <Note tone="blue" icon={icon("noteStar")}>
                Tiers, scores, and statistics are calculated by the BrawlRanks system — they are not manually written
                numbers.
              </Note>
            </section>

            <section className={`${CARD} p-4`}>
              <div className="flex items-center gap-3">
                <IconTile icon={icon("iconAiAssisted")} tone="purple" tile={62} glyph={44} />
                <div className="min-w-0">
                  <h2 className={`${CARD_TITLE} text-[0.98rem]`}>2. What Is AI-Assisted</h2>
                  <p className="mt-1 text-[0.76rem] leading-[1.35] text-[#c6d2e6]">
                    AI may help turn already-calculated information into readable explanations and summaries.
                  </p>
                </div>
              </div>
              <ul className="mt-3 flex-1 space-y-1.5">
                <Check tick={icon("tick")}>Ranking explanations</Check>
                <Check tick={icon("tick")}>Build explanations</Check>
                <Check tick={icon("tick")}>Matchup summaries</Check>
                <Check tick={icon("tick")}>Meta summaries</Check>
                <Check tick={icon("tick")}>FAQ drafting assistance</Check>
              </ul>
              <Note tone="purple" icon={icon("iconAiAssisted")}>
                AI does not independently choose tier scores or invent ranking numbers. It explains data already
                produced by the system.
              </Note>
            </section>

            <section className={`${CARD} p-4 tablet:col-span-2 desktop:col-span-1`}>
              <div className="flex items-center gap-3">
                <IconTile icon={icon("iconHuman")} tone="gold" tile={62} glyph={42} />
                <div className="min-w-0">
                  <h2 className={`${CARD_TITLE} text-[0.98rem]`}>3. Human Editorial Content</h2>
                  <p className="mt-1 text-[0.76rem] leading-[1.35] text-[#c6d2e6]">
                    Some content may involve human research, context, judgment, or correction.
                  </p>
                </div>
              </div>
              <ul className="mt-3 flex-1 space-y-1.5">
                <Check tick={icon("tick")}>In-depth guides</Check>
                <Check tick={icon("tick")}>Strategy articles</Check>
                <Check tick={icon("tick")}>Contextual notes and analysis</Check>
                <Check tick={icon("tick")}>Corrections</Check>
                <Check tick={icon("tick")}>Editorial annotations</Check>
                <Check tick={icon("tick")}>Policy and trust content</Check>
              </ul>
              <Note tone="gold" icon={icon("iconHuman")}>
                Human-written editorial content may be reviewed before it is published.
              </Note>
            </section>
          </div>

          {/* ---- How we review content ---- */}
          <div className="mt-6 flex items-center justify-center gap-3">
            <span aria-hidden="true" className="h-[3px] w-16 max-w-[18vw] rounded-full bg-[linear-gradient(90deg,transparent,#57b7ff)] tablet:w-24" />
            <h2 className={`${CARD_TITLE} text-center text-[1.15rem] tablet:text-[1.5rem]`}>How We Review Content</h2>
            <span aria-hidden="true" className="h-[3px] w-16 max-w-[18vw] rounded-full bg-[linear-gradient(90deg,#57b7ff,transparent)] tablet:w-24" />
          </div>

          <ol className="mt-4 flex flex-col items-stretch gap-2 desktop:flex-row desktop:items-stretch">
            {/* shield_front.png carries ~35% symmetric transparent padding, so it is bled wider than the tile and clipped (overflow-hidden) to render the shield at a legible size. */}
            <ReviewStep number="1" title="Data Collection" icon={icon("stepDataCollection")} tone="blue" tile={48} glyph={104}>
              BrawlRanks uses available official and approved public data sources where applicable.
            </ReviewStep>
            <Chevron />
            <ReviewStep number="2" title="Validation" icon={icon("stepValidation")} tone="purple" tile={48} glyph={30}>
              Incoming data is checked for usability, consistency, and obvious errors.
            </ReviewStep>
            <Chevron />
            <ReviewStep number="3" title="Quality Checks" icon={icon("stepQualityChecks")} tone="gold" tile={48} glyph={26}>
              Content and calculated output are checked for consistency and sufficient evidence.
            </ReviewStep>
            <Chevron />
            <ReviewStep number="4" title="Review Decision" icon={icon("tick")} tone="green" tile={48} glyph={24}>
              An output may be published, held for further review, corrected, or rejected.
            </ReviewStep>
            <Chevron />
            <ReviewStep number="5" title="Publish &amp; Update" icon={icon("stepPublish")} tone="blue" tile={48} glyph={28}>
              Accepted content can be published and later updated as new information becomes available.
            </ReviewStep>
          </ol>

          {/* ---- Row 3: six policy cards ---- */}
          <h2 className="sr-only">Editorial standards and policies</h2>
          <div className="mt-4 grid gap-2.5 tablet:grid-cols-2 desktop:grid-cols-3 wide:grid-cols-6">
            <PolicyCard icon={icon("policyUnsupported")} title="Preventing Unsupported Claims" cta={<CtaLink href="/disclaimer" tone="blue">Read Disclaimer</CtaLink>}>
              Factual claims are based on available evidence. Unsupported claims are not published as facts, and
              inaccurate content may be corrected or removed.
            </PolicyCard>

            <PolicyCard icon={icon("policyCorrections")} title="Corrections Policy" cta={<CtaLink href="/contact" tone="gold">Report a Correction</CtaLink>}>
              Found an error? Reports are taken seriously. Verifiable corrections are investigated, and confirmed issues
              may be fixed.
            </PolicyCard>

            <PolicyCard icon={icon("policyConflict")} title="Conflict of Interest" cta={<CtaLink href="/disclaimer" tone="blue">Read Disclaimer</CtaLink>}>
              Rankings are not changed in exchange for payment or favors. Any sponsorship or commercial relationship
              would be clearly disclosed.
            </PolicyCard>

            <PolicyCard icon={icon("policyFreshness")} title="Update &amp; Freshness" cta={<CtaLabel>Updated When Data Changes</CtaLabel>}>
              Content may be updated when new data or verified information becomes available. &ldquo;Last updated&rdquo;
              labels change only after a real update — no fake freshness.
            </PolicyCard>

            <PolicyCard icon={icon("policySource")} title="Source Attribution" cta={<CtaLink href="/disclaimer" tone="blue">Read Disclaimer</CtaLink>}>
              Official and third-party sources are credited where appropriate. BrawlRanks summarizes and analyzes rather
              than copying, and Brawl Stars assets remain owned by their rights holders.
            </PolicyCard>

            <PolicyCard icon={icon("policyRankings")} title="Rankings vs Opinion" cta={<CtaLabel>Understand the Difference</CtaLabel>}>
              Ranking scores and tiers are calculated using BrawlRanks data rules. Guides and explanations may contain
              editorial judgment, and editorial opinions do not make the rankings official Supercell rankings.
            </PolicyCard>
          </div>

          {/* ---- Commitment banner ---- */}
          <section className="relative mt-6 flex flex-col items-center gap-4 overflow-hidden rounded-[12px] border-2 border-[#081a3d] bg-[linear-gradient(105deg,#134a8f,#0a2650)] px-5 py-5 shadow-[0_3px_0_#050f2b,0_10px_22px_rgb(0_0_0_/_0.30)] tablet:flex-row tablet:items-center tablet:gap-6 tablet:py-4 tablet:pl-[210px]">
            <Image
              src={images.bannerCharacter}
              alt=""
              aria-hidden="true"
              width={DIMS.bannerCharacter.width}
              height={DIMS.bannerCharacter.height}
              sizes="(min-width: 640px) 170px, 170px"
              className="h-40 w-auto shrink-0 object-contain drop-shadow-[0_4px_4px_rgb(0_0_0_/_0.4)] tablet:absolute tablet:inset-y-0 tablet:left-6 tablet:my-auto tablet:h-[88px]"
            />
            <div className="flex-1 text-center tablet:text-left">
              <h2 className={`${CARD_TITLE} text-[1.15rem] tablet:text-[1.4rem]`}>
                We&apos;re Committed to Fair &amp; Reliable Information
              </h2>
              <p className="mt-2 text-[0.8rem] leading-[1.45] text-white tablet:max-w-[560px]">
                Our editorial standards help you understand the difference between calculated rankings, AI-assisted
                explanations, and human editorial content on BrawlRanks.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3" aria-hidden="true">
              <Image src={images.decorStar} alt="" width={DIMS.decorStar.width} height={DIMS.decorStar.height} className="h-11 w-11 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]" />
              <Image src={images.decorSkull} alt="" width={DIMS.decorSkull.width} height={DIMS.decorSkull.height} className="h-11 w-11 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]" />
              <Image src={images.decorFace} alt="" width={DIMS.decorFace.width} height={DIMS.decorFace.height} className="h-11 w-11 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]" />
              <Image src={images.decorGem} alt="" width={DIMS.decorGem.width} height={DIMS.decorGem.height} className="h-11 w-11 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]" />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
