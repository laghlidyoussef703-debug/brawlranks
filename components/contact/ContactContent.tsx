import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { JsonLd } from "@/components/seo/JsonLd";
import { buildBreadcrumbListJsonLd } from "@/lib/seo/jsonld";
import { ContactForm, SUPPORT_EMAIL } from "@/components/contact/ContactForm";

export const CONTACT_METADATA = {
  title: "Contact BrawlRanks",
  description:
    "Contact BrawlRanks to report incorrect Brawl Stars data, suggest corrections, report technical issues, or send general feedback to an independent fan site.",
  pathname: "/contact",
} as const;

/**
 * Image sources are passed in as plain strings (set by app/contact/
 * page.tsx's static imports) rather than imported directly here — PNG
 * imports need Next.js's bundler asset loader, which the plain
 * node:test/tsx runner used by tests/contactPage.test.tsx doesn't have.
 * Same pattern as the sibling About content component.
 */
export interface ContactImageSrcs {
  iconInbox: string;
  iconCalendar: string;
  iconWarning: string;
  iconTick: string;
  iconSilentRed: string;
  iconHunters: string;
  iconSettings: string;
  iconPinBattle: string;
  character: string;
  gemGrab: string;
  gemRed: string;
}

/** Real intrinsic pixel dimensions of each PNG (read from IHDR), so next/image reserves layout space without distortion. */
const IMAGE_DIMENSIONS = {
  iconInbox: { width: 136, height: 109 },
  iconCalendar: { width: 121, height: 128 },
  iconWarning: { width: 300, height: 300 },
  iconTick: { width: 187, height: 171 },
  iconSilentRed: { width: 183, height: 195 },
  iconHunters: { width: 300, height: 300 },
  iconSettings: { width: 128, height: 138 },
  iconPinBattle: { width: 165, height: 145 },
  character: { width: 2106, height: 3435 },
  gemGrab: { width: 159, height: 171 },
  gemRed: { width: 96, height: 109 },
} as const satisfies Record<keyof ContactImageSrcs, { width: number; height: number }>;

const CARD_SHELL =
  "rounded-[8px] border-[2px] border-[#04152f] bg-[linear-gradient(150deg,rgb(7_38_98_/_0.97),rgb(5_24_67_/_0.98))] shadow-[0_3px_0_#04152f,0_10px_22px_rgb(0_0_0_/_0.2)]";

const SECTION_TITLE =
  "font-display text-[1.08rem] uppercase leading-[1.05] text-white [text-shadow:1.5px_1.5px_0_#03102b,-1px_-1px_0_#03102b,1px_-1px_0_#03102b,-1px_1px_0_#03102b]";

interface IconSpec {
  src: string;
  width: number;
  height: number;
}

function CategoryRow({ icon, title, children }: { icon: IconSpec; title: string; children: ReactNode }) {
  return (
    <li className="flex min-h-[43px] items-center gap-3 rounded-[6px] border border-[#315a9a] bg-[linear-gradient(90deg,rgb(4_21_58_/_0.96),rgb(7_34_82_/_0.92))] px-3 py-1.5">
      <span className="flex h-9 w-10 shrink-0 items-center justify-center">
        <Image
          src={icon.src}
          alt=""
          aria-hidden="true"
          width={icon.width}
          height={icon.height}
          className="max-h-9 w-9 object-contain drop-shadow-[0_2px_1px_rgb(0_0_0_/_0.45)]"
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[0.86rem] font-extrabold leading-tight text-white">{title}</span>
        <span className="mt-0.5 block text-[0.76rem] leading-tight text-[#d0dcf0]">{children}</span>
      </span>
    </li>
  );
}

function DecorBadge({ icon }: { icon: IconSpec }) {
  return (
    <span className="flex h-12 w-12 items-center justify-center">
      <Image
        src={icon.src}
        alt=""
        aria-hidden="true"
        width={icon.width}
        height={icon.height}
        className="max-h-12 w-12 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]"
      />
    </span>
  );
}

export function ContactContent({ images }: { images: ContactImageSrcs }) {
  const breadcrumbItems = [{ name: "Home", path: "/" }, { name: "Contact", path: "/contact" }];
  const icon = (key: keyof ContactImageSrcs): IconSpec => ({ src: images[key], ...IMAGE_DIMENSIONS[key] });

  return (
    <div className="contact-page">
      <JsonLd data={buildBreadcrumbListJsonLd(breadcrumbItems)} />

      <div className="contact-content mx-auto w-full max-w-[1096px] px-4 pb-6 tablet:px-5 wide:px-0">
        <header className="pb-3 pt-2 text-center">
          <h1 className="mx-auto max-w-[900px] font-display text-[2.15rem] uppercase leading-none tracking-[0.01em] text-white [text-shadow:3px_3px_0_#020918,-2px_-2px_0_#020918,2px_-2px_0_#020918,-2px_2px_0_#020918,0_8px_14px_rgb(0_0_0_/_0.28)] tablet:text-[2.75rem] desktop:text-[3.15rem]">
            Contact BrawlRanks
          </h1>
          <p className="mt-2 font-display text-[1.1rem] text-[#ffd52a] [text-shadow:1.5px_1.5px_0_#352200] tablet:text-[1.22rem]">
            We&apos;re here to help!
          </p>
          <p className="mx-auto mt-2 max-w-[620px] text-[0.9rem] font-semibold leading-[1.55] text-white [text-shadow:0_1px_2px_rgb(0_0_0_/_0.7)] tablet:text-[1rem]">
            Found incorrect data, have a suggestion, or need help? Send us a message and we&apos;ll review it as soon
            as possible.
          </p>
        </header>

        <nav aria-label="Breadcrumb" className="flex justify-center pb-3">
          <ol className="flex h-[30px] w-full max-w-[458px] items-center justify-center gap-7 rounded-[6px] border border-[#092458] bg-[rgb(5_39_101_/_0.9)] px-5">
            <li>
              <Link
                href="/"
                className="rounded-[4px] px-2 font-display text-[0.78rem] text-white hover:text-[#ffd529] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
              >
                Home
              </Link>
            </li>
            <li aria-hidden="true" className="font-display text-[1rem] text-white">
              &rsaquo;
            </li>
            <li>
              <span aria-current="page" className="font-display text-[0.78rem] text-[#ffd529]">
                Contact
              </span>
            </li>
          </ol>
        </nav>

        <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,1.62fr)_minmax(360px,1fr)]">
          <section aria-labelledby="contact-form-heading" className={`${CARD_SHELL} p-5`}>
            <div className="flex h-[42px] items-center gap-3 border-b border-[rgb(59_94_157_/_0.6)] pb-3">
              <span className="flex h-9 w-10 shrink-0 items-center justify-center rounded-[6px] border border-[#315a9a] bg-[#1585ef]">
                <Image
                  src={images.iconInbox}
                  alt=""
                  aria-hidden="true"
                  width={IMAGE_DIMENSIONS.iconInbox.width}
                  height={IMAGE_DIMENSIONS.iconInbox.height}
                  className="h-7 w-8 object-contain"
                />
              </span>
              <h2 id="contact-form-heading" className={SECTION_TITLE}>
                Send us a message
              </h2>
            </div>
            <div className="mt-3">
              <ContactForm inboxIconSrc={images.iconInbox} calendarIconSrc={images.iconCalendar} />
            </div>
          </section>

          <section aria-labelledby="contact-info-heading" className={`${CARD_SHELL} relative p-5`}>
            <Image
              src={images.character}
              alt=""
              aria-hidden="true"
              width={IMAGE_DIMENSIONS.character.width}
              height={IMAGE_DIMENSIONS.character.height}
              className="absolute left-5 top-0 h-[92px] w-auto object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)]"
            />
            <div className="flex h-[54px] items-center pl-[78px]">
              <div className="min-w-0">
                <h2 id="contact-info-heading" className={SECTION_TITLE}>
                  Other ways to reach us
                </h2>
                <p className="mt-1 text-[0.8rem] text-[#d1dcf0]">You can also email us directly at:</p>
              </div>
            </div>

            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="mt-2 flex min-h-[55px] items-center gap-4 rounded-[6px] border border-[#315a9a] bg-[linear-gradient(90deg,#1267d3,#0d4eaf)] px-4 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
            >
              <Image
                src={images.iconInbox}
                alt=""
                aria-hidden="true"
                width={IMAGE_DIMENSIONS.iconInbox.width}
                height={IMAGE_DIMENSIONS.iconInbox.height}
                className="h-9 w-10 shrink-0 object-contain"
              />
              <span className="font-display text-[0.94rem] text-[#ffd529]">{SUPPORT_EMAIL}</span>
            </a>

            <h3 className={`mt-3 border-t border-[rgb(77_111_171_/_0.65)] pt-4 ${SECTION_TITLE} text-[0.94rem]`}>
              What can you contact us about?
            </h3>
            <ul className="mt-2 space-y-1">
              <CategoryRow icon={icon("iconWarning")} title="Report wrong data">
                Found incorrect stats, tiers, rankings, or information?
              </CategoryRow>
              <CategoryRow icon={icon("iconTick")} title="Suggest correction">
                Have a correction or improvement suggestion?
              </CategoryRow>
              <CategoryRow icon={icon("iconSilentRed")} title="Copyright request">
                Copyright, asset-usage, or takedown concerns.
              </CategoryRow>
              <CategoryRow icon={icon("iconHunters")} title="Partnership">
                Business, media, or partnership inquiries.
              </CategoryRow>
              <CategoryRow icon={icon("iconSettings")} title="Technical issue">
                Bug report, website issue, or technical error.
              </CategoryRow>
              <CategoryRow icon={icon("iconPinBattle")} title="General inquiry">
                Any other question or general message.
              </CategoryRow>
            </ul>
          </section>
        </div>

        <section className="relative mt-5 flex min-h-[114px] flex-col items-center gap-5 rounded-[8px] border-[2px] border-[#04152f] bg-[linear-gradient(105deg,#0c3f9a,#071e58)] px-6 py-5 shadow-[0_3px_0_#04152f,0_9px_18px_rgb(0_0_0_/_0.22)] tablet:flex-row tablet:items-center tablet:gap-6 tablet:py-4 tablet:pl-[164px]">
          <Image
            src={images.character}
            alt=""
            aria-hidden="true"
            width={IMAGE_DIMENSIONS.character.width}
            height={IMAGE_DIMENSIONS.character.height}
            className="h-[142px] w-auto shrink-0 object-contain drop-shadow-[0_3px_1px_rgb(0_0_0_/_0.45)] tablet:absolute tablet:bottom-0 tablet:left-7"
          />
          <div className="flex-1 text-center tablet:text-left">
            <h2 className="font-display text-[1.1rem] uppercase leading-tight text-white [text-shadow:1px_1px_0_#03102b,-1px_-1px_0_#03102b,1px_-1px_0_#03102b,-1px_1px_0_#03102b] tablet:text-[1.22rem]">
              Thanks for helping us improve!
            </h2>
            <p className="mt-2 text-[0.86rem] leading-[1.45] text-white tablet:max-w-[500px]">
              Your feedback helps us keep BrawlRanks accurate, reliable, and useful for the entire community.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-4 pr-3" aria-hidden="true">
            <DecorBadge icon={icon("gemGrab")} />
            <DecorBadge icon={icon("gemRed")} />
          </div>
        </section>
      </div>
    </div>
  );
}
