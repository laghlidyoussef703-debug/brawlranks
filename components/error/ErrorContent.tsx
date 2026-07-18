import Image from "next/image";
import Link from "next/link";

/**
 * Image sources are passed in as plain strings (set by app/error.tsx's
 * static PNG imports) rather than imported directly here — a PNG import
 * needs the bundler-level asset loader that Next.js's build provides but the
 * plain tsx test runner does not, matching the sibling not-found / trust
 * content components. Every asset lives in reference_pages/Error/ and is
 * used locally; no remote image URL is ever referenced.
 */
export interface ErrorImageSrcs {
  character: string; // error1.png
  tierList: string; // icon_skin_cursed.png
  brawlers: string; // icon_in_game_BrawlersMagnet_1_active.png
  gameModes: string; // htt_summer_game_mode_icons_800x800.png
  guides: string; // icon_map_info.png
  help: string; // showdown_icon.png
}

/** Real intrinsic pixel dimensions (read from each PNG's IHDR chunk) so next/image reserves layout space without distortion. */
const DIMS = {
  character: { width: 612, height: 408 },
  tierList: { width: 800, height: 800 },
  brawlers: { width: 110, height: 113 },
  gameModes: { width: 800, height: 800 },
  guides: { width: 830, height: 751 },
  help: { width: 159, height: 181 },
} as const satisfies Record<keyof ErrorImageSrcs, { width: number; height: number }>;

const CARD =
  "group flex flex-col items-center rounded-[12px] border-2 border-[#081a3d] bg-[linear-gradient(160deg,#123a74_0%,#0c2a5c_55%,#081f47_100%)] p-4 text-center shadow-[0_3px_0_#050f2b,0_10px_22px_rgb(0_0_0_/_0.30)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] hover:brightness-110";

const CARD_TITLE =
  "font-display uppercase leading-[1.1] text-white [text-shadow:1.5px_1.5px_0_#03102b,-1px_-1px_0_#03102b,1px_-1px_0_#03102b,-1px_1px_0_#03102b]";

interface PopularCard {
  href: string;
  title: string;
  desc: string;
  cta: string;
  iconKey: keyof ErrorImageSrcs;
  glyph: number;
}

/**
 * The four suggested links (spec Section 17.28's return paths) are
 * restricted to routes that are implemented today. Future content hubs
 * stay non-clickable until their own phase ships.
 */
const CARDS: readonly PopularCard[] = [
  {
    href: "/about",
    title: "About",
    desc: "Learn what BrawlRanks is and why the site exists.",
    cta: "About BrawlRanks",
    iconKey: "tierList",
    glyph: 60,
  },
  {
    href: "/editorial-policy",
    title: "Editorial Policy",
    desc: "Read how BrawlRanks approaches accuracy and corrections.",
    cta: "Read Policy",
    iconKey: "brawlers",
    glyph: 56,
  },
  {
    href: "/privacy-policy",
    title: "Privacy Policy",
    desc: "See how this site handles privacy and technical data.",
    cta: "Read Privacy Policy",
    iconKey: "gameModes",
    glyph: 62,
  },
  {
    href: "/terms-of-service",
    title: "Terms of Service",
    desc: "Review the terms that apply when using BrawlRanks.",
    cta: "Read Terms",
    iconKey: "guides",
    glyph: 62,
  },
];

function Divider() {
  return (
    <span aria-hidden="true" className="flex items-center gap-3">
      <span className="h-[3px] w-14 rounded-full bg-[linear-gradient(90deg,transparent,#ffd045)]" />
      <span className="block h-3 w-3 rotate-45 rounded-[2px] border-2 border-[#a9740a] bg-[linear-gradient(160deg,#ffd45c,#f0a91d)]" />
      <span className="h-[3px] w-14 rounded-full bg-[linear-gradient(90deg,#ffd045,transparent)]" />
    </span>
  );
}

export function ErrorContent({ images, onRetry }: { images: ErrorImageSrcs; onRetry: () => void }) {
  return (
    <div className="error-page min-h-screen bg-[linear-gradient(rgb(11_74_209_/_0.34),rgb(9_58_176_/_0.4)),var(--site-background-image)] bg-cover bg-top">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 tablet:px-6">
        {/* ---- Hero: character + 500 ---- */}
        <div className="grid items-center gap-2 pt-6 desktop:grid-cols-[minmax(0,470px)_1fr] desktop:gap-8 desktop:pt-10">
          <div className="flex justify-center desktop:justify-end">
            <Image
              src={images.character}
              alt=""
              aria-hidden="true"
              width={DIMS.character.width}
              height={DIMS.character.height}
              priority
              className="h-auto w-[270px] max-w-full object-contain drop-shadow-[0_10px_10px_rgb(0_0_0_/_0.35)] tablet:w-[340px] desktop:w-[400px]"
            />
          </div>

          <div className="text-center desktop:text-left">
            <h1 className="flex flex-col items-center desktop:items-start">
              <span
                aria-hidden="true"
                className="font-display text-[5.5rem] uppercase leading-[0.85] tracking-[-0.02em] text-white [text-shadow:3px_3px_0_#03102b,-2.5px_-2.5px_0_#03102b,2.5px_-2.5px_0_#03102b,-2.5px_2.5px_0_#03102b,0_10px_18px_rgb(0_0_0_/_0.4)] tablet:text-[7rem] desktop:text-[9rem]"
              >
                500
              </span>
              <span className="sr-only">500: </span>
              <span className="mt-1 font-display text-[1.5rem] uppercase leading-[1.05] tracking-[-0.01em] text-white [text-shadow:2px_2px_0_#03102b,-1.5px_-1.5px_0_#03102b,1.5px_-1.5px_0_#03102b,-1.5px_1.5px_0_#03102b] tablet:text-[2rem] desktop:text-[2.35rem]">
                Something went wrong
              </span>
            </h1>

            <div className="mt-3 flex justify-center desktop:justify-start">
              <Divider />
            </div>

            <p className="mx-auto mt-3 max-w-[440px] text-[0.9rem] font-semibold leading-[1.5] text-white [text-shadow:0_1px_1px_rgb(0_0_0_/_0.5)] desktop:mx-0">
              We couldn&apos;t load this page right now. This is our fault, not yours.
            </p>
            <p className="mx-auto mt-1 max-w-[440px] text-[0.86rem] leading-[1.5] text-[#bcd0f2] desktop:mx-0">
              Please try again in a few moments.
            </p>

            {/* ---- Recovery actions ---- */}
            <div className="mt-5 flex flex-col items-center gap-3 tablet:flex-row tablet:justify-center desktop:justify-start">
              <button
                type="button"
                onClick={onRetry}
                className="flex w-full items-center justify-center gap-2.5 rounded-[10px] border-2 border-[#8a5a06] bg-[linear-gradient(180deg,#ffe066,#f5ac00)] px-7 py-3 font-display text-[1rem] uppercase tracking-wide text-[#3a2400] shadow-[0_4px_0_#8a5a06] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] tablet:w-auto"
              >
                <span aria-hidden="true" className="relative block h-4 w-4">
                  <span className="block h-4 w-4 rounded-full border-2 border-[#3a2400] border-t-transparent" />
                  <span className="absolute -right-[1px] top-0 h-0 w-0 border-b-[6px] border-l-[6px] border-b-[#3a2400] border-l-transparent" />
                </span>
                Try Again
              </button>
              <Link
                href="/"
                className="flex w-full items-center justify-center gap-2.5 rounded-[10px] border-2 border-[#0a2a63] bg-[linear-gradient(180deg,#3384ef,#1a5fca)] px-7 py-3 font-display text-[1rem] uppercase tracking-wide text-white shadow-[0_4px_0_#0a2a63] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] tablet:w-auto"
              >
                <span aria-hidden="true" className="relative block h-4 w-4">
                  <span className="absolute left-1/2 top-0 h-0 w-0 -translate-x-1/2 border-x-[8px] border-b-[7px] border-x-transparent border-b-white" />
                  <span className="absolute bottom-0 left-1/2 h-2.5 w-3.5 -translate-x-1/2 rounded-[1px] bg-white" />
                </span>
                Back to Home
              </Link>
            </div>
          </div>
        </div>

        {/* ---- Popular pages panel ---- */}
        <section
          aria-labelledby="error-popular"
          className="mt-9 rounded-[14px] border-2 border-[#081a3d] bg-[rgb(7_28_66_/_0.6)] p-4 shadow-[0_3px_0_#050f2b] tablet:p-5"
        >
          <h2 id="error-popular" className={`${CARD_TITLE} text-center text-[1.15rem] tablet:text-[1.35rem]`}>
            Still Looking for Something?
          </h2>
          <p className="mt-1 text-center text-[0.85rem] text-[#bcd0f2]">Check out these popular pages.</p>

          <div className="mt-4 grid gap-3 tablet:grid-cols-2 desktop:grid-cols-4">
            {CARDS.map((card) => (
              <Link key={card.href} href={card.href} className={CARD}>
                <span className="flex h-[76px] items-center justify-center">
                  <Image
                    src={images[card.iconKey]}
                    alt=""
                    aria-hidden="true"
                    width={DIMS[card.iconKey].width}
                    height={DIMS[card.iconKey].height}
                    className="object-contain drop-shadow-[0_4px_3px_rgb(0_0_0_/_0.4)]"
                    style={{ maxWidth: card.glyph, maxHeight: 72, width: "auto", height: "auto" }}
                  />
                </span>
                <h3 className={`${CARD_TITLE} mt-2 text-[1rem]`}>{card.title}</h3>
                <p className="mt-1.5 flex-1 text-[0.78rem] leading-[1.45] text-[#c6d4ee]">{card.desc}</p>
                <span className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[8px] border-2 border-[#0a2a63] bg-[linear-gradient(180deg,#3384ef,#1a5fca)] px-3 py-2 font-display text-[0.72rem] uppercase tracking-wide text-white shadow-[0_3px_0_#0a2a63] group-hover:brightness-110">
                  {card.cta}
                  <span aria-hidden="true" className="block h-2 w-2 rotate-45 border-r-2 border-t-2 border-white" />
                </span>
              </Link>
            ))}
          </div>
        </section>

        {/* ---- Support / help banner ---- */}
        <section
          aria-labelledby="error-help"
          className="relative mt-6 flex flex-col items-center gap-4 overflow-hidden rounded-[12px] border-2 border-[#081a3d] bg-[linear-gradient(105deg,#123a74,#0a2650)] px-5 py-5 shadow-[0_3px_0_#050f2b,0_10px_22px_rgb(0_0_0_/_0.30)] tablet:flex-row tablet:items-center tablet:gap-6"
        >
          <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[13px] border-2 border-[#0a2a63] bg-[rgb(6_25_63_/_0.85)]">
            <Image
              src={images.help}
              alt=""
              aria-hidden="true"
              width={DIMS.help.width}
              height={DIMS.help.height}
              className="object-contain drop-shadow-[0_2px_1px_rgb(0_0_0_/_0.4)]"
              style={{ maxWidth: 36, maxHeight: 40, width: "auto", height: "auto" }}
            />
          </span>
          <div className="flex-1 text-center tablet:text-left">
            <h2 id="error-help" className={`${CARD_TITLE} text-[1.05rem] tablet:text-[1.2rem]`}>
              Need More Help?
            </h2>
            <p className="mt-1.5 text-[0.8rem] leading-[1.45] text-white tablet:max-w-[560px]">
              If the problem continues, please let us know so we can look into it.
            </p>
          </div>
          <Link
            href="/contact"
            className="flex w-full shrink-0 items-center justify-center rounded-[9px] border-2 border-[#8a5a06] bg-[linear-gradient(180deg,#ffe066,#f5ac00)] px-6 py-3 font-display text-[0.9rem] uppercase tracking-wide text-[#3a2400] shadow-[0_4px_0_#8a5a06] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] tablet:w-auto"
          >
            Contact Us
          </Link>
        </section>
      </div>
    </div>
  );
}
