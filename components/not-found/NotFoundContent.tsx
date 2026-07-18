import Image from "next/image";
import Link from "next/link";
import { NotFoundSearch } from "@/components/not-found/NotFoundSearch";

/**
 * Image sources are passed in as plain strings (set by app/not-found.tsx's
 * static PNG imports) rather than imported directly here — a PNG import
 * needs the bundler-level asset loader that Next.js's build provides but the
 * plain tsx test runner does not, matching the sibling trust-page content
 * components. Every asset lives in reference_pages/404/ and is used locally;
 * no remote image URL is ever referenced.
 */
export interface NotFoundImageSrcs {
  character: string; // character.png
  tierList: string; // icon_skin_cursed.png
  brawlers: string; // icon_in_game_BrawlersMagnet_1_active.png
  gameModes: string; // htt_summer_game_mode_icons_800x800.png
  guides: string; // icon_map_info.png
  help: string; // showdown_icon.png
}

/** Real intrinsic pixel dimensions (read from each PNG's IHDR chunk) so next/image reserves layout space without distortion. */
const DIMS = {
  character: { width: 538, height: 464 },
  tierList: { width: 800, height: 800 },
  brawlers: { width: 110, height: 113 },
  gameModes: { width: 800, height: 800 },
  guides: { width: 830, height: 751 },
  help: { width: 159, height: 181 },
} as const satisfies Record<keyof NotFoundImageSrcs, { width: number; height: number }>;

const CARD =
  "group flex flex-col items-center rounded-[12px] border-2 border-[#081a3d] bg-[linear-gradient(160deg,#123a74_0%,#0c2a5c_55%,#081f47_100%)] p-4 text-center shadow-[0_3px_0_#050f2b,0_10px_22px_rgb(0_0_0_/_0.30)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] hover:brightness-110";

const CARD_TITLE =
  "font-display uppercase leading-[1.1] text-white [text-shadow:1.5px_1.5px_0_#03102b,-1px_-1px_0_#03102b,1px_-1px_0_#03102b,-1px_1px_0_#03102b]";

interface PopularCard {
  href: string;
  title: string;
  desc: string;
  cta: string;
  iconKey: keyof NotFoundImageSrcs;
  glyph: number;
}

/**
 * The four suggested links (spec Section 17.27) are restricted to routes
 * that are implemented today. Future content hubs stay non-clickable until
 * their own phase ships.
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

/** A thin line + gold diamond divider matching the reference's section rules. */
function Divider() {
  return (
    <span aria-hidden="true" className="flex items-center gap-3">
      <span className="h-[3px] w-14 rounded-full bg-[linear-gradient(90deg,transparent,#ffd045)]" />
      <span className="block h-3 w-3 rotate-45 rounded-[2px] border-2 border-[#a9740a] bg-[linear-gradient(160deg,#ffd45c,#f0a91d)]" />
      <span className="h-[3px] w-14 rounded-full bg-[linear-gradient(90deg,#ffd045,transparent)]" />
    </span>
  );
}

export function NotFoundContent({ images }: { images: NotFoundImageSrcs }) {
  return (
    <div className="not-found-page min-h-screen bg-[linear-gradient(rgb(11_74_209_/_0.34),rgb(9_58_176_/_0.4)),var(--site-background-image)] bg-cover bg-top">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 tablet:px-6">
        {/* ---- Hero: character + 404 ---- */}
        <div className="grid items-center gap-2 pt-6 desktop:grid-cols-[minmax(0,430px)_1fr] desktop:gap-8 desktop:pt-10">
          <div className="flex justify-center desktop:justify-end">
            <Image
              src={images.character}
              alt=""
              aria-hidden="true"
              width={DIMS.character.width}
              height={DIMS.character.height}
              priority
              className="h-auto w-[240px] max-w-full object-contain drop-shadow-[0_10px_10px_rgb(0_0_0_/_0.35)] tablet:w-[300px] desktop:w-[360px]"
            />
          </div>

          <div className="text-center desktop:text-left">
            <h1 className="flex flex-col items-center desktop:items-start">
              <span
                aria-hidden="true"
                className="font-display text-[5.5rem] uppercase leading-[0.85] tracking-[-0.02em] text-white [text-shadow:3px_3px_0_#03102b,-2.5px_-2.5px_0_#03102b,2.5px_-2.5px_0_#03102b,-2.5px_2.5px_0_#03102b,0_10px_18px_rgb(0_0_0_/_0.4)] tablet:text-[7rem] desktop:text-[9rem]"
              >
                404
              </span>
              <span className="sr-only">404: </span>
              <span className="mt-1 font-display text-[1.5rem] uppercase leading-[1.05] tracking-[-0.01em] text-white [text-shadow:2px_2px_0_#03102b,-1.5px_-1.5px_0_#03102b,1.5px_-1.5px_0_#03102b,-1.5px_1.5px_0_#03102b] tablet:text-[2rem] desktop:text-[2.35rem]">
                We couldn&apos;t find that page
              </span>
            </h1>

            <div className="mt-3 flex justify-center desktop:justify-start">
              <Divider />
            </div>

            <p className="mx-auto mt-3 max-w-[440px] text-[0.9rem] font-semibold leading-[1.5] text-white [text-shadow:0_1px_1px_rgb(0_0_0_/_0.5)] desktop:mx-0">
              Looks like this page went missing or the link is broken. Don&apos;t worry, let&apos;s get you back on
              track!
            </p>
          </div>
        </div>

        {/* ---- Search ---- */}
        <div className="mx-auto mt-6 max-w-[560px]">
          <NotFoundSearch />
        </div>

        {/* ---- Back to Home CTA ---- */}
        <div className="mt-5 flex justify-center">
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-[10px] border-2 border-[#8a5a06] bg-[linear-gradient(180deg,#ffe066,#f5ac00)] px-7 py-3 font-display text-[1rem] uppercase tracking-wide text-[#3a2400] shadow-[0_4px_0_#8a5a06] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            <span
              aria-hidden="true"
              className="block h-4 w-4 rotate-45 border-l-[3px] border-t-[3px] border-[#3a2400] [clip-path:polygon(0_0,100%_0,100%_100%)]"
            />
            Back to Home
          </Link>
        </div>

        {/* ---- Popular Pages ---- */}
        <div className="mt-9 flex items-center justify-center gap-3">
          <span aria-hidden="true" className="h-[3px] w-14 max-w-[16vw] rounded-full bg-[linear-gradient(90deg,transparent,#ffd045)] tablet:w-24" />
          <h2 className={`${CARD_TITLE} text-center text-[1.15rem] tablet:text-[1.4rem]`}>Popular Pages</h2>
          <span aria-hidden="true" className="h-[3px] w-14 max-w-[16vw] rounded-full bg-[linear-gradient(90deg,#ffd045,transparent)] tablet:w-24" />
        </div>

        <div className="mt-5 grid gap-3 tablet:grid-cols-2 desktop:grid-cols-4">
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

        {/* ---- Support / help banner ---- */}
        <section
          aria-labelledby="not-found-help"
          className="relative mt-8 flex flex-col items-center gap-4 overflow-hidden rounded-[12px] border-2 border-[#081a3d] bg-[linear-gradient(105deg,#123a74,#0a2650)] px-5 py-5 shadow-[0_3px_0_#050f2b,0_10px_22px_rgb(0_0_0_/_0.30)] tablet:flex-row tablet:items-center tablet:gap-6"
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
            <h2 id="not-found-help" className={`${CARD_TITLE} text-[1.05rem] tablet:text-[1.2rem]`}>
              Still Need Help?
            </h2>
            <p className="mt-1.5 text-[0.8rem] leading-[1.45] text-white tablet:max-w-[560px]">
              If you think this is an error, or you can&apos;t find what you&apos;re looking for, feel free to contact
              us.
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
