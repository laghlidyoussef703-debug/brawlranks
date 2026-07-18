import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildBreadcrumbListJsonLd } from "@/lib/seo/jsonld";

/**
 * Image sources are passed in as plain strings (set by app/about/page.tsx's
 * static imports) rather than imported directly in this component — a PNG
 * import needs a bundler-level asset loader that Next.js's build provides
 * but the plain node:test/tsx runner used by tests/aboutPage.test.tsx does
 * not, matching the existing heroImageSrc pattern in the sibling
 * Disclaimer/EditorialPolicy content components.
 */
export interface AboutImageSrcs {
  iconWhatIsBrawlranks: string;
  iconWhyWeExist: string;
  iconAutomation: string;
  iconTrust: string;
  iconUnofficial: string;
  iconQuestion: string;
  bannerCharacter: string;
  decorGem: string;
  decorEmblem: string;
  decorPyramid: string;
}

/** Real intrinsic pixel dimensions (read from each PNG's IHDR chunk) — passed to next/image so it can reserve layout space without cropping/stretching any asset. */
const IMAGE_DIMENSIONS = {
  iconWhatIsBrawlranks: { width: 560, height: 472 },
  iconWhyWeExist: { width: 240, height: 240 },
  iconAutomation: { width: 120, height: 100 },
  iconTrust: { width: 240, height: 240 },
  iconUnofficial: { width: 975, height: 975 },
  iconQuestion: { width: 120, height: 180 },
  bannerCharacter: { width: 2106, height: 3435 },
  decorGem: { width: 96, height: 109 },
  decorEmblem: { width: 159, height: 167 },
  decorPyramid: { width: 81, height: 87 },
} as const satisfies Record<keyof AboutImageSrcs, { width: number; height: number }>;

export const ABOUT_METADATA = {
  title: "About BrawlRanks",
  description:
    "BrawlRanks is an independent fan site covering Brawl Stars tier lists, builds, counters, and meta insights, calculated through a transparent, automated pipeline.",
  pathname: "/about",
} as const;

type ButtonTone = "blue" | "gold";

const CARD_SHELL =
  "relative flex min-h-[218px] flex-col rounded-[11px] border-[2px] border-[#061936] bg-[linear-gradient(160deg,rgb(18_92_204_/_0.94)_0%,rgb(9_67_167_/_0.96)_58%,rgb(6_48_130_/_0.98)_100%)] px-5 pb-4 pt-3 shadow-[0_3px_0_#061936,0_9px_18px_rgb(0_0_0_/_0.22)]";

const CARD_TITLE =
  "font-display text-[1.08rem] uppercase leading-[1.05] text-white [text-shadow:1.5px_1.5px_0_#03102b,-1px_-1px_0_#03102b,1px_-1px_0_#03102b,-1px_1px_0_#03102b]";

const CARD_BODY = "mt-2.5 flex-1 border-t border-[#79aaf2]/55 pt-3 text-[0.84rem] leading-[1.38] text-white";

function CtaButton({ href, tone = "blue", children }: { href: string; tone?: ButtonTone; children: ReactNode }) {
  const toneClass =
    tone === "gold"
      ? "border-[#8a5a06] bg-[linear-gradient(180deg,#ffd35c,#f5a623)] text-[#3a2400] shadow-[0_4px_0_#8a5a06] hover:brightness-105"
      : "border-[#0a2a63] bg-[linear-gradient(180deg,#3384ef,#1a5fca)] text-white shadow-[0_4px_0_#0a2a63] hover:brightness-110";

  return (
    <Link
      href={href}
      className={`mt-2.5 flex min-h-9 items-center justify-center rounded-[5px] border-[2px] px-4 py-1 font-display text-[0.8rem] uppercase tracking-wide focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${toneClass}`}
    >
      {children}
    </Link>
  );
}

interface IconSpec {
  src: string;
  width: number;
  height: number;
}

function AboutCard({
  icon,
  title,
  ctaHref,
  ctaLabel,
  tone = "blue",
  children,
}: {
  icon: IconSpec;
  title: string;
  ctaHref: string;
  ctaLabel: string;
  tone?: ButtonTone;
  children: ReactNode;
}) {
  return (
    <section className={CARD_SHELL}>
      <div className="flex min-h-[58px] items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center">
          <Image src={icon.src} alt="" aria-hidden="true" width={icon.width} height={icon.height} className="max-h-14 w-14 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]" />
        </div>
        <h2 className={CARD_TITLE}>{title}</h2>
      </div>
      <p className={CARD_BODY}>{children}</p>
      <CtaButton href={ctaHref} tone={tone}>
        {ctaLabel}
      </CtaButton>
    </section>
  );
}

function DecorBadge({ icon }: { icon: IconSpec }) {
  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center">
      <Image src={icon.src} alt="" aria-hidden="true" width={icon.width} height={icon.height} className="max-h-12 w-12 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]" />
    </div>
  );
}

export function AboutContent({ images }: { images: AboutImageSrcs }) {
  const breadcrumbItems = [{ name: "Home", path: "/" }, { name: "About", path: "/about" }];
  const icon = (key: keyof AboutImageSrcs): IconSpec => ({ src: images[key], ...IMAGE_DIMENSIONS[key] });

  return (
    <div className="about-page min-h-screen bg-[linear-gradient(rgb(8_112_239_/_0.2),rgb(5_83_213_/_0.15)),var(--site-background-image)] bg-cover bg-top">
      <JsonLd data={buildBreadcrumbListJsonLd(breadcrumbItems)} />

      <div className="mx-auto max-w-[63rem] px-4">
        <nav aria-label="Breadcrumb" className="py-2 text-[0.72rem]">
          <ol className="flex items-center gap-2 text-[#9aa7bc]">
            <li>
              <Link href="/" className="rounded-[4px] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]">
                Home
              </Link>
            </li>
            <li aria-hidden="true" className="text-[#5f708e]">/</li>
            <li>
              <span aria-current="page" className="text-[#dce3ef]">About</span>
            </li>
          </ol>
        </nav>

        <header className="pb-6 pt-2 text-center desktop:pb-7">
          <h1 className="mx-auto max-w-[820px] font-display text-[2.3rem] uppercase leading-none tracking-[-0.01em] text-white [text-shadow:2.5px_2.5px_0_#03102b,-2px_-2px_0_#03102b,2px_-2px_0_#03102b,-2px_2px_0_#03102b,0_8px_14px_rgb(0_0_0_/_0.34)] tablet:text-[3rem] desktop:text-[3.2rem]">
            About BrawlRanks
          </h1>
          <p className="mt-3 font-display text-[0.95rem] text-[#ffd529] [text-shadow:1px_1px_0_#493200] tablet:text-[1.05rem]">
            Your ultimate Brawl Stars companion
          </p>
          <p className="mx-auto mt-3 max-w-[720px] text-[0.82rem] font-semibold leading-[1.55] text-white [text-shadow:0_1px_1px_rgb(0_0_0_/_0.5)] tablet:text-[0.9rem]">
            BrawlRanks is an independent Brawl Stars fan website that brings tier lists, builds, counters, and meta
            insights together in one place. Our mission is simple: help every player understand the game with clear,
            data-driven, and easy-to-follow information.
          </p>
        </header>

        <div className="about-content relative z-10 pb-3">
          <div className="grid gap-3.5 tablet:grid-cols-2 desktop:grid-cols-3">
            <AboutCard icon={icon("iconWhatIsBrawlranks")} title="What is BrawlRanks?" ctaHref="/editorial-policy" ctaLabel="Editorial Policy">
              BrawlRanks helps players find tier lists, Brawler information, builds, counters, and meta insights —
              all organized to be easy to understand at a glance.
            </AboutCard>

            <AboutCard icon={icon("iconWhyWeExist")} title="Why we exist" ctaHref="/contact" ctaLabel="Contact Us" tone="gold">
              The Brawl Stars meta shifts with every balance change. We exist to give players clear, reliable, and
              easy-to-understand information so they don&apos;t have to dig through raw data themselves.
            </AboutCard>

            <AboutCard icon={icon("iconAutomation")} title="Automation & data transparency" ctaHref="/disclaimer" ctaLabel="Read Disclaimer">
              Our automated data pipeline uses the official Brawl Stars API and processes sampled data. Sampled
              data does not represent every battle played globally, and every result is processed consistently.
            </AboutCard>

            <AboutCard icon={icon("iconTrust")} title="Trust & editorial standards" ctaHref="/editorial-policy" ctaLabel="Editorial Policy">
              We&apos;re committed to accuracy, fairness, and transparency in everything we publish. Our rankings and
              guides follow a clear editorial policy, and pages like our Editorial Policy and Disclaimer explain exactly how
              we work.
            </AboutCard>

            <AboutCard icon={icon("iconUnofficial")} title="Unofficial fan site" ctaHref="/disclaimer" ctaLabel="Read Disclaimer">
              BrawlRanks is an independent Brawl Stars fan website. We are not affiliated with, endorsed by, or
              sponsored by Supercell, and our rankings are not official Supercell rankings.
            </AboutCard>

            <AboutCard icon={icon("iconQuestion")} title="Have a question?" ctaHref="/contact" ctaLabel="Contact Us" tone="gold">
              Found an error? Have a suggestion? Want to collaborate? We&apos;d love to hear from you and are always
              working to make BrawlRanks better for the community.
            </AboutCard>
          </div>

          <section className="relative mt-7 flex min-h-[112px] flex-col items-center gap-5 overflow-hidden rounded-[11px] border-[2px] border-[#061936] bg-[linear-gradient(105deg,#155ac5,#0b3b94)] px-6 py-5 shadow-[0_3px_0_#061936,0_9px_18px_rgb(0_0_0_/_0.22)] tablet:flex-row tablet:items-center tablet:gap-6 tablet:py-4 tablet:pl-[132px]">
            <Image
              src={images.bannerCharacter}
              alt=""
              aria-hidden="true"
              width={IMAGE_DIMENSIONS.bannerCharacter.width}
              height={IMAGE_DIMENSIONS.bannerCharacter.height}
              className="h-32 w-auto shrink-0 object-contain tablet:absolute tablet:bottom-[-26px] tablet:left-5 tablet:h-[154px]"
            />
            <div className="flex-1 text-center tablet:text-left">
              <h2 className="font-display text-[1rem] uppercase leading-tight text-white [text-shadow:1px_1px_0_#03102b,-1px_-1px_0_#03102b,1px_-1px_0_#03102b,-1px_1px_0_#03102b] tablet:text-[1.1rem]">
                Thanks for being part of the Brawl community!
              </h2>
              <p className="mt-2 text-[0.76rem] leading-[1.45] text-white tablet:max-w-[520px]">
                We&apos;re building BrawlRanks for players who love the game. Together, we can make rankings and
                insights easier for the whole community to understand.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2.5" aria-hidden="true">
              <DecorBadge icon={icon("decorEmblem")} />
              <DecorBadge icon={icon("decorGem")} />
              <DecorBadge icon={icon("decorPyramid")} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
