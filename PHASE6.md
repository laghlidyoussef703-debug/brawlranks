# BrawlRanks — Phase 6: Public Frontend, Public API, and SEO

**Status:** Planning document for Phase 6 as a whole. **Phase 6A (Shared Frontend Foundation) and Phase 6B (Static, Legal, and Trust Pages) are COMPLETE** — see Sections 9.1 and 10 for implementation status, deviations, and validation. Phase 6C and every later subphase remain planning-only. No migration, production configuration, or secret was changed while implementing Phase 6A or Phase 6B.

---

## 1. Document Purpose

This is the authoritative implementation plan for everything after Phase 5: the public-facing BrawlRanks website, its supporting public read API surface, and the SEO/indexation layer that makes it discoverable. Phase 5 (data collection, aggregation, ranking, tiering, matchup classification, atomic publication) is complete and is not re-planned, re-scoped, or reopened here. Phase 6 turns that production-valid backend into a real, indexable, trustworthy public website — nothing more, nothing less. No fake content, no placeholder data, and no admin dashboard appear anywhere in this plan.

## 2. Authority and Source-of-Truth Hierarchy

1. **`BRAWLRANKS_WEBSITE_SPEC.md`** — the technical and product source of truth for every page, schema table, SEO rule, and quality gate. Cited by section number throughout this document (principally Sections 16–17, 24–26, 31–41, 43–44).
2. **Confirmed product decisions made in this repository's session history**, which supersede the spec only where they explicitly conflict:
   - No admin dashboard, ever (supersedes spec Section 27/43 dev-order steps 18–19).
   - No recurring manual publishing/editorial workflow — automation wherever realistically possible (supersedes any spec passage that assumes a human-in-the-loop step, except the one narrow, spec-mandated exception discussed in Section 19 of this document: guides, per spec Section 12.6).
3. **`PHASE2.md` / `PHASE3.md` / `PHASE4.md`** — implementation logs for the backend phases; read for continuity, not re-implemented.
4. **This document (`PHASE6.md`)** — authoritative for Phase 6 only, subordinate to items 1–2 above. Where this document recommends something the spec leaves as an owner decision (e.g., exact metadata copy), that recommendation is marked as such, not presented as a spec quotation.

Where the spec and repository practice do not conflict, no reconciliation is needed and none is manufactured here.

## 3. Confirmed Phase 1–5 Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Hostinger/Next.js infrastructure proof-of-concept | Completed |
| 2 | Production DB schema, canonical Brawler catalog, change detection | Completed |
| 3 | Official API ingestion: rankings/player/club/battle-log, dedup, retries, budgets | Completed |
| 4 | Sampling fairness, region/bracket diversity, cadence, retention, coverage reporting | Completed |
| 5 (5.1 patch tracking, 5.2 aggregation, 5.3 ranking/publication) | Statistical aggregation, ranking calculation, tiering, matchup classification, atomic publication, `/api/public/tier-list` | **Completed — production validated** |

`held_mass_movement` ranking outcomes are the intentional `>25%` tier-move safety guard (`lib/ranking/formulas.ts#exceedsMassMovementGuard`) operating as designed. Not a defect. Not reopened. Not re-implemented in this document.

## 4. Phase 6 Mission

Phase 6 is **not** a styling pass on top of a finished product. It is the complete transition from a production-valid, backend-only data pipeline to a usable, indexable, trustworthy public website. It contains, in one mixed phase: frontend architecture, responsive UX/UI, live public-data integration, a deliberately small set of additional public read APIs, static/legal content, asset integration, metadata, structured data, SEO, analytics, accessibility, performance, QA, and production launch readiness. Every one of these is in scope; none is deferred to an unstated "Phase 7."

## 5. Current Repository Audit

| Area | Current state | Evidence |
|---|---|---|
| Public routes under `app/` | Only `/` (placeholder scaffold) and `app/api/**` | `find app -type f` shows exactly `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, plus API route files |
| Public API | Exactly one: `GET /api/public/tier-list` (unauthenticated by design) | `app/api/public/tier-list/route.ts` |
| Internal cron/test API | 15 protected routes (`INTERNAL_CRON_SECRET`), not for frontend use | `app/api/internal/**` |
| Database | 25 migrations applied (0001–0025), full aggregation/ranking/publication schema live | `migrations/*.sql` |
| `lib/` modules | `auth`, `catalog`, `ingestion`, `patches`, `aggregation`, `ranking`, `publishedSnapshots`, `workflow`, `mysql`, `proxy`, `errors`, `hash`, `dbConcurrency` — no `seo/`, no `components/`, no frontend data layer of any kind | `find lib -maxdepth 1` |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss` v4.3.2), CSS-first config (`@import "tailwindcss"` in `app/globals.css`, no `tailwind.config.*` file), PostCSS present | `package.json`, `app/globals.css`, `postcss.config.mjs` |
| Framework | Next.js 16.2.10, React 19, TypeScript 5.9 | `package.json` |
| Root layout | `robots: {index:false, follow:false}` — the entire site is currently noindexed | `app/layout.tsx` |
| Environment variables | `DB_*`, `DIGITALOCEAN_PROXY_URL`, `PROXY_SHARED_SECRET`, `INTERNAL_CRON_SECRET` only. No `NEXT_PUBLIC_SITE_URL`, no `APP_ENV`, no `AUTH_SECRET`, no `AI_PROVIDER_API_KEY`, no `MONITORING_ALERT_WEBHOOK` | `.env.example` |
| Tests | 33 test files, 305+ cases, all backend (aggregation/ranking/ingestion/migrations); zero frontend/component/route-rendering tests | `tests/*.test.ts`, `package.json` `test` script |
| Existing roadmap docs | `PHASE2.md`, `PHASE3.md`, `PHASE4.md` exist; no `PHASE5.md` was ever written (a documentation gap, not a functional one) | `find . -maxdepth 1 -iname "*.md"` |

## 6. Asset Inventory

### 6.1 Logo

| File | Format | Dimensions | Alpha channel | Notes |
|---|---|---|---|---|
| `logo/logo.png` | PNG | 1536 × 1024 | Yes (RGBA) | Single file, ~2.0 MB. This is the **official BrawlRanks website logo** for this project — not to be redesigned or replaced. |

**Missing variants (must be derived from this one source file during Phase 6A, not invented):**
- No separate square/icon-only crop for favicon/app-icon use (1536×1024 is a wide/landscape wordmark-style ratio, not a 1:1 mark).
- No pre-sized small (header, ~32–40px height) or large (OG image, 1200×630) exports.
- No explicit light-background vs. dark-background variant confirmed — must be visually verified against both the light and dark presentation before assuming it works on both (Section 20 of this document, WCAG contrast).
- No SVG/vector source — only a rasterized PNG, meaning every derived size must be a re-export from this same 1536×1024 master, not a redraw.

**Recommended usage:**

| Context | Recommended treatment |
|---|---|
| Header (desktop/tablet) | Cropped/scaled wordmark, fixed height (~32–40px), `next/image` with explicit width/height to prevent CLS |
| Header (mobile) | Same asset, smaller fixed height, or icon-only crop if the full wordmark doesn't fit the mobile header safely |
| Footer | Small, deprioritized placement, or omitted in favor of the text wordmark if the footer is already link-dense (Section 17.2) |
| Favicon | **Blocked until a square 1:1 crop is produced** — a 1536×1024 image cannot serve directly as a 32×32/180×180 favicon/apple-touch-icon without cropping, and that crop must preserve legibility at tiny sizes; this is a design task, not an automated resize |
| Open Graph image | The 1536×1024 source is close to a usable OG ratio but not exact (OG's canonical ratio is 1200×630, ~1.91:1; this file is 1.5:1) — needs a dedicated OG-ratio export, not a stretch/crop of convenience |
| Mobile navigation (hamburger panel) | Same header treatment, or omitted in a space-constrained slide-in panel per Section 17.2's mobile-menu rules |
| Structured branding (`Organization` JSON-LD `logo` field, Section 16) | Requires a stable, absolute, publicly-reachable URL once hosted under `/public` — the raw 1536×1024 PNG is usable here directly once optimized |

**Recommended file naming/organization (for Phase 6A to establish, not created in this pass):**
```
public/brand/
  logo-wordmark.png       (source-derived, optimized)
  logo-wordmark.svg       (if a vector re-trace is ever produced — not assumed to exist)
  icon-512.png            (square crop, app icon base)
  icon-192.png
  favicon.ico             (multi-size ICO, derived from icon-512)
  apple-touch-icon.png    (180x180, derived from icon-512)
  og-default.png          (1200x630, derived/composited from logo.png)
```

### 6.2 Fonts

**Correction (this pass):** the `font/` directory was re-audited directly (`file`, exact byte sizes, and a `fontTools`-based read of each file's `name`/`OS-2`/`head`/`cmap`/`fvar` tables). The prior version of this document stated the directory contained only PNG specimen strips and that no usable web font existed. **That finding is now outdated and incorrect.** The directory has been corrected upstream and now contains 6 real font-program files. Every statement in the rest of this document that assumed "no local font exists" or "Phase 6A must use a temporary Google/system fallback because no font exists" is superseded by this section.

**Exact current contents of `font/`:**

| # | Exact filename | Format | File size |
|---|---|---|---|
| 1 | `KoBrawl Gothic40.otf` | OpenType (OTF) | 950,244 bytes |
| 2 | `KoBrawl Gothic60.otf` | OpenType (OTF) | 912,976 bytes |
| 3 | `NotoSansCJKjp-Black (1).otf` | OpenType (OTF) | 17,339,212 bytes |
| 4 | `NotoSansCJKjp-Regular (1).otf` | OpenType (OTF) | 16,427,228 bytes |
| 5 | `lilitaone-regular-webfont (2).ttf` | TrueType (TTF) | 47,952 bytes |
| 6 | `nougat-extrablack-webfont (2).ttf` | TrueType (TTF) | 33,284 bytes |

No PNG files remain in `font/`; no `.woff`/`.woff2` exists yet (only OTF/TTF source formats are present — a WOFF2 conversion recommendation is given below).

**Per-font metadata (read directly from each file's embedded `name`, `OS/2`, `head`, and `cmap` tables — not inferred from filenames):**

| Field | KoBrawl Gothic40 | KoBrawl Gothic60 | Noto Sans CJK JP Black | Noto Sans CJK JP Regular | Lilita One | Nougat ExtraBlack |
|---|---|---|---|---|---|---|
| Family (name ID 1) | KoBrawl Gothic | KoBrawl Gothic | Noto Sans CJK JP Black | Noto Sans CJK JP Regular | Lilita One | Nougat |
| Subfamily/style (name ID 2) | 40 | 60 | Regular (style) | Regular | Regular | Regular |
| PostScript name | KoBrawlGothic40 | KoBrawlGothic60 | NotoSansCJKjp-Black | NotoSansCJKjp-Regular | LilitaOne | Nougat-ExtraBlack |
| `OS/2.usWeightClass` | 500 (Medium) | 900 (Black) | 900 (Black) | 400 (Regular) | 400 (Regular) | 1000 (Extra-Black, non-standard) |
| Variable font (`fvar` table present)? | No — static | No — static | No — static | No — static | No — static | No — static |
| `unitsPerEm` | 1000 | 1000 | 1000 | 1000 | 2048 | 2048 |
| Glyph count (`cmap`, best table) | 3,698 (8,700 total glyphs in font) | 3,698 (8,700 total) | 44,683 (65,535 total) | 44,683 (65,535 total) | 229 (231 total) | 238 (241 total) |
| Latin A–Z coverage | Yes | Yes | Yes | Yes | Yes | Yes |
| CJK Unified Ideographs | **No** | **No** | **Yes** | **Yes** | No | No |
| Hiragana / Katakana | Yes / Yes | Yes / Yes | Yes / Yes | Yes / Yes | No / No | No / No |
| Manufacturer (name ID 8) | JOONFONT | JOONFONT | Adobe Systems Incorporated | Adobe Systems Incorporated | Juan Montoreano | *(not set)* |
| Designer (name ID 9) | Sung Joon Seok | Sung Joon Seok | Ryoko Nishizuka et al. (Google Noto team) | Ryoko Nishizuka et al. | Juan Montoreano | *(not set)* |
| Embedded license text (name ID 13) | `"KoBrawl Gothic40 is a trademark of JOONFONT."` + `"JOONFONT"` license field | Same, "KoBrawl Gothic60" | SIL Open Font License, Version 1.1 (full OFL disclaimer text embedded) | SIL Open Font License, Version 1.1 | SIL Open Font License, Version 1.1 | *(not set — no license text embedded at all)* |
| License URL (name ID 14) | `http://www.joonfont.com/license` | Same | `http://scripts.sil.org/OFL` | `http://scripts.sil.org/OFL` | `http://scripts.sil.org/OFL` | *(not set)* |
| `OS/2.fsType` (embedding permission bitmask) | **4 — Restricted License embedding** | **4 — Restricted License embedding** | 0 — no restriction (Installable) | 0 — no restriction (Installable) | 4 — Restricted License embedding (see caveat below) | **4 — Restricted License embedding** |

**Glyph/language coverage, stated plainly:** the two `KoBrawl Gothic` weights and both `Noto Sans CJK JP` weights all include Latin + Hiragana + Katakana; only the two `Noto Sans CJK JP` files additionally cover full CJK Unified Ideographs (~44,683 mapped codepoints). `Lilita One` and `Nougat ExtraBlack` are Latin-only, small-glyph-set (229–241 glyphs) display faces — consistent with single-weight, headline-only typefaces, not body-copy faces.

**Licensing classification (per file, evidence-grounded — no font is assumed commercially usable merely because the file exists):**

| File | Classification | Reasoning |
|---|---|---|
| `KoBrawl Gothic40.otf` | **Should not be used until verified** | Embedded license field names a commercial foundry ("JOONFONT") with a license URL, and `OS/2.fsType = 4` ("Restricted License embedding") — this bit means the font's own metadata explicitly states it must not be embedded/exchanged without the rights holder's permission. The family name ("KoBrawl") closely mirrors "Brawl Stars," which raises the specific possibility that this is a font licensed to Supercell for in-game/brand use rather than a font BrawlRanks (an unaffiliated fan site) holds any license to redistribute. No license file, README, or attribution document exists anywhere in this repository to establish that a redistribution/web-embedding license was ever obtained. **Blocker: requires explicit confirmation of a valid embedding license from JOONFONT (or from whoever supplied this file) before any use.** |
| `KoBrawl Gothic60.otf` | **Should not be used until verified** | Same reasoning as `KoBrawl Gothic40.otf` — same foundry, same license field, same `fsType = 4` restriction. |
| `NotoSansCJKjp-Black (1).otf` | **Licensing verified** | Full SIL Open Font License 1.1 text embedded in the font's own `name` table (ID 13/14), `OS/2.fsType = 0` (no embedding restriction). Noto Sans CJK is a well-established, unambiguously open (OFL) Google/Adobe font family. Safe to embed, subset, and modify under OFL terms. |
| `NotoSansCJKjp-Regular (1).otf` | **Licensing verified** | Same reasoning — SIL OFL 1.1, `fsType = 0`. |
| `lilitaone-regular-webfont (2).ttf` | **Licensing verified, with one caveat noted** | Full SIL OFL 1.1 license text is embedded directly in the font's own `name` table, and "Lilita One" is a well-known, publicly cataloged Google Fonts family under OFL. The one inconsistency worth flagging: this specific binary's `OS/2.fsType` bit is set to `4` (Restricted), which conflicts with the OFL grant embedded in the same file — a known artifact of some older Font Squirrel–style "webfont kit" conversions, where the `fsType` bit was not correctly cleared during conversion. The license *text*, not the `fsType` bit, is the authoritative grant under OFL practice. **Recommendation:** before shipping, either (a) re-download the canonical copy directly from Google Fonts (same family, cleanly generated `fsType`) as a lower-risk substitute for this exact binary, or (b) proceed with this file but keep the embedded OFL license text as the documented justification if flagged during any future audit. |
| `nougat-extrablack-webfont (2).ttf` | **Licensing unknown — should not be used until verified** | No license text, no manufacturer, no designer, and no trademark field are set anywhere in the font's metadata — the license fields are simply empty. `OS/2.fsType = 4` (Restricted License embedding) is set. The `-webfont` filename suffix is the naming convention produced by commercial web-font conversion services (e.g., Font Squirrel's "webfont generator," Fontspring, MyFonts kits) when a font is purchased and converted for one licensee's specific domain — this pattern is consistent with "Nougat" being a paid commercial display face, not a free one. **Blocker: requires locating the original purchase/license record (or an explicit confirmation from whoever added this file) establishing the licensed domain and permitted use before this font is embedded anywhere.** |

**No license file, README, copyright notice, attribution notice, Fan Kit documentation, or source-URL reference exists anywhere in this repository** (`font/` directory and repository root both checked directly; `README.md` contains no mention of fonts). The font files' own embedded metadata (above) is the *only* licensing evidence available in this repository — for `KoBrawl Gothic40/60` and `Nougat ExtraBlack`, that evidence is either explicitly restrictive or entirely absent, and neither condition is resolved by the file simply being present in the repository.

**No font file was shared, duplicated, redistributed, modified, or converted as part of this task.**

**Provisional font architecture (based on verified metadata only — no role is assigned by filename alone):**

| Role | Candidate | Status | Basis for the role assignment |
|---|---|---|---|
| Primary display/heading | `Lilita One` | **Usable now** (licensing verified) | Single static weight (400), small glyph set (231), Latin-only — structurally a display/headline face, not a body face; OFL-licensed, matches the "playful, rounded mobile-game" visual register the site's approved UX direction (Section 6.3) calls for |
| Secondary display / hero-accent / navigation weight | `KoBrawl Gothic60` (Black, weight 900) | **Blocked — pending licensing approval** | Heaviest available weight in the KoBrawl Gothic family, structurally suited to large display text, but embedding is not permitted under its current `fsType`/license metadata until JOONFONT (or the file's true rights holder) confirms an embedding license |
| Statistics / numeric emphasis (tier scores, trophy counts) | *No verified-license candidate currently exists* | **Gap — not assigned** | `KoBrawl Gothic40` (Medium, 500) would structurally fit this role but is equally licensing-blocked; `Nougat ExtraBlack` is licensing-unknown. Recommend using the eventual body font's tabular-figure feature (`font-variant-numeric: tabular-nums`) instead of a dedicated numeric face until one of the blocked fonts clears review, or a new verified-license face is sourced |
| Body copy | *No verified-license candidate currently exists* | **Gap — not assigned** | None of the 6 files is a body-text face: `KoBrawl Gothic`/`Lilita One`/`Nougat` are all single-weight display faces (small glyph counts, no italic, no weight family), and `Noto Sans CJK JP` — while a genuine multi-weight, full-coverage sans — is an oversized (16–17MB) CJK-superset file, not an efficient choice to load for ordinary Latin body text. Recommend sourcing a dedicated, verified-open body sans (e.g., a standard OFL/Apache-licensed workhorse family) as a Phase 6A follow-up, or using `next/font/google` for body text only in the interim while `Lilita One` handles headings locally |
| CJK fallback | `Noto Sans CJK JP Regular` (body-weight fallback) and `Noto Sans CJK JP Black` (display-weight fallback, if ever needed) | **Usable now** (licensing verified), but must be subsetted/lazy-loaded, never shipped in full | Full CJK Unified Ideographs + Hiragana + Katakana + Latin coverage, SIL OFL 1.1 — the correct fallback for any incidental Japanese-language user-generated content (e.g., club/player names, which the spec confirms are real, uncontrolled input) without forcing every visitor to download 16–17MB |

**`next/font/local` loadability:** all 6 files are in a format `next/font/local` can technically load (it accepts `.ttf`/`.otf`/`.woff`/`.woff2` source files) — format is not the blocker for any of them. The blocker for 3 of the 6 (`KoBrawl Gothic40.otf`, `KoBrawl Gothic60.otf`, `nougat-extrablack-webfont (2).ttf`) is **licensing**, not technical loadability. No font is wired into `next/font/local` in this document — that remains Phase 6A implementation work, gated on the licensing approvals above.

**WOFF2 conversion:** recommended for every font once its licensing is cleared (all 6, if the 3 blocked ones are eventually approved) — OTF/TTF are uncompressed relative to WOFF2, and WOFF2's built-in compression meaningfully reduces transfer size, which matters most for the two 16–17MB Noto Sans CJK files. The original `.otf`/`.ttf` files should remain in the repository as **source-only** (not served to the browser); only the converted, subsetted `.woff2` output should ship under `public/fonts/`. **No conversion was performed in this task.**

**Preload strategy:** preload only the primary display font's Latin subset (`Lilita One`) via `next/font/local`'s default automatic preload behavior, since it is used above the fold on every page (headings). Do **not** preload either `Noto Sans CJK JP` file — pass `preload: false` and load it only when real CJK text is actually present on the page, given its size.

**`font-display` strategy:** `swap` for the display/body faces (avoids invisible text while the local font loads, acceptable brief reflow given `next/font/local`'s automatic fallback-metric matching below); `swap` also for the CJK fallback font, applied narrowly since it only loads when CJK content is present.

**Fallback stack and CLS mitigation:** rely on `next/font/local`'s built-in automatic fallback-metric calculation (`ascent-override`/`descent-override`/`line-gap-override`/`size-adjust`, derived directly from each real font file) rather than hand-tuning these values — this is a standard, already-built Next.js feature that matches a system fallback font's box metrics to the real font's, minimizing layout shift on swap. Recommended fallback chains: display/heading (`Lilita One` → `ui-rounded, system-ui, sans-serif`); body copy (once sourced → `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`); CJK fallback (`Noto Sans CJK JP` → `"Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif` before the real font finishes loading).

**Net consequence for Phase 6:** Phase 6A **can now use verified local fonts** — `Lilita One` for display/headings and `Noto Sans CJK JP Regular`/`Black` for CJK fallback are both licensing-clear today. A dedicated body-copy font and the "statistics/numeric" role both remain open gaps (no verified-license candidate exists for either yet), and `KoBrawl Gothic40`/`KoBrawl Gothic60`/`Nougat ExtraBlack` remain **blocked pending licensing confirmation** — they must not be wired into `next/font/local` until that confirmation exists. Every reference elsewhere in this document to "no usable font exists" or "use a temporary Google/system fallback because no font exists" is corrected by this section; the only remaining fallback-to-`next/font/google` scenario is the still-open **body-copy** gap, not the font directory as a whole.

### 6.3 UX/UI Reference Pages

10 PNG mockups in `reference_pages/`, confirmed as the **approved visual direction** — Phase 6 must preserve this direction, not redesign from scratch.

**UX Reference Matrix**

| Reference file | Target route | Viewport (inferred from filename/context) | Major sections (to be confirmed against the actual image at build time) | Reusable components | Live data required | Missing assets | Unresolved UX decisions | Phase 6 subphase |
|---|---|---|---|---|---|---|---|---|
| `home.png` | `/` | Not confirmed (single static image; desktop-vs-mobile not verifiable from filename alone) | Hero, tier preview, top Brawlers, mode highlights, guides/updates teasers (per spec Section 17.3's section list) | `Hero`, `BrawlerCard`, `TierGroup` (condensed), `ModeCard`, `PatchBadge` | Overall snapshot summary, latest patch | Brawler portraits, mode icons (Section 6.4) | Exact carousel vs. grid behavior at each breakpoint; whether guides/updates teasers appear given those systems don't exist yet (Section 16 of this doc) | 6F |
| `tier_list.png` | `/tier-list` | Not confirmed | Tier bands S–D, filter bar, per-entry card | `TierGroup`, `BrawlerCard`, `FilterBar`, `TierBadge`, `ConfidenceBadge` | Full current snapshot | Brawler portraits, rarity/class icons | Exact filter-chip set (rarity/class values aren't in the current schema — Section 7) | 6C |
| `meta.png` | `/meta` | Not confirmed | Patch summary narrative, movement list | `MovementBadge`, `PatchBadge` | Tier-movement deltas | AI-generated narrative text (not available — Section 19) | Whether the page ships with a data-only version (deltas, no prose) or waits for an AI provider decision | 6C |
| `best brawl.png` (Best Brawlers) | `/best-brawlers` | Not confirmed | Goal-based recommendation rows | `BrawlerCard` (compact) | Snapshot filtered by `recommendation_tag` | `recommendation_tag` concept does not exist anywhere in the current schema (Section 7) | Whether to ship a simplified "top by tier" substitute or defer goal-based filtering | 6C |
| `brawlers details.png` | `/brawlers/[slug]` | Not confirmed | Identity header, tier/score/confidence, counters/strong-against | `TierBadge`, `ConfidenceBadge`, `MatchupCard`, `RankingReason` | Per-Brawler ranking + matchup data | Portrait, rarity, class, description (none exist — Section 7); ranking reason prose (Section 19) | How the page reads with only tier/score/confidence/counters and no identity/prose fields | 6C/6D |
| `brawlrs.png` (Brawler directory) | `/brawlers` | Not confirmed | Grid/list of all Brawlers with tier badges | `BrawlerCard`, `FilterBar` | Roster + current tier badges | Portrait, rarity, class (Section 7) | Whether the directory ships with name+tier only until identity fields exist | 6C |
| `game modes.png` | `/game-modes` | Not confirmed | Mode grid with top-Brawler previews | `ModeCard` | Mode list + per-mode top entries | Mode icon images (Section 7) | — | 6E |
| `game modes details.png` | `/game-modes/[slug]` | Not confirmed | Mode-scoped tier list | `TierGroup`, `BrawlerCard` | Mode-scoped snapshot (currently nested per-Brawler, not queryable per-mode — Section 13) | Mode icon, map images | Requires a new endpoint (Section 13) before this can render mode-scoped data server-side | 6E |
| `builds hub.png` | `/builds` | Not confirmed | Build cards | `BuildCard` | Build/usage data | **No build data source exists anywhere in this repository** (Section 16H) | Entire page is data-blocked, not just asset-blocked | 6H |
| `counters hub.png` | `/counters` | Not confirmed | Matchup lookup/list | `MatchupCard` | `published_matchup_items` | Brawler portraits | Lookup UX (search-by-Brawler vs. browse-all) not specified by the reference alone | 6E |

**Cross-reference observations:**
- **Shared patterns across references** that should be standardized as single components rather than re-implemented per page: the tier badge (S/A/B/C/D pill with color), the confidence indicator, the Brawler card (portrait + name + tier + score), and the patch/last-updated row. These map directly to spec Section 17.31's `TierBadge`, `ConfidenceBadge`, `BrawlerCard`, `PatchBadge`, `LastUpdated` — confirming the mockups and the spec's component inventory already agree; Phase 6A should build to the spec's component contracts, using the mockups for visual styling only.
- **Missing states not shown in any reference** (expected — mockups show the happy path): loading, empty, error, stale-data, and unavailable-data states appear in none of the 10 images. These must be designed during Phase 6A component work, styled consistently with the approved direction, not invented ad hoc per page.
- **Accessibility considerations not verifiable from static images:** color contrast of tier-band colors, focus-state styling, and touch-target sizing cannot be confirmed from a mockup alone — must be verified against Section 20's WCAG 2.2 AA target during implementation, not assumed compliant because "the design looks fine."
- **Visual inconsistency risk:** because each reference is a separate static export, minor inconsistencies (spacing, card corner radius, badge shape) between mockups are likely and should be resolved once, in Phase 6A's design tokens, rather than replicated per page. Standardize spacing/radius/shadow scale globally in Phase 6A (Section 9) rather than matching each mockup's minor pixel differences literally.
- **Global standardization decision:** treat the mockups as the **information architecture and visual language** (what sections exist, what a Brawler card looks like, tier color coding) rather than pixel-exact specifications — consistent with how spec Section 17 itself specifies structure and content precisely while leaving exact visual polish as an implementation detail.

### 6.4 Brawl Stars Image and Media Strategy

**Correction (this pass):** the prior version of this section stopped at "this repository doesn't capture image fields" without separately answering whether the *official API itself* returns image data. This section now separates those two questions explicitly, per a full re-investigation: (A) official API primary-source evidence, (B) real stored/raw payload evidence, (C) a per-media-type evidence matrix, and (D) an outcome classification for each media type. **No asset was downloaded, no image file was created or modified, and no font/image was converted as part of this investigation.**

#### A. Official API documentation evidence

`developer.brawlstars.com` (the official Supercell developer portal) was fetched directly in this session via `WebFetch`. The page is a JavaScript-rendered single-page application (Swagger-UI-style); `WebFetch` converts server-delivered HTML to text and returned only the page title ("Brawl Stars API") with no schema content — the actual endpoint/response-schema documentation is rendered client-side and was not retrievable this way. No swagger.json/openapi.json was found at the URL patterns tried. **Conclusion: primary official documentation was not accessible in this session.** This is not evidence of absence — it means the question is unresolved from this source, not answered "no."

Web search was used to gather **secondary** evidence (independent third-party API wrapper libraries that document the official API's real response shape, built by developers who query the live official endpoints — distinct from community content-aggregator APIs). This surfaced two different evidentiary situations that must not be conflated:

- **Contaminated evidence (must be discarded):** one search result describing brawler `imageUrl`, `imageUrl2`, `imageUrl3`, `class {id, name}`, and `rarity {id, name, color}` fields traces directly to **BrawlAPI (`brawlapi.com`)** — a confirmed third-party community content-aggregator that hosts its own independently-built asset database, not the official Supercell API. Per this task's explicit instruction, community APIs are not valid evidence of what the official API returns. **This finding is explicitly rejected as evidence for this document.** It does, however, corroborate that a well-known *community* source already exists for exactly this data, which is directly relevant to the Fan Kit / alternative-source strategy below.
- **Secondary-but-independent evidence (weaker than primary, stronger than a single community aggregator):** multiple, mutually independent third-party wrapper libraries that describe themselves as clients for the *official* Supercell API — `Nick-Gabe/brawlstars-api` (GitHub), `mlieshoff/brawljars` ("Java Wrapper for Official Supercell Brawl Stars API"), `brawlstats` (Python, PyPI), `pollen5/brawlstars-go` — consistently describe a numeric `icon.id` field on the player object and a numeric `badgeId` field on the club object. None of these independent sources claims a `badgeUrl`/`iconUrl` string exists for either — every source that mentions these fields describes them as bare IDs. This is the same evidentiary tier Phase 3's own `lib/ingestion/schemas.ts` header comment already used and explicitly distinguished from "verified against a live authenticated call" — so it is treated here with the same caution, not upgraded to a confirmed fact.

#### B. Real stored/raw payload evidence

The repository does have a real mechanism for capturing full, unmodified official API responses: **`raw_api_snapshots`** (migration `0004_create_raw_snapshot_storage.sql`), an append-only table whose `payload` column stores the complete raw JSON exactly as forwarded by the DigitalOcean proxy, keyed by `endpoint_category` (`brawlers_catalog`, `player_profile`, `club_profile`, `battle_log`, `player_rankings`, `club_rankings`, `brawler_rankings`, and a defined-but-unused `events_rotation`). `lib/catalog/repository.ts#insertRawSnapshot` confirms every sync module writes the full payload here before any validation/normalization occurs — this table is the actual ground-truth source for this question.

- **No copy of this data exists anywhere in the local filesystem** — confirmed by searching for fixtures, test data, and any stored JSON resembling a captured API response; none exists (only generic, unrelated fixtures inside the unrelated `claude-seo-skills-repos/` tree).
- **This session has no database credentials configured** (`.env.example`'s `DB_HOST`/`DB_NAME`/`DB_USER`/`BRAWL_DB_SECRET_V1` are all empty in this environment) — so `raw_api_snapshots` could not be queried this session, and per this task's explicit instruction, no attempt was made to connect to production.
- **Safe read-only inspection plan (proposed, not executed):** if a future session has authorized, read-only production DB access, the following queries would directly answer this section's open questions without any risk to the append-only table:

```sql
-- One most-recent raw brawler-catalog payload (inspect for image/icon/rarity/class fields)
SELECT payload FROM raw_api_snapshots
WHERE endpoint_category = 'brawlers_catalog'
ORDER BY received_at DESC LIMIT 1;

-- One most-recent raw player-profile payload (inspect for an `icon` field)
SELECT payload FROM raw_api_snapshots
WHERE endpoint_category = 'player_profile'
ORDER BY received_at DESC LIMIT 1;

-- One most-recent raw club-profile payload (inspect for a `badgeId` field)
SELECT payload FROM raw_api_snapshots
WHERE endpoint_category = 'club_profile'
ORDER BY received_at DESC LIMIT 1;

-- One most-recent raw battle-log payload (inspect the nested `event` object for mode/map image data)
SELECT payload FROM raw_api_snapshots
WHERE endpoint_category = 'battle_log'
ORDER BY received_at DESC LIMIT 1;
```

This plan is a `SELECT`-only read against an append-only table (no `UPDATE`/`DELETE`/`INSERT`), matches the read-only spirit of every existing internal diagnostic route in this repository, and should be run manually by someone with authorized production credentials — any player tags or club tags present in the returned payload should be redacted before the result is shared or pasted anywhere outside a secure environment, consistent with spec Section 7.20's PII-minimization rule. **This plan is not executed in this task**, per the explicit instruction not to connect to production without authorization.

#### C. Image-Field Evidence Matrix

| Entity/media type | Official endpoint | Exact raw field, if found | Official documentation evidence | Real payload evidence | Captured by validator? | Persisted in DB? | Normalized? | Publicly exposed? | Usable directly by frontend? | Licensing/hosting considerations | Recommended source | Fallback source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Brawler portrait | `GET /v1/brawlers` | **Not yet verified.** The only field name found (`imageUrl`) traces to BrawlAPI, a community aggregator explicitly disqualified as evidence (Section A) | Not obtained (SPA, Section A) | None locally; `raw_api_snapshots.payload` (`endpoint_category='brawlers_catalog'`) unqueried this session (Section B) | No (`lib/catalog/schema.ts`'s `RawBrawlerItem` = `{id, name, starPowers, gadgets}` only) | No (migration 0006 deliberately excludes image columns) | No | No | No | Would require third-party hosting/attribution regardless of source | Supercell Fan Kit (pending the Section B verification step) | Generic silhouette placeholder |
| Brawler icon | `GET /v1/brawlers` | Not yet verified — same disqualified evidence as portrait | Not obtained | Same as above | No | No | No | No | No | Same | Fan Kit | Generic silhouette placeholder |
| Gadget icon | `GET /v1/brawlers` (nested `gadgets[]`) | Not yet verified | Not obtained | Same | No — `RawGadgetOrStarPower = {id, name}` only | No | No | No | No | Same | Fan Kit | Generic item-icon placeholder |
| Star Power icon | `GET /v1/brawlers` (nested `starPowers[]`) | Not yet verified | Not obtained | Same | No — same `{id, name}`-only shape | No | No | No | No | Same | Fan Kit | Generic item-icon placeholder |
| Gear icon | `GET /v1/brawlers` (presumed nested field) | Not yet verified — **and more fundamentally, this repository's validator does not model a `gears` field at all** (only `starPowers`/`gadgets` are extracted); gear *identity* data, not just gear images, is unconfirmed in this codebase | Not obtained | Same | No | No | No | No | No | Same | Fan Kit | Generic item-icon placeholder |
| Game mode icon | No dedicated official game-modes/events endpoint is integrated; mode identity is derived from the nested `event.mode` string inside `GET /v1/players/{tag}/battlelog` | Not applicable to icons — `event.mode` is validated as a plain string (`lib/ingestion/schemas.ts#validateBattleItem`), not an image reference | Not obtained | None locally; `raw_api_snapshots` (`endpoint_category='battle_log'`) unqueried | No | No (`canonical_game_modes` has no image column, migration 0010) | No | No | No | Same | Fan Kit | Generic mode-placeholder icon |
| Map image | Same as game mode (derived from nested `event.map` string) | Not applicable — `event.map` is a plain string | Not obtained | Same | No | No (`canonical_maps` has no image column) | No | No | No | Same | Fan Kit | Generic map-placeholder image |
| Club badge | `GET /v1/clubs/{tag}` | **Not yet verified**, but with stronger secondary evidence than the brawler-image rows: multiple independent official-API wrapper libraries (not a community aggregator) consistently report a numeric `badgeId` field — none reports a `badgeUrl`/image string (Section A) | Not obtained | None locally; `raw_api_snapshots` (`endpoint_category='club_profile'`) unqueried | No — `validateClubPayload` extracts tag/name/description/type/trophies/requiredTrophies/members only, no `badgeId` | No (`normalized_clubs`, migration 0013, has no badge/icon column) | No | No | No | If real, appears to be an ID requiring a separate lookup, not a hotlinkable URL | Fan Kit (club badges are a defined, catalogable Fan Kit asset set) | Generic badge placeholder |
| Player icon | `GET /v1/players/{tag}` | **Not yet verified**, same secondary-evidence tier as club badge: independent wrapper libraries consistently report `icon.id`, never an `iconUrl` string | Not obtained | None locally; `raw_api_snapshots` (`endpoint_category='player_profile'`) unqueried | No — `validatePlayerPayload` extracts tag/name/nameColor/trophies/highestTrophies/expLevel/clubTag only | No (`normalized_players`, migration 0013, has no icon column) | No | No | No | **Not needed regardless of outcome** — player-level pages are out of scope for the entire Phase 6 MVP (spec Section 7.20/7.25's PII-minimization boundary), so this field has no planned consumer even if confirmed | Not applicable — no planned use | Not applicable |
| Event image | No dedicated official endpoint integrated; `EVENTS_ROTATION`/`events_rotation` is a defined `lib/ingestion/config.ts` constant with **zero real usage anywhere** (confirmed via repository-wide search — no sync module ever writes a raw snapshot under this category) | Not applicable — the category is reserved but unimplemented | Not obtained | None — this category has never been fetched, so no raw payload could exist for it even in production | No | No | No | No | No | Same | Fan Kit, or omit event-specific imagery from Phase 6 scope entirely (matches Section 13's existing "no event-rotation UI" finding) | Generic placeholder, or omit |

#### D. Required conclusions, by outcome

Every media type in the matrix above resolves to **Outcome 4 — not yet verified** at the primary-source level. Within that, two distinct sub-situations exist and must not be blurred together:

- **Brawler portrait/icon, gadget icon, star power icon, gear icon, game mode icon, map image, event image:** Outcome 4, with no credible field-name evidence at all (the one field name that surfaced for brawler images is disqualified community-aggregator evidence, Section A). **Next safe verification step:** run the Section B read-only query against `raw_api_snapshots` (`endpoint_category = 'brawlers_catalog'` and `'battle_log'`) once authorized production DB access exists, and separately attempt to obtain the real, authenticated developer.brawlstars.com schema (requires a logged-in Supercell developer account — the public page's JS-rendered Swagger UI could not be read by the tooling available this session).
- **Club badge, player icon:** Outcome 4 formally, but leaning toward an **Outcome-2 shape** (an asset ID, not a URL) if it is eventually confirmed — every independent secondary source found describes an ID field (`badgeId`, `icon.id`), and none describes a URL field, for these two specifically. **Per this task's binding rule, this leaning is not converted into a "Yes."** If a future verification step confirms an ID-only field: **no official URL-construction rule should be assumed or guessed** — Supercell has not been confirmed to publish a stable, documented pattern for turning these IDs into asset URLs, and constructing one from observed community conventions would be an unsupported reverse-engineered assumption, not an officially sanctioned integration. In that scenario, the Fan Kit strategy remains the correct fallback for actually rendering the badge/icon visually, with the numeric ID retained only as a cross-reference key (e.g., to a Fan Kit-derived local asset manifest keyed by the same ID), never as a hotlink target.
- **Player icon specifically** also resolves independently on product-scope grounds: even under the most favorable verification outcome, no Phase 6 page in this document's route matrix (Section 8) renders individual player data, so this field has no planned consumer regardless of what verification eventually shows.

**Outcome 1 (a usable official image URL exists but is ignored) is not confirmed for any media type in this repository.** **Outcome 3 (the API does not return the required image) is not confirmed either** — it is the *working assumption* this document plans against (Fan Kit as the baseline strategy), but that is a planning choice made under uncertainty, not a verified fact. Both outcomes 1 and 3 remain open until the Section B verification step is actually run.

**Because no field is currently persisted, and because the API's actual image-field presence has never been independently verified against a primary source or a real stored payload (consistent with every prior phase's honest "not yet verified" posture, e.g. `PHASE2.md`/`PHASE3.md`), Phase 6 must plan on the Supercell Fan Kit strategy as its baseline image source, not on an assumed API image field — while keeping the Section B verification step open as a cheap, low-risk action that could later upgrade several of these rows to Outcome 1 or Outcome 2 with real evidence.**

**Fan Kit compliance plan (required, not yet implemented):**

| Requirement | Plan |
|---|---|
| Ownership | Every Fan Kit-derived asset is documented as **third-party official fan-content material**, never described as BrawlRanks-owned artwork, in code comments, alt text conventions, and the footer disclaimer |
| Attribution | A visible, sitewide disclaimer (footer, per spec Section 17.2: *"BrawlRanks is an independent fan site and is not affiliated with or endorsed by Supercell"*), plus an explicit asset-sourcing statement on `/about` or `/disclaimer` |
| Source tracking | Every locally-stored derived image should carry a source reference (e.g., a `source_reference` field or adjacent manifest entry noting "Supercell Fan Kit," fetch date, and original asset identifier) — a small schema/manifest addition, not built in this pass |
| Local storage strategy | Store optimized copies under `public/brawlers/`, `public/modes/`, `public/items/` — never hot-link to a third-party CDN for production rendering (avoids both a broken-image risk and an uncontrolled external dependency) |
| File naming | `{canonical-slug}.{format}`, matching `canonical_brawlers.slug`/`canonical_game_modes` naming already established in the DB (e.g., `mortis.webp`) |
| Optimization / format | WebP primary, AVIF where beneficial, PNG fallback only if a transparency edge case demands it; `next/image` handles responsive `srcset` generation automatically once source files exist |
| Responsive sizes | Defined per component (`BrawlerCard` compact vs. full, detail-page hero) — exact breakpoint sizes to be set in Phase 6A alongside the component's other responsive rules |
| Alt text | `"{Brawler name} portrait"` / `"{Item name} icon"` / `"{Mode name} icon"` exactly per spec Section 17.33 |
| Caching | Standard Next.js static asset caching (long-lived, content-hashed) since images are locally hosted, not proxied at request time |
| Update/version strategy | Fan Kit assets change only on a real content patch (new Brawler, reworked art) — refreshed manually/deliberately, not on every ranking-rebuild cycle; this is explicitly **not** part of the automated data pipeline, since it's a design-asset concern, not a statistics concern |
| Fallback images | A generic "Brawler silhouette" / "mode placeholder" asset for any entity whose real art hasn't been sourced yet — never a broken `<img>`, never a fabricated substitute presented as real art |
| Copyright/trademark disclaimer | Present on `/disclaimer` (full text) and footer (short form), per Section 39 of the spec — legal language marked for review per Section 11 of this document, not finalized here |
| Fan Content Policy compliance | No implication of Supercell endorsement anywhere; no monetization pattern that the policy would prohibit is assumed or planned in this document |

No asset is downloaded, modified, converted, or created as part of this planning task.

### 6.5 Keyword Research

21 CSV files under `keyword/`, columns `Keyword,Volume,CPC,KD,SERP` (real Ahrefs/similar-tool export shape). Every number cited in Section 21 of this document is copied directly from these files — none is invented. Filtered out as cross-game/irrelevant noise (confirmed present in the raw files, exactly as spec Section 33 already documented): Genshin Impact, Honkai, Hero Wars, AFK Arena, Persona, Nickelodeon All-Star Brawl, Brawlhalla, MultiVersus, Virtua Fighter, World of Warcraft ("Zereth Mortis" — a WoW zone, false-positive match on the Brawler name "Mortis"), "The Surge" (an unrelated video game, false-positive match on the Brawler name "Surge"), surge-protector/electronics-product queries (false-positive on "Surge"), a SwiftUI programming cookbook (false-positive), and every mod/hack/APK/cheat query (`brawl stars mod menu god mode`, `rofl mod brawl stars download`, `brawl stars hack latest version`, etc. — excluded on policy grounds, not just relevance, matching spec Section 33's explicit instruction).

Full cleaned cluster table and per-route mapping: **Section 20** of this document.

### 6.6 Claude SEO Skills Repositories

`claude-seo-skills-repos/` contains several large, independently-versioned skill collections (`claude-seo`, `Agentic-SEO-Skill`, `claude-skills`, `seo-geo-claude-skills`, `skills`). This document draws methodology from the **curated `.claude/skills/` subset** (8 substantive `SKILL.md` files inspected directly: `seo`, `seo-technical`, `seo-schema`, `seo-sitemap`, `seo-page`, `seo-content`, `seo-content-brief`, `seo-audit`; 4 additional skill folders in that directory — `app-store-optimization`, `landing-page-generator`, `schema-markup`, `seo-audit-general` — contain empty `SKILL.md` files and are not usable) plus a targeted look at `claude-seo/skills/seo-programmatic` and the (deprecated/redirected) `seo-geo-claude-skills/optimize/internal-linking-optimizer`.

**SEO Skills Applicability Matrix**

| Skill/repository | Applicable Phase 6 area | How it should be used | Limitations | Applies to automated or editorial content |
|---|---|---|---|---|
| `seo-technical` | Section 15 (SEO layer): crawlability, indexability, security headers, URL structure, mobile, Core Web Vitals, structured data, JS rendering, IndexNow | Use its 9-category checklist as the **QA checklist** for Phase 6G's technical audit before launch; its December-2025 JS-SEO guidance (canonical/noindex/structured-data must be in server-rendered HTML, not injected client-side) directly validates this plan's server-components-by-default rendering strategy (Section 21) | Written as a generic cross-industry audit tool, not Brawl-Stars-specific — apply the categories, not any industry-specific defaults it assumes | Automated (applies to every page regardless of content source) |
| `seo-schema` | Section 21 (structured data) | Its ACTIVE/DEPRECATED schema-type list is the authority this plan uses in Section 21's JSON-LD matrix — in particular, it confirms `FAQPage` lost its rich-result eligibility (May 2026) but is still worth keeping for AI-citation/entity-resolution value, and that `HowTo` must never be used | Its ready-made JSON-LD templates are generic (Organization/LocalBusiness/Article) and were adapted, not copied verbatim, for BrawlRanks' actual entity types (Brawler, tier list, matchup) | Automated |
| `seo-sitemap` | Section 21 (sitemap) | Its validation checklist (no >50k URLs per file, no noindexed/redirected/non-canonical URLs in the sitemap, real `lastmod` dates, `priority`/`changefreq` are ignored by Google) is the direct QA checklist for `app/sitemap.ts` in Phase 6G | BrawlRanks' roster is small (~105 Brawlers); the skill's location-page/programmatic-scale warnings (30+/50+ page thresholds) are not currently relevant but are worth keeping in mind if `/compare` pairs or per-map pages are ever built at scale later | Automated |
| `seo-page` / `seo-audit` | Section 27 (testing/QA) | Their per-page and full-site checklists (title/description length, canonical presence, OG/Twitter tags, image alt/size/format, CWV proxies) become the **pre-launch QA checklist** in Section 27/34 | Assume a live, crawlable URL to test against — usable only once Phase 6C/6E pages are deployed to a real environment, not during local development | Automated |
| `seo-content` | Section 19 (content automation) | Its "Who/How/Why" E-E-A-T heuristic directly informs how trust pages should be written — explaining who computed the ranking (an automated pipeline, not a person), how (the documented aggregation/ranking formulas), and why (a genuine attempt at an accurate tier list, not a content-farm page) | Its word-count "floors" are explicitly framed by the skill itself as topical-coverage guidance, not ranking factors — BrawlRanks' data-dense pages (tier list, Brawler detail) may legitimately be shorter than a blog-style minimum and still be complete | Applies to editorial-adjacent pages (`/about`, `/editorial-policy`) more than to data-table pages |
| `seo-content-brief` | Section 19 (content automation), only if guides are ever built | Its brief structure (search intent, competitor gap analysis, per-section word counts, keyword density rules, E-E-A-T requirements) is the right tool **if and when** `/guides/[slug]` content is authored (Section 16H) — not used for the data-driven pages, which have no "brief" to write | Requires a human writer to execute the brief; does not itself generate content, consistent with guides remaining the one human-authored exception (Section 19C) | Editorial only |
| `seo-programmatic` (`claude-seo/skills/seo-programmatic`) | Section 21 (duplicate-content prevention), Section 16H (`/compare`) | Its thin-content quality gates (100+ pages without review = warning, 500+ = hard stop, <40% unique content = flagged as thin) directly justify this plan's decision to keep `/compare` **curated-pairs-only, never combinatorial**, and to build Brawler/mode pages as real entity pages rather than templated keyword-variant pages | Its "hub/spoke" internal-linking-automation guidance overlaps with, and does not exceed, what spec Section 17.30 already fully specifies for BrawlRanks — spec remains authoritative | Automated |
| `internal-linking-optimizer` (`seo-geo-claude-skills`) | — | **Not used** — this skill's page in the cloned repo is a signpost/redirect to an external, unversioned bundle (`aaron-marketing-skills`) not present in this repository; spec Section 17.30's Internal-Linking Map is used instead as the sole authority for BrawlRanks' link graph | Stale/redirected content, not independently inspectable in full | N/A |
| Everything else under `claude-seo-skills-repos/` (local SEO, e-commerce, hreflang, backlinks, maps, drift monitoring, competitor-page generation, etc.) | Not applicable | BrawlRanks has no physical location, no e-commerce checkout, no multi-language requirement at MVP, and no competitor-comparison-page program planned — these skills' domains don't intersect Phase 6's actual scope | — | — |

No large block of any skill file is reproduced verbatim above; every row is a summary adapted to BrawlRanks' actual situation.

## 7. Current Data and API Readiness

| Capability | Ready? | Detail |
|---|---|---|
| Current published tier-list data | **Yes** | `GET /api/public/tier-list`, production-validated |
| Per-Brawler dedicated lookup | No | Same endpoint returns the whole roster; no `?slug=` filter |
| Per-mode dedicated lookup | No | `modeTiers` is nested per-Brawler JSON, not independently queryable |
| Matchup/counters dedicated lookup | No | `published_matchup_items` exists and is populated but has no standalone route |
| Brawler identity (rarity/class/portrait/description) | **No** | Never captured anywhere in this schema; whether the official API even returns these fields is itself **not yet verified** against a primary source (Section 6.4A–D) |
| Build/usage data | **No** | Confirmed structurally absent (Section 16H) |
| Real official patch labels | **No** | `patches.version_label` is internally-inferred only (`internal-YYYYMMDDTHHMMSSZ`), never a Supercell version string |
| AI-generated prose (ranking reasons, FAQs, patch summaries) | **No** | No AI provider integrated anywhere in this repository |
| Guide content | **No** | No `guides` table exists |

## 8. Phase 6 Route Matrix

Every route from the spec's Section 16.1/17 route architecture. "Ready now" means buildable today against `/api/public/tier-list` with no new backend work; "partially ready" means buildable with graceful degradation for missing fields; "blocked" is split by exact blocker type per the task's own classification scheme.

| Route | Priority | Subphase | Primary keyword (real Volume) | User intent | Live data source | API dependency | Status | Key blockers |
|---|---|---|---|---|---|---|---|---|
| `/` | P0 | 6F | `brawl stars tier list` (40,500) | Navigational/informational | Composited from other pages' data | `/api/public/tier-list` + new endpoints | Partially ready | Depends on 6C/6E pages existing first (built last by design) |
| `/tier-list` | P0 | 6C | `brawl stars tier list` (40,500) | Informational | Current overall snapshot | `/api/public/tier-list` | **Ready now**, degraded (no rarity/class filter chips) | Section 7 identity fields |
| `/meta` | P0 | 6C | `brawl stars meta` (4,400) | Informational | Tier-movement deltas + patch | `/api/public/tier-list` (deltas need history across 2+ snapshots — Section 30) | Partially ready | No AI narrative (Section 19); needs ≥2 snapshots for a real delta, which the task confirms exist |
| `/best-brawlers` | P0 | 6C | `best brawlers in brawl stars` (12,100) | Commercial/informational | Snapshot filtered by tier/score | `/api/public/tier-list` | Partially ready | No `recommendation_tag` concept exists (Section 7) — ships as "top-tier" substitute, not goal-based, until that's built |
| `/brawlers` | P0 | 6C | `brawl stars best characters` (170) | Informational | Roster + tier badges | New `GET /api/public/brawlers` | Blocked by missing public API (small gap) | Section 13 |
| `/brawlers/[slug]` | P0 | 6C/6D | `{brawler} brawl stars` (e.g. `mortis brawl stars`, 3,600) | Informational | Per-Brawler ranking + matchup | New `GET /api/public/brawlers/[slug]` | Blocked by missing public API + missing identity data | Section 13; Section 7 |
| `/game-modes` | P0 | 6E | `brawl stars game modes` (170) | Informational | Mode list | New `GET /api/public/game-modes` | Blocked by missing public API | Section 13 |
| `/game-modes/[slug]` | P0 | 6E | `best brawlers for brawl ball` (720) and similar per-mode terms | Informational | Mode-scoped snapshot | New `GET /api/public/game-modes/[slug]` | Blocked by missing public API | Section 13 |
| `/counters` | P1 | 6E | (no dedicated high-volume term found in the supplied files) | Informational | `published_matchup_items` | New `GET /api/public/counters` | Blocked by missing public API (small gap) | Section 13 |
| `/builds` | P1 | 6H | `best build for mortis` (210) and per-Brawler variants | Informational | Build/usage data | None exists | **Blocked by missing data** (not an API gap) | Section 16H |
| `/guides` | P0 (spec) | 6H | `how to play mortis` (320) and similar | Informational | Editorial content | None exists | **Blocked by missing content pipeline** | Section 16H |
| `/guides/[slug]` | P0 (spec) | 6H | Same cluster | Informational | One `guides` row | None exists | Blocked by missing content pipeline | Section 16H |
| `/updates` | P1 | 6H | `brawl stars updates` (2,400) | Informational | `patches` + deltas | Exists structurally, content-thin | **Blocked by missing real patch content** | Section 16H |
| `/updates/[slug]` | P1 | 6H | `brawl stars patch notes` (880) | Informational | One patch's deltas | Same | Same | Section 16H |
| `/compare` | P1 | 6H | (no dedicated term; low relevance in supplied files) | Commercial | Curated pairs | Reuses `/brawlers/[slug]` data ×2 | Deferred (MVP-deferred per spec Section 41 regardless) | Section 16H |
| `/compare/[a]-vs-[b]` | P1 | 6H | — | Commercial | Both Brawlers' data | Same | Deferred | Section 16H |
| `/search` | P1 | 6H | — | Navigational | Live query over published entities | New lightweight endpoint | Deferred (MVP-deferred per spec Section 41) | Section 16H |

| `/about` | P0 | 6B | — | Navigational | Static | None | **Ready now** | None |
| `/contact` | P0 | 6B | — | Navigational | Static + form | None | **Ready now** | Form backend (Section 9) |
| `/editorial-policy` | P0 | 6B | — | Trust | Static | None | **Ready now** | Legal-review marker (Section 11) |
| `/disclaimer` | P0 | 6B | — | Trust | Static | None | **Ready now** | Legal-review marker |
| `/privacy-policy` | P0 | 6B | — | Trust | Static | None | **Ready now** | Legal-review marker |
| `/terms-of-service` | P0 | 6B | — | Trust | Static | None | **Ready now** | Legal-review marker |
| Branded 404 | — | 6B | — | — | Static | None | **Ready now** | None |
| Global error boundary | — | 6A | — | — | Static | None | **Ready now** | None |

**Full per-route detail (sections, components, states, metadata, schema, blockers) is given per-subphase in Sections 9–16, not repeated per route here, to avoid duplicating the same content twice in one document.**

## 9. Phase 6A — Shared Frontend Foundation

**Objective:** build every reusable system Phase 6B–6H depend on, and validate it against a minimal test surface — not full pages.

**In-scope:** folder structure, design tokens, layout shell (header/footer/nav/breadcrumbs), the typed public API client, shared TypeScript response types, cache/revalidation strategy, environment/URL helpers, the full shared-component set listed below, SEO/JSON-LD/analytics/accessibility helper modules, local font loading strategy via `next/font/local` for the licensing-clear fonts (Section 6.2: `Lilita One` display, `Noto Sans CJK JP` fallback), image component strategy.

**Out-of-scope:** any full public page beyond what's needed to render the shell/components in isolation (e.g., a bare test route, not a real `/tier-list`); wiring in `KoBrawl Gothic40`/`KoBrawl Gothic60`/`Nougat ExtraBlack` (Section 6.2 — blocked pending licensing confirmation); sourcing a dedicated body-copy font (Section 6.2 — open gap, no candidate yet).

**Dependencies:** none beyond the existing `/api/public/tier-list` (for the API client's real shape) and Section 6's asset findings (logo ready to integrate now; `Lilita One`/`Noto Sans CJK JP` ready to integrate now; 3 other font files blocked on licensing confirmation; body-copy font still unsourced).

**Folder structure (proposed, not created):**
```
app/
  layout.tsx                 (rebuilt: real metadata, header/footer, APP_ENV-aware robots)
  (marketing)/                (optional route group for static pages)
components/
  layout/          Header, Footer, Breadcrumbs, MobileNav
  data-display/    BrawlerCard, GameModeCard, CounterCard, TierBadge, ConfidenceBadge,
                    PatchBadge, LastUpdated, MetaScore, MovementBadge
  feedback/        EmptyState, ErrorState, PartialDataWarning, LowConfidenceWarning, Skeletons
  controls/        FilterBar, SearchInput, SortSelect, MobileFilterSheet, Pagination
  seo/             JsonLd (generic emitter)
lib/
  publicApi/       typed fetch client for /api/public/**
  seo/             metadata template helpers, canonical-URL builder, jsonld builders
  analytics/       typed event-tracking helper
  env.ts           NEXT_PUBLIC_SITE_URL / APP_ENV accessors
```

**Server vs. client component rules:** Server Components by default for every page and every data-display component (Section 17.1 of the spec is explicit on this). Client Components only for: `FilterBar`/`SortSelect`/`MobileFilterSheet` (stateful filter/sort UI), `SearchInput` (header overlay + `/search`), tab/accordion interactivity (`FAQAccordion`, `TableOfContents`), `ShareButton` (Web Share API access), and comparison selectors (`/compare`, deferred). No data-fetching Client Component is planned — all live data is fetched server-side and passed down as props.

**Data-fetching strategy:** every page-level Server Component calls the typed API client (`lib/publicApi/`), which wraps `fetch()` against `/api/public/**` with Next.js's built-in request-level fetch deduplication and route-appropriate `revalidate`/`cache` options (Section 21). The client never calls `/api/internal/**` (protected, cron-only) and never queries MySQL directly from a page — this preserves the existing hard boundary the backend already enforces (`lib/publishedSnapshots/repository.ts`'s "only `is_current` data" rule stays the single source of truth; the frontend never bypasses it).

**Shared response types:** one TypeScript module mirroring `lib/publishedSnapshots/repository.ts`'s existing `PublicBrawlerRecord`/`PublicMatchupEntry` shapes exactly (not redefined ad hoc per component), plus new types for whatever Section 13's new endpoints return.

**Cache and stale-data handling:** ISR per route per spec Section 16.1's table (e.g., `/tier-list` revalidates on-demand via a publish-triggered tag plus a 6h fallback). Because Phase 6 does not build the revalidation-webhook trigger in this pass (that's a small, explicit follow-up noted in Section 29), **every route's fallback timer is the only revalidation mechanism at first launch** — stated honestly, not hidden. A "stale data" UI notice (`PartialDataWarning`-style banner) is planned for when `/api/public/tier-list`'s `publishedAt` exceeds a configured staleness threshold, mirroring the backend's own `phase5-readiness`-style honesty posture.

**Environment/URL helpers:** `NEXT_PUBLIC_SITE_URL` (new required env var, e.g. `https://brawlranks.com`) and `APP_ENV` (`development`/`staging`/`production`, new required env var) must be added to `.env.example` before any metadata/canonical/robots code is written — every canonical tag, OG URL, sitemap entry, and JSON-LD `url` field is built from this one constant, never hardcoded per file (spec Section 17.1). `app/robots.ts` reads `APP_ENV`: anything other than `production` emits a blanket `Disallow: /`.

**Design tokens (Tailwind v4, CSS-first — extend `app/globals.css`'s `@import "tailwindcss"` with `@theme` tokens, not a `tailwind.config.js` file, matching the already-installed v4 convention):** color palette (including the 5 tier colors S/A/B/C/D, chosen for both correct color-blind-safe hue separation and WCAG contrast against text — a design decision to make once, in Phase 6A, not per page), spacing scale, type scale (paired with `Lilita One` for display/heading roles per Section 6.2, with the body-copy role left open pending a font decision), border-radius scale, shadow scale, the 4 breakpoints from spec Section 17.32 (`<640px`, `640–1023px`, `1024–1439px`, `≥1440px`).

**Shared Component Matrix**

| Component | Responsibility | Server/Client | Pages using it | Loading/error behavior | Test requirement |
|---|---|---|---|---|---|
| `Header` | Global nav, patch badge slot, search trigger | Server (nav is static; search trigger is a small client island) | Every page | N/A (always server-rendered) | Render test: correct active-link state per route |
| `Footer` | SEO hub links, trust/legal links, disclaimer, copyright | Server | Every page | N/A | Render test: disclaimer text present verbatim |
| `Breadcrumbs` | Hierarchy + `BreadcrumbList` schema | Server | Every page except `/`, `/search`, error pages | N/A | JSON-LD shape test |
| `MobileNav` | Slide-in panel | Client (open/close state, focus trap) | Every page (mobile) | N/A | Focus-trap test, `Escape`-closes test |
| `BrawlerCard` | Brawler summary link (compact/full density) | Server | `/brawlers`, `/tier-list`, `/best-brawlers`, homepage | Renders `LowConfidenceWarning` inline when confidence is low; never renders with missing tier | Render test per density variant; accessible-name test |
| `TierBadge` | S/A/B/C/D display | Server | Everywhere a tier appears | Color + text label always both present | Contrast test |
| `ConfidenceBadge` | Confidence label display | Server | Everywhere a score appears | Text label always present, never color-only | Same |
| `PatchBadge` / `LastUpdated` | Freshness signals | Server | Per spec Section 17.2's placement table | `LastUpdated` renders a real `<time datetime>` | Render test with a real ISO date from the API |
| `MovementBadge` | Tier/rank delta | Server | `/tier-list`, `/brawlers/[slug]`, homepage | Omits itself (not a fake "—") when no prior snapshot exists to compare against | Test with/without prior-snapshot data |
| `GameModeCard` | Mode summary link | Server | `/game-modes`, homepage | — | Render test |
| `CounterCard` (maps to spec's `MatchupCard`) | One counter/strong-against relationship | Server | `/brawlers/[slug]`, `/counters` | Never renders a `weak_signal`/`insufficient` matchup as if confident | Test: only `probable_counter`/`high_confidence_counter` render |
| `FilterBar` / `SortSelect` / `MobileFilterSheet` | Filter/sort controls | Client | `/tier-list`, `/brawlers`, `/game-modes/[slug]` | Client-side only, canonical stays on the base URL (spec Section 17.4) | Keyboard-operability test |
| `SearchInput` | Text search field | Client | Header overlay, `/search` | — | Deferred (Section 16H) |
| `EmptyState` / `ErrorState` / `PartialDataWarning` / `LowConfidenceWarning` / `Skeletons` | The five required non-happy-path states | Server (except `Skeletons`, used only for genuinely client-fetched content, which Phase 6 currently has none of) | Any list/filterable/calculated-entry page | Message is real text, never image-only | Render test per state |

| JSON-LD emitter (`lib/seo/jsonld.ts`) | Serializes a typed schema object into a `<script type="application/ld+json">` | Server (build-time/render-time, no client JS) | Every page with structured data | Never emits invalid/incomplete required properties | Schema-shape unit test per type used |

**Deliverables:** the folder structure above populated, all listed components implemented and tested in isolation, `NEXT_PUBLIC_SITE_URL`/`APP_ENV` documented in `.env.example` (not committed as real secrets), `app/layout.tsx` rebuilt with real (if placeholder-copy) metadata and environment-aware `robots`.

**Tests:** component unit/render tests for every item in the matrix above; a metadata-helper unit test (given a route + data, does it produce the correct title/description/canonical shape); a JSON-LD helper unit test per schema type.

**Deployment validation:** `npm run build` succeeds with the new component tree; no page is added yet, so no live-route validation applies at this subphase.

**Risks:** the body-copy font gap (Section 6.2 — no verified-license body face currently exists) could stall type-scale finalization for body text specifically — mitigate by building the body type scale against a temporary `next/font/google` fallback so component work isn't blocked, while wiring `Lilita One` (already licensing-clear) for headings immediately. The 3 licensing-blocked local fonts (`KoBrawl Gothic40`/`60`, `Nougat ExtraBlack`) must not be wired into `next/font/local` until their licensing status changes from "should not be used until verified" to confirmed.

**Exit criteria / Definition of Done:** every component in the matrix renders correctly in isolation with real (not fake) sample data shaped like the actual API response; `NEXT_PUBLIC_SITE_URL`/`APP_ENV` exist and are read correctly; non-production environments are blocked from indexation; lint/typecheck/build/component-tests all pass.

### 9.1 Implementation Status — Phase 6A: Complete

Implemented, tested, and validated in a follow-up pass. Application code now exists for everything this section specifies; this subsection records what was actually built, exactly as delivered, plus real deviations from the plan text above.

**Files delivered (new):**
- `lib/env.ts` — typed `getAppEnv`/`isProduction`/`getSiteUrl`/`getSiteOrigin`, fails closed to non-production on an invalid `APP_ENV`.
- `lib/seo/canonicalUrl.ts`, `lib/seo/metadata.ts`, `lib/seo/jsonld.ts` — canonical/absolute URL builder, title/description/robots/OG helpers, WebSite/Organization/BreadcrumbList JSON-LD builders + script-safe serializer.
- `components/seo/JsonLd.tsx` — the generic JSON-LD emitter.
- `lib/analytics/events.ts` — typed, no-op-by-default analytics abstraction (no vendor wired).
- `lib/publicApi/types.ts`, `lib/publicApi/tierList.ts` — shared-contract type re-exports (no duplication) and the typed `/api/public/tier-list` client with an injectable `fetchImpl` for testing.
- `lib/fonts.ts` — `next/font/local` for `Lilita One` (preloaded display) and `Noto Sans CJK JP` (unpreloaded fallback) only; the 3 licensing-blocked fonts are not referenced anywhere in application code.
- `lib/a11y/focusTrap.ts`, `components/a11y/VisuallyHidden.tsx`, `components/a11y/SkipLink.tsx` — focus-trap/Escape helpers and the skip-to-content link.
- `lib/time/staleness.ts` — isolates the one real `Date.now()` read outside any component's render body (React's component-purity lint rule).
- `components/layout/{Header,Footer,MobileNav,Breadcrumbs,SectionContainer,SectionHeader,navigation}.tsx|.ts` — the full layout shell.
- `components/data-display/{TierBadge,ConfidenceBadge,PatchBadge,LastUpdated,MovementBadge,MetaScore,BrawlerImage,BrawlerCard,GameModeCard,CounterCard,types}.tsx|.ts`.
- `components/feedback/{EmptyState,ErrorState,PartialDataWarning,LowConfidenceWarning,StaleDataNotice,Skeleton}.tsx`.
- `components/controls/{FilterBar,SortSelect,SearchInput,MobileFilterSheet}.tsx`.
- `public/brand/logo-wordmark.png` — a 480×320 derived, alpha-preserving, optimized re-export of `logo/logo.png` (2.0MB source untouched; derived file ~78KB).
- 14 new test files under `tests/` (see Section 25/final report for the full list) plus `tests/testUtils/{renderStatic,domEnv}.ts`.

**Files modified (existing):** `app/layout.tsx`, `app/page.tsx`, `app/globals.css` (rebuilt per this section); `.env.example` (added `NEXT_PUBLIC_SITE_URL`/`APP_ENV` with safe local-dev defaults, no secrets); `package.json` (added `jsdom`/`@types/jsdom` devDependencies — justified below — and extended the `test` script with the 14 new files); `tsconfig.json` (excluded the unrelated third-party `claude-seo-skills-repos/` directory from typecheck scope — see deviations); `app/globals.css` also gained a Tailwind `@source not` exclusion for the same directory (a false-positive class-name build warning, not an application concern).

**Real deviations from this section's original plan text:**
1. **No `app/robots.ts` in this pass.** The implementing task explicitly instructed against creating it in 6A ("belongs to Phase 6G"). Environment-aware noindex is instead enforced today via the Next.js Metadata API's per-page `robots` field (`lib/seo/metadata.ts#robotsDirective`), which every page's metadata already goes through — functionally equivalent for meta-tag-based noindex, but not a `robots.txt` file. `app/robots.ts`/`app/sitemap.ts` remain Phase 6G work.
2. **Nav items ship empty today.** `components/layout/navigation.ts` defines `PLANNED_NAV_ITEMS` (the full spec-order list) for fixtures/tests, but `LIVE_NAV_ITEMS`/`LIVE_FOOTER_GROUPS` — what `app/layout.tsx` actually renders — are empty arrays, since Phase 6A ships no route beyond `/`. `Header`/`Footer`/`MobileNav` are fully data-driven and tested against `PLANNED_NAV_ITEMS` fixtures; each later subphase should add its own routes to the `LIVE_*` lists as they ship, never before.
3. **One new devDependency: `jsdom` (+ `@types/jsdom`).** Not in the original plan text, but required by this task's own explicit requirement to test "MobileNav open/close/Escape/focus restoration" — this repository had no DOM implementation for `node:test` before. Deliberately not React Testing Library (a heavier addition) — `jsdom` is driven directly with `react-dom/client`/`act` in `tests/mobileNav.test.tsx` only; every other component test uses `react-dom/server`'s `renderToStaticMarkup` (already available via the existing `react-dom` dependency, no new package).
4. **`tsconfig.json` excludes `claude-seo-skills-repos/`.** That directory is a cloned third-party reference tree with its own unrelated TypeScript files and missing dependencies; it was previously in `tsc --noEmit`'s scope by accident (no exclude existed) and made `npm run typecheck` fail on files that were never part of this application. This is a build-tooling scope correction, not an application behavior change.
5. **Body-copy font role remains unfilled**, exactly as this section's Risks paragraph already anticipated — `--font-body` in `app/globals.css` is a plain system-font stack; no `next/font/google` fallback was actually wired in (none was needed — the system stack alone satisfies the implementing task's own instruction to default to "a reliable system sans-serif stack").

**Validation actually run (this session, `npm run <script>` from `package.json`, not simulated):**
- `npm run lint` — 0 errors. 2 pre-existing warnings remain, both inside `claude-seo-skills-repos/` (unrelated third-party files, not touched).
- `npm run typecheck` — 0 errors.
- `npm test` — 379 total, **335 passed, 0 failed, 44 skipped** (all 44 skips are pre-existing DB-gated integration tests with no DB credentials in this environment — unrelated to Phase 6A).
- `npm run build` — succeeds; `/` prerenders as static (○), every `/api/**` route is correctly dynamic (ƒ), no build warnings.

**Unresolved blockers carried forward (unchanged by this implementation pass):** the 3 licensing-blocked fonts, the dedicated body-copy font gap, the official-API image-field verification step, and every Phase 6B–6H blocker already catalogued in Sections 16/30 — none of these were resolved by building the foundation, and none needed to be.

## 10. Phase 6B — Static, Legal, and Trust Pages

### Implementation Status — Phase 6B: COMPLETE

Phase 6B is implemented and validated. Exactly these 8 deliverables shipped:

1. `/about`
2. `/contact`
3. `/editorial-policy`
4. `/disclaimer`
5. `/privacy-policy`
6. `/terms-of-service`
7. Branded 404 through `app/not-found.tsx`
8. Global route-segment error UI through `app/error.tsx`

All six static routes use the Phase 6A root layout and therefore reuse the shared `Header` and `Footer`. The branded 404 also renders within that layout and returns HTTP 404 for a missing route. The error UI is implemented as the correct Next.js App Router client error boundary, accepts `error` and `reset`, logs the underlying error without exposing its details, and presents an on-brand retry action.

**Implemented deviations and final decisions:**

- `/methodology` was cancelled. It has no route, navigation/footer link, CTA, or sitemap entry and is not an active requirement.
- `/contact` uses an honest `mailto:` fallback because no contact backend exists; Phase 6B did not add a backend, database table, migration, delivery service, or secret.
- Public `[LEGAL REVIEW REQUIRED]` banners were removed. The published trust/legal pages contain readable user-facing copy without an internal review marker.
- Only implemented routes are clickable. Planned Phase 6C+ destinations remain non-clickable labels or planning data until their routes ship.
- All page and error artwork is loaded from repository-local assets under `reference_pages/` or `public/`; no external image URL is used.

**Validation:** static render, metadata, local-asset, shared-layout, legal-marker, cancelled-route, 404, and error-boundary tests cover the deliverables. Finalization also includes lint, TypeScript, the complete test suite, a production build, an HTTP 404 check against a missing URL, and an intentional runtime-error check of the branded global error UI. Temporary error-test routes/files are removed after verification.

Phase 6C and all later subphases remain incomplete and were not started by this implementation.

## 11. Phase 6C — Core Live-Data Pages

**Objective:** the first pages reading real published-snapshot data: `/tier-list`, `/meta`, `/best-brawlers`, `/brawlers`, `/brawlers/[slug]`.

**In-scope:** all five pages, built against `/api/public/tier-list` as-is for as much as it supports, with explicit, honest degradation for what it doesn't.

**Out-of-scope:** `/game-modes`/`/game-modes/[slug]`/`/counters` (Phase 6E, need new endpoints), homepage (Phase 6F, composites these).

**Dependencies:** Phase 6A's full component/API-client layer.

**Exactly which sections `/api/public/tier-list` already supports:**

| Page section | Buildable from current API? | Detail |
|---|---|---|
| `/tier-list` tier bands, per-entry tier/score/confidence, mode-tier list | **Yes** | Directly in `PublicBrawlerRecord` |
| `/tier-list` counters/strong-against per entry | **Yes** | `counters[]`/`strongAgainst[]` fields already populated |
| `/tier-list` rarity/class filter chips | **No** | Field doesn't exist (Section 7) — ship without these filters, or with a name-search-only `FilterBar` until identity data exists |
| `/tier-list` per-entry AI ranking reason | **No** | No AI layer (Section 19) — omit the field entirely, never a placeholder sentence |
| `/meta` tier-movement deltas | **Partially** | Requires comparing two `/api/public/tier-list`-shaped snapshots over time; the current endpoint only exposes the *current* snapshot, not history — needs either a small history endpoint or client-side snapshot diffing is not possible server-side without one (flagged as a Phase 6D candidate, see Section 13) |
| `/meta` AI patch-impact narrative | **No** | Section 19 |
| `/best-brawlers` goal-based rows (beginner/upgrade/etc.) | **No** | No `recommendation_tag` concept — ship a "top overall tier" substitute view, explicitly not labeled as goal-matched, until this exists |
| `/brawlers` directory grid | **Partially** | Tier/score/confidence yes; portrait/rarity/class no (Section 7) |
| `/brawlers/[slug]` tier/score/confidence/counters | **Yes** | Full detail available today |
| `/brawlers/[slug]` identity header (portrait, rarity, class, description) | **No** | Section 7 |
| `/brawlers/[slug]` build section | **No** | No data source exists at all (Section 16H) |
| `/brawlers/[slug]` "how to play"/strengths/weaknesses prose | **No** | Section 19 |

**Graceful degradation rule (binding for this entire subphase):** a section with no real data is **omitted entirely**, never rendered with placeholder/fake/guessed values — this repeats spec Section 17.1's own "no fake freshness"/"no thin pages" principle and this document's Section 26 planning principle. A `BrawlerCard` with no portrait shows a neutral fallback silhouette (Section 6.4), never a fabricated image.

**Tests:** page-render tests against a realistic API-response fixture, empty/error-state tests (what happens when `/api/public/tier-list` returns `available:false`), metadata tests, JSON-LD tests (`ItemList` for `/tier-list`/`/brawlers`, `Article` for `/meta`).

**Deployment validation:** live-snapshot integration test — render each page against the actual current production `/api/public/tier-list` response and confirm no field is fabricated.

**Risks:** `/meta`'s delta requirement is the one real open design question in this subphase (medium risk — resolved by Section 13's endpoint decision, not by inventing client-side history storage).

**Exit criteria / DoD:** all five pages render real data only, degrade gracefully and visibly (not silently) around every missing field, pass the full test set, and pass a manual QA pass confirming no fabricated content anywhere.

## 12. Phase 6D — Additional Public Read APIs

**Objective:** the minimal correct new public API surface — derived from actual Phase 6C/6E page needs, not from the example list in the task verbatim (some of which are not actually required as separate endpoints).

**Principle (binding, per spec Section 7.25 and this document's Section 26):** every new endpoint reads **only** from `published_snapshots`/`published_snapshot_items`/`published_matchup_items` filtered to `is_current = 1` — never `ranking_results`/`matchup_results` (the candidate/working layer) and never raw aggregation tables. This mirrors `lib/publishedSnapshots/repository.ts`'s existing, already-tested pattern exactly.

**Public API Endpoint Matrix**

| Endpoint | Method | Purpose | Params | Source tables | Migration needed? | Consumers |
|---|---|---|---|---|---|---|
| `GET /api/public/brawlers` | GET | Directory listing: slug, name, tier, score, confidence for every published Brawler | None (small roster, no pagination needed at ~105 entries) | `published_snapshot_items` JOIN `canonical_brawlers` | **No** — same tables `lib/publishedSnapshots/repository.ts` already reads | `/brawlers`, homepage |
| `GET /api/public/brawlers/[slug]` | GET | Single-Brawler detail: everything `/api/public/tier-list` already returns for one Brawler, without over-fetching the whole roster | `slug` (path) | Same, filtered by `canonical_brawlers.slug` | No | `/brawlers/[slug]`, homepage related-content |
| `GET /api/public/game-modes` | GET | Mode list: id/slug/name only (no icon field exists yet) | None | `canonical_game_modes` (read-only, identity data — safe to expose since it carries no ranking/PII concern) | No | `/game-modes`, homepage |
| `GET /api/public/game-modes/[slug]` | GET | Mode-scoped tier list: every Brawler's tier/score/confidence **for that mode specifically** | `slug` (path) | `published_snapshot_items.mode_tiers` (currently nested JSON per-Brawler) — requires the route to **filter and re-pivot** this data by mode server-side; no schema change, a query/transform-layer addition only | No (application-layer only) | `/game-modes/[slug]`, homepage |
| `GET /api/public/counters` | GET | Matchup list, optionally filtered by one Brawler | `brawler` (optional query param, slug) | `published_matchup_items` | No | `/counters`, `/brawlers/[slug]` (already partially covered by the existing endpoint's nested `counters`/`strongAgainst`, so this is mainly for the standalone `/counters` browse/lookup UX) |

| `GET /api/public/meta` (history/delta) | GET | **Not built in Phase 6D as initially proposed.** On inspection, `/meta`'s delta requirement needs either (a) a second stored "previous published snapshot" pointer already available via `published_snapshots.superseded_at`/history, or (b) a light server-side diff computed from the current + immediately-prior snapshot. Recommended: add this as a `previousTiers` field to a **new, narrow** `GET /api/public/meta` endpoint that reads the current AND the immediately-preceding `published_snapshots` row (both already exist, append-only) and returns only the delta — no new table, no new migration | `GET /api/public/meta` | `published_snapshots` (current + prior), `published_snapshot_items` ×2 | No | `/meta`, homepage risers/fallers |

**For each endpoint (pattern applied uniformly, detailed per-endpoint contract deferred to actual implementation, not fully typed out here):** validation via a small schema check on any query param; response contract mirrors `lib/publishedSnapshots/repository.ts`'s existing `PublicBrawlerRecord`/`PublicMatchupEntry` shape; `is_current=1` is the non-negotiable filter on every query; no pagination needed at current roster/matchup-pair scale (matchup pairs number in the tens of thousands total, but any *single Brawler's* filtered result is small — pagination is a "when it becomes a problem" concern, not a day-one requirement); caching matches the page's own ISR/revalidate window (Section 21); error responses follow the existing `errorBody()`/`logSafeError()` convention already used by every route in `lib/errors.ts`; empty-state response is `{available: false, reason}` matching the existing `/api/public/tier-list` convention exactly; no rate limiting is currently applied to `/api/public/tier-list` and none is proposed here beyond what Section 38 of the spec already requires site-wide (general abuse-prevention rate limiting on public routes, an infrastructure concern, not specific to these new endpoints); tests follow the exact pattern already established in `tests/publicSnapshotRoute.test.ts` (fake-pool unit tests + a DB-gated integration test).

**Deliverables:** the 5 endpoints above (the game-modes/meta transforms being the only ones needing real new logic; brawlers/brawlers-slug/counters are thin wrappers around existing repository functions).

**Tests:** contract tests per endpoint (available/unavailable shape, `is_current`-only exposure, no PII/raw-payload leakage — mirroring `tests/publicSnapshotRoute.test.ts`'s existing assertions).

**Deployment validation:** each endpoint smoke-tested against real production data once deployed.

**Risks:** the mode-pivot transform (`/api/public/game-modes/[slug]`) is the only endpoint with real logic risk (medium) — everything else is a thin, low-risk wrapper.

**Exit criteria / DoD:** every endpoint returns only `is_current` data, has a passing test suite, and is consumed by at least one real Phase 6C/6E page (no endpoint built speculatively without a consumer).

**Schema/migration recommendation regarding image fields (per Section 6.4's evidence investigation):** **no migration is recommended in this document.** Every image-field question in Section 6.4's evidence matrix resolves to "not yet verified" — adding image-URL or image-asset-ID columns to `canonical_brawlers`/`canonical_game_modes`/`canonical_maps`/`normalized_clubs` now would mean speculatively shaping the schema around fields that have not been confirmed to exist in the official API response. If the Section 6.4B read-only verification step is later run and confirms a real, usable field (Outcome 1: a hotlinkable URL, or Outcome 2: an asset ID with a supported lookup path), the correct sequencing is: (1) confirm the field via the raw-payload query, (2) extend the relevant validator (`lib/catalog/schema.ts` and/or `lib/ingestion/schemas.ts`) to extract it, (3) add the minimal necessary column(s) in a new migration at that time, (4) only then expose it through a public endpoint. This subphase intentionally does not get ahead of that sequence.

## 13. Phase 6E — Game Modes and Counters

**Objective:** `/game-modes`, `/game-modes/[slug]`, `/counters`.

**In-scope:** all three pages, built against Phase 6D's new endpoints.

**Game-mode data reliability assessment:**

| Field | Reliable today? | Detail |
|---|---|---|
| Mode slug/name | **Yes** | `canonical_game_modes` (Phase 3), stable |
| Mode-scoped ranking (derived from `modeTiers`) | **Yes, once Phase 6D's pivot endpoint exists** | The data is real and already computed by Phase 5.3's mode-scoring logic |
| Mode icon | **No** | Not persisted in this repository, and whether the official API returns mode-icon data at all is **not yet verified** against a primary source (Section 6.4C) — no dedicated official game-modes/events endpoint is even integrated today; mode identity is derived only from the nested `event.mode` string inside the battle-log response |
| Map data | **No** | No `canonical_maps`-to-public-contract path exists; maps are tracked internally (`canonical_maps`, migration 0010) but never exposed via any published/public layer |
| Event rotation data | **No** | Never ingested at all in this repository (confirmed absent from every migration and every `lib/ingestion/**` schema) |

**Must be omitted until verified:** mode icons, map-specific breakdowns, event-rotation context — all three render as text-only/omitted sections, never a guessed icon or invented map list.

**Counters page determinations:**

| Question | Answer |
|---|---|
| Do global counter rankings exist? | Yes — `published_matchup_items`, pooled across patches, populated (confirmed by this task's own production evidence: `matchupAggregateCount: 82160` at the aggregation layer feeding it) |
| Is counter data mode-specific? | **No, currently pooled to overall only** — `published_matchup_items.game_mode_id` is always `null` in the current Phase 5.3 implementation (documented in that phase's own delivery notes); `/counters` must not claim mode-specific counter data it doesn't have |
| Minimum sample rules | Inherited directly from the ranking layer: 20-match floor for any classification to appear at all (`lib/ranking/formulas.ts#classifyMatchup`) |
| Confidence display | The real 4-level matchup confidence vocabulary (`insufficient`/`weak_signal`/`probable_counter`/`high_confidence_counter`) — only `probable_counter`/`high_confidence_counter` are ever published (Phase 5.3's own publish-time filter), so the UI only ever needs to render those two labels plus their sample size |
| Matchup interpretation language | Must state the real limitation from spec Section 7.15: team-composition confounding, map/mode variance — never presented as a guaranteed 1v1 outcome |
| Filters/sorting | By relationship type (hard counter / counter / strong / hard advantage), by opponent name (search) — both client-side over the fetched result set |
| Low-sample warnings | Any matchup pair below the 20-match floor simply never appears (already enforced server-side — no separate frontend warning needed for the *absence*, but a `LowConfidenceWarning` should still appear on any *shown* pair whose confidence is `probable_counter` rather than `high_confidence_counter`) |
| Strong-against presentation | Mirror of counters, using the `strongAgainst[]` field already present in the API response |

**Dependencies:** Phase 6D endpoints.

**Tests:** render tests against real mode/matchup data shapes; a specific test confirming `/counters` never renders a `weak_signal`/`insufficient` pair (since the backend already excludes these from publication, this is primarily a regression guard, not a new filter to implement).

**Exit criteria / DoD:** all three pages render only verified-real fields; mode icon/map/event sections are absent, not placeholder; matchup confidence language matches the real backend vocabulary exactly.

## 14. Phase 6F — Homepage

**Objective:** `/` — built **last**, since spec Section 17.3 defines it as a curated teaser of every other hub page, and a teaser cannot be honestly built before the pages it teases exist.

**In-scope:** hero, patch/freshness row, top-Brawlers preview, tier-list preview, risers/fallers (needs Phase 6D's `/api/public/meta` delta endpoint), best-by-mode preview (needs Phase 6E), trust block, FAQ.

**Explicitly must NOT copy complete hub pages:** per spec Section 17.3's own binding rule — every homepage section overlapping a hub's topic is a teaser with a "see full list" link, never a re-publication.

**Sections requiring systems that don't exist yet — explicit per-section decision (never filled with fake content):**

| Homepage section (per spec Section 17.3) | Decision |
|---|---|
| Trending builds | **Omit entirely** — no build data source exists (Section 16H); do not show an empty or placeholder "coming soon" carousel that implies a feature exists |
| Best Brawlers for beginners / to upgrade | **Show only after `recommendation_tag`-equivalent logic exists**; until then, omit rather than mislabel a generic top-tier list as "beginner-friendly" |
| Latest patch impact | **Omit** until `/updates/[slug]` has real, non-placeholder patch content (Section 16H) |
| Latest guides | **Omit** until `/guides` exists (Section 16H) — spec Section 17.3 itself already specifies this exact fallback ("Section omitted if fewer than 3 guides published") |
| Biggest risers and fallers | **Show once Phase 6D's delta endpoint exists**; omit if it doesn't yet |
| Top Brawlers / Tier List preview / Best by mode | **Show** — fully supported by Phase 6C/6E data |
| Trust block, FAQ | **Show** — static/trust content, no data dependency |

**Dependencies:** Phase 6C, 6D, 6E all complete.

**Tests:** an explicit test asserting no homepage section duplicates a hub page's full content (row-count/content-length assertion, not just a visual check); render tests per section's present/omitted state.

**Exit criteria / DoD:** every visible section is backed by real data; every unavailable-system section is cleanly absent, not stubbed.

## 15. Phase 6G — Complete SEO and Indexation Layer

**Objective:** make the site built in 6B–6F actually indexable and correctly described to search engines and AI crawlers.

**In-scope:** `app/robots.ts`, `app/sitemap.ts`, per-route `metadata` exports, canonical URL logic, Open Graph/Twitter Card metadata, JSON-LD emission, internal-link audit, Core Web Vitals validation, Search Console readiness.

**`app/robots.ts`:** environment-aware (Section 9) — `production` allows all except `/search` and any future admin-adjacent path (there is none, by design); any other `APP_ENV` value disallows everything, matching spec Section 17.1's "Hostinger preview/staging domains are always noindexed" rule exactly.

**`app/sitemap.ts`:** dynamically generated from real published entities (spec Section 36) — every `canonical_brawlers`/`canonical_game_modes` row with a currently-published entry, plus every static route from Section 8's matrix marked "Index." Explicitly excludes: `/search` (noindex), any query-param-filtered URL (spec Section 17.4 — filters canonical back to the base page, never get their own sitemap entry), any deferred/blocked route from Section 16 of this document (a route with no real content must never appear in the sitemap merely to claim completeness — this document's own Section 17/26 principle).

**Metadata Template Matrix** (per spec Section 17.34, applied to what Phase 6 actually ships)

| Route | Title template | H1 | Canonical rule | Main schema |
|---|---|---|---|---|
| `/` | `BrawlRanks — Brawl Stars Tier List, Meta & Builds, Updated Every Patch` | Hero headline | Self, root | `WebSite`, `Organization` |
| `/tier-list` | `Brawl Stars Tier List (Patch {v}) — Updated {date}` | `Brawl Stars Tier List — Patch {v}` | Self; filters canonical here | `ItemList`, `BreadcrumbList` |
| `/meta` | `Brawl Stars Meta — Patch {v} Analysis` | `Brawl Stars Meta — Patch {v}` | Self | `Article`, `BreadcrumbList` |
| `/best-brawlers` | `Best Brawlers in Brawl Stars (Patch {v})` | `Best Brawlers in Brawl Stars` | Self | `ItemList`, `BreadcrumbList` |
| `/brawlers` | `All Brawl Stars Brawlers ({N} Total)` | `All Brawl Stars Brawlers` | Self | `ItemList`, `BreadcrumbList` |
| `/brawlers/[slug]` | `{Name} — Tier, Score & Counters \| BrawlRanks` (adjusted from spec's literal template, which references Build/Gears BrawlRanks does not have data for — Section 26 forbids implying a capability that doesn't exist) | `{Name} — Tier, Score, and Counters` | Self | `BreadcrumbList` |
| `/game-modes` | `Brawl Stars Game Modes` | `Brawl Stars Game Modes` | Self | `ItemList`, `BreadcrumbList` |
| `/game-modes/[slug]` | `{Mode} Tier List (Patch {v})` | `{Mode} Tier List` | Self; target of `/tier-list` mode links | `ItemList`, `BreadcrumbList` |
| `/counters` | `Brawl Stars Counters & Matchups` | `Brawl Stars Counters` | Self | `BreadcrumbList` |

| `/about`, `/contact`, `/editorial-policy`, `/disclaimer`, `/privacy-policy`, `/terms-of-service` | Per spec Section 17.34's exact templates | Per spec | Self | `Organization`/`BreadcrumbList` as applicable |
| `404` | `Page Not Found \| BrawlRanks` | `Page Not Found` | N/A | None |

Every title/description/H1 in this table is a **default template**, substituted with real data at render time — never static placeholder text shipped to production.

**JSON-LD/Schema Matrix**

| Schema type | Used on | Status per `seo-schema` skill (Section 6.6) | Notes |
|---|---|---|---|
| `WebSite` | `/` | Active | `SearchAction` omitted until `/search` ships (Section 16H) |
| `Organization` | `/`, `/about` | Active | `logo` field requires the favicon/icon export from Section 6.1 |
| `ItemList` | `/tier-list`, `/brawlers`, `/game-modes`, `/best-brawlers` | Active | Populated from real ranked/listed entities only |
| `BreadcrumbList` | Every page except `/`, `/search`, error pages | Active | Generated from the same `Breadcrumbs` component's path data |
| `Article` | `/meta` | Active | Author attributed to the `Organization` entity, not a named individual, per spec Section 35's own updated guidance for automated-content bylines |
| `FAQPage` | Only where real, visible FAQ content exists on the page | **Not used at initial launch** — no FAQ content exists yet in this plan's Phase 6B–6F scope, and per `seo-schema`'s own finding (Section 6.6), Google retired FAQ rich results entirely; only add this schema later if real FAQ content is authored, purely for AI-citation value, never for a Google SERP feature that no longer exists |
| `Person` | Nowhere at initial launch | Reserved for a future guide byline (`/guides/[slug]`, Section 16H) once real human-authored guides exist — never applied to a Brawler/tier page, which spec Section 35 explicitly warns against (would misrepresent automated content as hand-written) |
| `Product`, `Review`, `AggregateRating`, `SoftwareApplication` | Nowhere, ever | Explicitly prohibited — spec Section 35 and this document's own Section 26 principle both forbid this; BrawlRanks is not a product listing |

**Internal-Link Matrix:** built directly from spec Section 17.30's Internal-Linking Map, restricted to the routes actually shipping in Phase 6B–6F (the `/guides`/`/updates`/`/builds` links in that map are simply absent until Section 16H's blockers clear — never a dead link to a route that doesn't exist).

**Core Web Vitals, image optimization, font performance, bundle size:** covered in Section 25 (Performance and Rendering Plan) rather than duplicated here.

**SEO QA:** the `seo-technical`/`seo-page`/`seo-audit`/`seo-sitemap` skills' checklists (Section 6.6) become the literal pre-launch QA pass — run once real pages exist in a deployed environment, not simulated against local files.

**Tests:** sitemap-generation test (correct URL set, no excluded routes present), robots test (environment-aware behavior), canonical-URL unit tests per route, JSON-LD shape tests per type.

**Exit criteria / DoD:** `app/sitemap.ts`/`app/robots.ts` exist and are correct in both environments; every shipped route has correct, unique metadata; every JSON-LD block validates in Google's Rich Results Test; no route emits a Hostinger temporary-domain URL anywhere.

## 16. Phase 6H — Deferred and Blocked Hubs

None of the routes below are built as empty shells merely to claim route completion. Each stays fully absent from the sitemap and fully absent from internal navigation until its real prerequisite clears.

| Route | Why deferred | Missing data/content | Exact prerequisite | Migration needed? | Automated pipeline needed? | External source needed? | AI provider needed? | Manual editorial unavoidable? | MVP or post-MVP | Later integration path |
|---|---|---|---|---|---|---|---|---|---|---|
| `/builds`, and the build section of `/brawlers/[slug]` | No usage-statistics data source exists | Gadget/Star Power/Gear selection data (confirmed absent from the battle-log source, migration 0014) | Either the official API is re-verified to expose this (unlikely per this repo's own prior verification) or an approved external source is identified (spec Section 7.19's approval process) | Yes (new build-usage tables) | Yes | Likely yes | No | No (if a real data source is found) | Post-MVP per spec Section 41's own deferral | Add as a new data pipeline stage feeding the existing `published_snapshot_items` shape with a new `build` field — Phase 6A–6G's component/API/SEO layers need no rework, only a new field/endpoint |
| `/guides`, `/guides/[slug]` | No content, no schema, no pipeline | Everything | A human editorial decision to write guides (spec Section 12.6 explicitly keeps this human-authored by design, not an automation gap) | Yes (`guides`/`authors`-equivalent tables) | No — deliberately the one spec-sanctioned human-authored exception | No | No (guides are prose written by a person, not AI-generated, per spec) | **Yes, by spec design** — flagged here as a product decision requiring confirmation, not built without one | P0 per spec Section 41, but honestly not currently startable without that confirmation | New `app/guides/` route tree, reusing 6A's `Header`/`Footer`/`Breadcrumbs`/`RelatedContent` components unchanged |
| `/updates`, `/updates/[slug]` | `patches.version_label` is internal-only, never a real Supercell patch identifier | Real official patch-note text/parsing | A real Section 7.7-style patch-notes ingestion pipeline (never built — Phase 5.1 deliberately scoped this down to catalog-change inference instead, documented in migration 0020's own header) | Yes (raw patch-note storage) | Yes | Yes (official announcement source) | Optional (structuring raw text is AI-assistable per spec Section 7.7 but not required if parsed structurally) | No | P1 per spec Section 41 | Once `patches` carries a real version label, `/updates/[slug]` becomes a thin wrapper over `detected_changes`, reusing 6A/6G unchanged |
| `/compare`, `/compare/[a]-vs-[b]` | Deferred past MVP by the spec itself (Section 41), independent of any technical blocker | None — this is a scope decision, not a data blocker | Product decision to build it | No | No | No | No | No | Explicitly post-MVP (spec Section 41) | Reuses `/brawlers/[slug]` data for both sides; curated-pairs-only per spec Section 16.4, never combinatorial |
| `/search` | Deferred past MVP by the spec itself (Section 41) | None — needs only a lightweight query endpoint over already-public entities | Product decision to build it | No | No | No | No | No | Explicitly post-MVP | A single new `GET /api/public/search?q=` endpoint over the same published-entity tables; noindexed regardless (spec Section 16.1) |

## 17. Shared Component Inventory

See Section 9's Shared Component Matrix — the authoritative, single copy of this table (not duplicated here to avoid drift between two versions of the same table in one document).

## 18. Public API Contract Plan

See Section 12's Public API Endpoint Matrix, plus the existing, already-shipped `GET /api/public/tier-list` documented in Section 7.

## 19. Content Automation Plan

Per the confirmed product decision (no manual admin workflow; automate wherever realistically possible):

**A. Fully data-driven content (ready today, zero prose needed):** rankings, tiers, scores, confidence labels, per-mode performance, counters/strong-against, last-updated timestamps. These are the entirety of Phase 6C/6E's actual content and need no generation step beyond what Phase 5 already automates.

**B. Automatically generated editorial content (ranking explanations, strengths/weaknesses, FAQs, patch-impact summaries, comparison summaries) — explicitly NOT built in Phase 6, pending an AI-provider decision:**

If and when an AI provider is approved (spec Section 47 Q4, still unresolved per this repository's own tracked open decisions), the plan is:
- **Source grounding:** every generated field's prompt input is restricted to already-computed, already-published structured fields (tier, score, confidence, matchup data) — never raw battle data, per spec Section 12.1's hard boundary, already enforced structurally by the fact that the frontend/generation layer would only ever have access to `published_snapshot_items`-shaped data in the first place.
- **Prompt versioning:** a versioned prompt-template table/config, never edited in place (spec Section 12.2).
- **Model/provider abstraction:** a single internal interface so the provider can change without touching every call site.
- **Quality gates:** schema validation on every generated response; numeric-claim cross-checking against the grounding payload (spec Section 12.2's "post-generation validation pass," not prompt instruction alone).
- **Factual validation / hallucination prevention:** structural (grounding-input restriction + fact cross-check + schema validation), never "trust the prompt."
- **Duplicate detection:** a similarity check against previously generated text for other entities, avoiding template-feeling prose (spec Section 12.2).
- **Publication states:** generated text either passes validation and publishes atomically with the rest of that ranking run's snapshot, or falls back to the last accepted value / an empty state — never a half-generated field.
- **Stale-content refresh:** regenerated only when the underlying facts change meaningfully (spec Section 48 Q4's cost-control framing), not on every cycle regardless of change.
- **Rollback:** inherits the existing `published_snapshots.superseded_at` mechanism — no new rollback system needed.
- **Audit log:** a generation-run record (prompt version, model, inputs, output, validation result) — mirrors the rigor already applied to `ranking_runs`/`aggregation_runs` in this repository's existing backend.
- **Cost control / rate limits / retry behavior:** bounded batch generation per ranking-rebuild cycle, with the same retry/backoff philosophy already used throughout this codebase's ingestion layer (`lib/ingestion/retry.ts`) — not reinvented from scratch.

This entire sub-section (B) is a **plan for later**, not built in Phase 6.

**C. One-time static/legal content:** `/about`, `/disclaimer`, `/privacy-policy`, `/terms-of-service`, `/editorial-policy` — written once by a human, essentially never regenerated. This is expected and does not violate the "no manual workflow" directive, which targets *operational, recurring* content, not one-time legal boilerplate.

**D. Human-authored exception — guides:** per spec Section 12.6, guides are the one deliberate, narrow exception to automation-first. **This document marks this explicitly as a product decision requiring confirmation** before `/guides` is built at all (Section 16H) — and confirms plainly that this exception, if confirmed, is satisfied by a lightweight content-authoring path (e.g., MDX files or a minimal content table written to directly by a trusted contributor), **never** by building an admin dashboard to support it. No admin UI is planned anywhere in this document, for this or any other purpose.

## 20. SEO Keyword-to-Route Plan

Real, cleaned data from `keyword/*.csv` only — every Volume/CPC/KD figure below is copied verbatim from the supplied files. Rows with no real volume data available are labeled `[no data in supplied files]`, never invented.

**Cleaned Keyword Clusters**

| Cluster | Representative keywords (real Volume) | Target route |
|---|---|---|
| Tier list | `brawl stars tier list` (40,500), `brawlstars tier list` (1,600), `brawl stars character tier list` (590), `brawl stars tier` (590), `brawl stars rankings` (170) | `/tier-list` |
| Meta / updates | `brawl star meta` / `brawl stars meta` (4,400), `brawl stars updates` (2,400), `brawl stars update` (2,400), `brawl stars new update` (1,000), `brawl stars patch notes` (880), `meta brawl stars` (390), `current brawl stars meta` (320) | `/meta` (meta terms), `/updates` (update/patch terms — split cluster, two distinct intents sharing surface-level keyword similarity) |
| Best Brawler / player intent | `best brawlers in brawl stars` (12,100), `brawl stars best brawler` (1,900), `best brawlers right now` (320), `best legendary brawler` (260), `best mythic brawler` (320), `brawl stars top brawlers` (50) | `/best-brawlers` |
| Best Brawler by game mode | `best brawlers for brawl ball` (720), `best brawlers for ranked` (480), `best brawlers for gem grab` (480), `best brawlers for knockout` (390), `best brawlers for heist` (390), `best brawlers for hot zone` (320), `best brawlers for solo showdown` (210) | `/game-modes/[slug]` (one page absorbs both the "tier list for X" and "best brawlers for X" phrasing, per spec Section 16.3's consolidation rule) |
| Brawler directory | `brawl stars best characters` (170), `brawl stars hero list` (10) | `/brawlers` |
| Individual Brawler pages | `mortis brawl stars` / `brawl star mortis` (3,600 each), `mortis build` (590), `mortis guide` (170) — same pattern expected, not confirmed, for every other Brawler (only Mortis/Edgar/Surge have dedicated per-Brawler rows in the supplied files) | `/brawlers/[slug]` |
| Best build for [Brawler] | `best build for mortis` (210), `best build for surge` (140), `best build for edgar` (110) | `/brawlers/[slug]` build section — **currently unbuildable, Section 16H** |
| How to play [Brawler] | `how to play mortis` (320), `how to master mortis` (10) | `/brawlers/[slug]` (a "how to play" prose section — currently unbuildable without AI/editorial content, Section 19) |
| Best gears/gadget/star power for [Brawler] | `[no dedicated rows found in the supplied files beyond the general "best build" cluster above]` | `/brawlers/[slug]` build section — same blocker |
| Game mode pages (general) | `brawl stars game modes` (170), `game mode brawl stars` (40) | `/game-modes` |
| Comparisons | `[no dedicated high-relevance rows found in the supplied files]` | `/compare` — deferred regardless (Section 16H) |
| Guides | Overlaps the "how to play"/"best build" clusters above — no separate guide-specific cluster found | `/guides/[slug]` — deferred (Section 16H) |
| Updates / patch-related | `brawl stars patch notes` (880), `brawl star patch` (170), `patch notes brawl stars` (30) | `/updates` — deferred (Section 16H) |
| Navigational/branded | `[no "brawlranks" or brand-name rows exist in the supplied files — expected, since this is a new site with no existing search demand yet]` | `/` |

**Cannibalization risks identified directly from the data:**
- `brawl stars tier list` (40,500) appears verbatim in both `Tier List.csv` and `Meta.csv` — confirms spec Section 16.3's consolidation concern is real, not theoretical; `/tier-list` must remain the single canonical target, never split with `/meta`.
- `tier list brawl star` (880) appears in both `Meta.csv` and `Game Modes.csv` — same risk, same resolution.
- The "best brawlers for [mode]" and "tier list for [mode]" phrasings must consolidate onto the same `/game-modes/[slug]` page per spec Section 16.3 — confirmed directly relevant by the per-mode CSV files' own real volume data.

**Per-route SEO fields** (primary/secondary keyword, intent, content type, recommended sections, internal links, schema, canonical/indexation behavior) are already fully specified in Section 15's Metadata Template Matrix and Section 21's JSON-LD matrix — not duplicated a third time here.

## 21. Metadata and Structured-Data Plan

See Section 15 in full (Phase 6G's specification) — this section is the single authoritative copy.

## 22. Internal-Link Architecture

Governed entirely by spec Section 17.30's Internal-Linking Map, restricted at any given time to whichever routes are actually live per Section 8's route matrix (Section 16 of this document lists exactly which links are absent and why). No orphan pages: every shipped route must have at least one real inbound link from another shipped page before it ships, per spec Section 17.30's "orphan-page prevention" rule — verified manually during Phase 6G's QA pass, since the automated orphan-detection workflow (spec Section 32.1) is itself out of scope for Phase 6 (it's a content-freshness-workflow concern belonging to the same automation layer Section 19 defers).

## 23. Responsive UX Rules

Adopted directly, unmodified, from spec Section 17.32 (breakpoints: mobile <640px, tablet 640–1023px, desktop 1024–1439px, wide ≥1440px; grid columns, filter-control collapse behavior, sticky-element rules, table-to-card transforms, horizontal-scroll usage rules, font scaling, 44×44px minimum touch targets, modal/sheet behavior, navigation collapse). Every component in Section 9's matrix implements this table's row for its own UI pattern — not re-specified per component here to avoid a third copy of the same rules in one document.

## 24. Accessibility Plan

Target: WCAG 2.2 AA, per spec Section 17.33, applied to every shared component from Section 9:
- Semantic landmarks (`<header>`, `<nav>`, `<main>`, `<footer>`) on every page, exactly one `<main>`.
- Heading order: one `<h1>` per page, no skipped levels.
- Keyboard navigation and visible focus on every interactive element — no mouse-only interaction anywhere.
- Skip-to-content link in `Header`.
- Contrast: 4.5:1 body text, 3:1 large text/UI — verified against the actual tier-color palette chosen in Section 9 (a real risk area, since tier colors must also satisfy color-blind-safe differentiation, hence the pairing rule below).
- Tables (e.g., a future stats-comparison table on `/compare`, deferred): real `<th scope>`, never styled `<div>`s.
- Filters/tabs: `aria-pressed`/`aria-expanded`/`aria-controls` correctly applied (`FilterBar`, `FAQAccordion`, `TableOfContents`).
- Forms (`/contact`): errors associated via `aria-describedby`, announced via `aria-live="polite"`.
- Alt text: `"{Brawler name} portrait"` / `"{Item name} icon"` / `"{Mode name} icon"` exactly; decorative images `alt=""`.
- Reduced motion: any carousel/animation respects `prefers-reduced-motion`.
- Screen-reader labels for tier/confidence/movement indicators: `TierBadge` always pairs color with a real text label (never color-only), `MovementBadge` has an `aria-label` stating direction and magnitude in words (e.g., "moved up 2 tiers"), matching spec Section 17.31's explicit component requirement.
- Touch targets: minimum 44×44px on mobile/tablet.
- Dialog focus trap: `MobileFilterSheet`, search overlay, `MobileNav` — trap focus while open, restore focus to the trigger on close, `Escape` closes.

## 25. Performance and Rendering Plan

| Route | Rendering strategy | Revalidation |
|---|---|---|
| `/` | ISR | Publish-event tag (not built this pass, Section 9) + 1h fallback |
| `/tier-list` | SSG + ISR | `tier-list:overall` tag (fallback-only at first launch) + 6h fallback |
| `/meta` | ISR | Same pattern, 6h fallback |
| `/best-brawlers` | ISR | Same, 6h fallback |
| `/brawlers`, `/brawlers/[slug]` | SSG + ISR | 24h fallback (roster changes rarely); per-Brawler tag once the publish-webhook exists |
| `/game-modes`, `/game-modes/[slug]` | SSG + ISR | 24h fallback |
| `/counters` | ISR | 24h fallback |
| Static/legal pages | SSG | Manual redeploy only |
| `/search` (deferred) | SSR | Real-time, request-time |

**Server Components by default; Client Components only for:** filters/sort (`FilterBar`, `SortSelect`, `MobileFilterSheet`), search input, tab/accordion state (`FAQAccordion`, `TableOfContents`), share button, comparison selectors (deferred). This is not a preference — it is the same rule spec Section 17.1 and the `seo-technical` skill's December-2025 JS-SEO guidance (Section 6.6) both independently converge on: critical SEO elements must be in server-rendered HTML, not client-injected.

**Caching/fetch deduplication:** Next.js's built-in per-request fetch memoization, keyed by the typed API client's URL — a page and a nested component both requesting the same endpoint in one render never double-fetch.

**Image optimization:** `next/image` everywhere, explicit width/height on every image to prevent CLS, WebP/AVIF via Fan Kit asset pipeline (Section 6.4), lazy-loading below the fold, eager-loading for the LCP-critical hero image only.

**Preload/streaming/bundle splitting:** route-level code splitting is automatic under the App Router; no client-heavy page exists in this plan's Phase 6B–6F scope that would need manual `dynamic()` splitting beyond what Next.js already does by default — flagged as a non-issue given the server-components-first architecture, not ignored.

**Third-party scripts:** GA4 only (Section 26), loaded via Next.js's `next/script` with an appropriate strategy (`afterInteractive`), never blocking first paint.

**Core Web Vitals targets** (unchanged from spec Section 37): LCP ≤2.5s, INP ≤200ms, CLS ≤0.1 — validated in Phase 6G's QA pass using the `seo-technical`/`seo-page` skills' PageSpeed Insights/CrUX-based checks (Section 6.6), once a real deployed URL exists to measure.

## 26. Analytics and Observability

**Public GA4 events** (per spec Section 17.35/40, scoped to what Phase 6B–6F actually ships): `tier_list_view`, `tier_filter_change`, `tier_sort_change`, `brawler_view` (with `source` param), `mode_view`, `mode_filter_change`, `counter_view`, `matchup_lookup`, `share_click`, `trust_link_click`, `faq_expand`, `contact_submit` (category only — message body/email never sent to analytics, per spec's explicit privacy carve-out), `internal_search` (deferred with `/search`), `directory_filter_change`, `error_404_view`, `goal_select` (deferred with goal-based `/best-brawlers`), plus one new event this plan adds beyond the spec's original list: `stale_data_notice_viewed` (fires when the `PartialDataWarning`/staleness banner from Section 9 renders — needed because Phase 6 doesn't build the publish-webhook revalidation trigger in this pass, making staleness monitoring more operationally important than the spec originally assumed).

**No unnecessary personal information is collected** — matches spec Section 17.35's own privacy note exactly (query text for `internal_search` is never linked to a user-identifying field).

**Observability (new, not in the original spec's page-level analytics list, but required by this task):**
- Frontend error monitoring: every page's error boundary logs server-side (spec Section 17.1's existing rule), extended to also emit a structured log distinguishable from a public GA4 event (matching the existing internal/public separation principle already enforced in `lib/errors.ts`'s `logSafeError`).
- Public API error monitoring: every new `/api/public/**` route (Section 12) follows the exact `errorBody()`/`logSafeError()` pattern the internal routes already use — no new logging system needed, just consistent reuse.
- Cache/revalidation failure monitoring: flagged as a real gap (Section 30) — no publish-triggered webhook exists yet, so ISR fallback-only revalidation is the sole mechanism at first launch, and nothing currently alerts if a page silently goes stale beyond its fallback window.
- Broken-image monitoring: `next/image`'s own build-time/runtime error surfacing, plus a fallback-image strategy (Section 6.4) so a missing asset degrades visibly rather than breaking the layout.
- Indexation monitoring / sitemap-generation failure / no-current-snapshot alert: `/api/public/tier-list`'s existing `available:false` response is already the mechanism for the last of these; the first two are **not built in this pass** and are flagged as a Section 30 risk, not silently assumed solved.
- Post-publication smoke checks: **not built in this pass** — flagged in Section 29/30 as a real, small, recommended follow-up (a lightweight script hitting `/api/public/tier-list` + a couple of key pages after each deploy), not fabricated as already existing.

## 27. Testing and QA

| Test category | Scope | Tooling implication (not prescribing a specific library here) |
|---|---|---|
| Unit tests | Metadata helpers, JSON-LD helpers, canonical-URL builder, analytics helper | Same `node:test` convention already used throughout this repository's 305+ existing backend tests — no new test framework needed |
| API contract tests | Every `/api/public/**` endpoint, mirroring `tests/publicSnapshotRoute.test.ts`'s exact fake-pool + DB-gated pattern | Same |
| Component tests | Every item in Section 9's Shared Component Matrix | Requires a component-testing tool this repository does not yet have (e.g., React Testing Library) — a new devDependency, not assumed already present |
| Route rendering tests | Every page in Sections 10–14, against realistic fixture data shaped exactly like the real API responses | Same new tooling |
| Metadata/structured-data tests | Title/description length and uniqueness, canonical correctness, JSON-LD schema-shape validation per type | Unit-test-level, no new tooling beyond `node:test` |
| Accessibility tests | Automated checks (contrast, landmark presence, alt-text presence) as a baseline, manual keyboard/screen-reader pass for the interactive components (`FilterBar`, `MobileFilterSheet`, `FAQAccordion`) | Requires an accessibility-testing tool (e.g., axe) — new devDependency |
| Responsive visual QA | Manual pass across the 4 breakpoints (Section 23), cross-checked against `reference_pages/*.png` for direction-fidelity | Manual, not automatable from this repository alone |
| Empty/error/loading-state tests | Every component/page explicitly exercised against `available:false`, a network failure, and a partial-data response | Same component-testing tooling |
| Live-snapshot integration tests | Render Phase 6C pages against the real, current production `/api/public/tier-list` response | Same DB-gated pattern already used by every `*DbIntegration.test.ts` file in this repository (skips honestly when credentials are unavailable) |
| Sitemap/robots/canonical tests | Section 15's deliverables | Unit-test-level |
| Broken-link tests | Internal-link-graph audit (Section 22) against the actually-shipped route set | Could reuse a crawl-style check similar in spirit to the `seo-sitemap` skill's validation checklist (Section 6.6), run manually pre-launch rather than automated in CI at this stage |
| Image fallback tests | Confirm the fallback silhouette renders when a real asset is absent (Section 6.4) | Component-level |
| E2E smoke tests | A small number of critical user paths (view tier list, open a Brawler, view counters) | Requires an E2E tool (e.g., Playwright) — new devDependency, proportionate to add once real pages exist |
| Production post-deploy checks | The "post-publication smoke checks" flagged as missing in Section 26 | Recommended follow-up, not built in this pass |

No phase in this document is marked complete until its own acceptance checks (Sections 9–16's per-subphase "Exit criteria / DoD") actually pass — this rule applies retroactively to how this document itself should be used, not just prospectively.

## 28. Asset Attribution and Fan Kit Compliance

See Section 6.4 in full — the single authoritative copy of the Fan Kit compliance plan, image-source classification table, and disclaimer requirements. Restated as a binding rule for every subsequent phase: **no page, component, or piece of copy in Phase 6 may describe a Fan Kit-derived asset as BrawlRanks-owned, and no page may imply Supercell endorsement, sponsorship, or affiliation, anywhere, under any framing.**

## 29. Environment and Deployment Requirements

New environment variables required before Phase 6A can be implemented (added to `.env.example` as part of that subphase's own deliverables, not this planning document):

| Variable | Purpose | Currently present? |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | Canonical domain constant for every URL/canonical/OG/sitemap field | No |
| `APP_ENV` | `development`/`staging`/`production` — gates global noindex behavior | No |

**Not required for Phase 6 as scoped in this document** (each tied to an explicitly deferred capability): `AUTH_SECRET`/`ADMIN_EMAIL` (no admin dashboard, ever), `AI_PROVIDER_API_KEY` (Section 19B, deferred), `MONITORING_ALERT_WEBHOOK` (Section 26's flagged-but-deferred alerting gap).

**Deployment validation gaps to close before declaring Phase 6 launch-ready (flagged, not resolved, in this document):** no publish-triggered ISR revalidation webhook exists yet (Section 9/26) — first launch relies on fallback timers only, an honest, working, but not fully "instant on publish" posture; no post-deploy smoke-check script exists yet (Section 26/27); no backup-export/restore-test evidence was found in this repository during the prior investigation, which remains true and is not a Phase 6 concern to fix, but is a precondition worth confirming before a real public launch.

## 30. Risks and Blockers

**Risk Register**

| Risk | Classification | Detail |
|---|---|---|
| 3 of 6 real font files are licensing-blocked (`KoBrawl Gothic40.otf`, `KoBrawl Gothic60.otf`, `nougat-extrablack-webfont (2).ttf`) (Section 6.2) | **Blocker** for using those 3 specific fonts; **not** a blocker for Phase 6A overall — `Lilita One` and `Noto Sans CJK JP` are licensing-verified and usable now | `OS/2.fsType = 4` (restricted embedding) plus a commercial-foundry license field (KoBrawl Gothic) or no license metadata at all (Nougat); no license/attribution file exists anywhere in the repository to resolve this |
| No verified-license body-copy font exists (Section 6.2) | **Medium** | All 6 real font files are either display-only faces (small glyph sets, single weight) or an oversized CJK superset (Noto Sans CJK JP) — none is an efficient dedicated body-text face; mitigated short-term via `next/font/google` |
| Official API image-field presence is not yet verified against a primary source (Section 6.4A–D) | **Blocker** for full-fidelity `/brawlers`, `/brawlers/[slug]`, `/game-modes/[slug]` identity/media sections | `developer.brawlstars.com`'s real schema was not retrievable this session (JS-rendered SPA); the repository's own `raw_api_snapshots` table (migration 0004) holds the real answer but requires production DB credentials this session does not have — a concrete, low-risk verification query is documented in Section 6.4B but not yet run |
| No build/usage data source | **Blocker** for `/builds` and the build section of `/brawlers/[slug]` | Confirmed structurally absent (migration 0014's own header) |
| No guide content pipeline, and guides are spec-mandated human-authored | **Blocker** for `/guides` | Requires a product decision (Section 16H/19D), not a technical fix |
| No real official patch-notes source | **High** — limits `/updates` to thin/internal-only content | `patches.version_label` is internally inferred only |
| No AI provider selected | **High** — blocks every prose field (ranking reasons, FAQs, patch summaries, "how to play") across nearly every P0 page | Spec Section 47 Q4, still unresolved |
| No publish-triggered ISR revalidation webhook | **Medium** | Fallback-timer-only revalidation is functional but not "instant," and nothing alerts if it silently lags |
| No post-deploy smoke-check automation | **Medium** | Flagged, not built, in this pass |
| Legal/trust page copy may still require professional review | **Medium** | Phase 6B removed internal review markers from public copy; obtaining legal advice remains a product/launch responsibility, not a public UI banner |
| No component/accessibility/E2E testing tooling installed yet | **Medium** | New devDependencies needed in Phase 6A (Section 27) |
| Logo has no square/OG-ratio/favicon-ready export | **Low** | One-time derivation task from the existing 1536×1024 master (Section 6.1) |
| `/meta`'s tier-movement delta needs a small new endpoint | **Low** | Well-scoped, addressed directly in Section 12 |
| Only a small number of published snapshots exist so far (per this session's own prior confirmed evidence) | **Informational** | Correctly a data-maturity observation; resolves naturally over time, not a Phase 6 defect |
| `held_mass_movement` outcomes | **Informational** | Confirmed intentional guard behavior, not reopened per this task's own explicit instruction |

## 31. Implementation Sequence

| Order | Step | Depends on | Validation | Risk | Effort |
|---|---|---|---|---|---|
| 1 | Phase 6A — shared foundation | Section 6's asset findings (logo ready; `Lilita One`/`Noto Sans CJK JP` ready to wire in now; 3 fonts licensing-blocked; body-copy font still unsourced, use temporary `next/font/google` fallback for that role only) | Component/unit tests, build passes | Low | Large |
| 2 | Phase 6B — static/legal/trust pages | 6A | Render + metadata tests | Low | Small |
| 3 | Phase 6D — new public read APIs | 6A's API-client shape | Contract tests | Medium (mode-pivot logic) | Medium |
| 4 | Phase 6C — core live-data pages | 6A, 6D (for `/brawlers`, `/brawlers/[slug]`; `/tier-list`/`/best-brawlers` can start against the existing endpoint in parallel) | Live-snapshot integration tests | Medium | Large |
| 5 | Phase 6E — game modes and counters | 6D | Render tests | Low | Medium |
| 6 | Phase 6F — homepage | 6C, 6D, 6E all complete | Anti-cannibalization content-duplication test | Medium | Medium |
| 7 | Phase 6G — SEO/indexation layer | 6B–6F all shipping real routes | Sitemap/robots/schema tests, Rich Results Test | Low | Medium |
| 8 | Phase 6H — deferred hubs | Each row's own independent prerequisite (Section 16) — not sequenced relative to 6A–6G, since none of them block launch | Per-route, once unblocked | Varies | Varies |

This order matches this document's own Section 26 principle ("reuse shared systems before building individual pages... homepage is built after core hubs") and minimizes rework: no page in steps 2–7 is ever rebuilt because a shared component's contract changed after the fact.

## 32. Acceptance Criteria

Every route shipped in Phase 6B–6G must satisfy, at minimum: renders only real, verifiably-sourced data (Section 26's "no fake content" principle); passes its subphase's stated tests (Sections 9–16); has correct, unique metadata and valid structured data (Section 15); meets the WCAG 2.2 AA bar for its own component set (Section 24); has no orphaned inbound-link status (Section 22); and is present in the sitemap only if real (Section 15). Deferred routes (Section 16) satisfy acceptance by **correctly not existing yet**, not by existing in a degraded form.

## 33. Definition of Done

Phase 6 as a whole is done when: every P0 route from spec Section 41's MVP list either ships for real (Sections 10–15) or is honestly, visibly deferred with a stated, real prerequisite (Section 16 — never a placeholder route); the SEO layer (Section 15) is live and validated; the shared component/API/testing foundation (Sections 9, 12, 27) is in place and reusable for every subsequent addition (including whatever eventually unblocks Section 16's deferred hubs); every font actually wired into `next/font/local` has a confirmed, non-"should not be used until verified" licensing status (Section 6.2); and no page anywhere in the shipped set contains fabricated content, a fake image, an invented statistic, or an implied Supercell endorsement.

## 34. Final Phase 6 Launch Checklist

- [ ] `NEXT_PUBLIC_SITE_URL` and `APP_ENV` set correctly in production
- [ ] `app/robots.ts` allows indexing only in `production`
- [ ] `app/sitemap.ts` contains only real, currently-published routes
- [ ] Every shipped page passes its subphase's acceptance criteria (Section 32)
- [ ] No fabricated Brawler identity data, image, statistic, or prose anywhere
- [ ] Every Fan Kit-derived asset is attributed and never described as BrawlRanks-owned
- [ ] Disclaimer/footer language present sitewide, legal pages reviewed (not just drafted)
- [ ] Structured data validates in Google's Rich Results Test for every schema type in use
- [ ] Core Web Vitals targets met on `/`, `/tier-list`, `/brawlers/[slug]` (spec Section 37)
- [ ] Accessibility pass complete (Section 24) on every shared component and page template
- [ ] No admin dashboard, no recurring manual publishing step, anywhere in the shipped system
- [ ] `held_mass_movement`/no-change/publication-guard behavior from Phase 5 remains untouched and working
- [ ] `KoBrawl Gothic40.otf`, `KoBrawl Gothic60.otf`, and `nougat-extrablack-webfont (2).ttf` are either confirmed licensing-clear and documented as such, or excluded entirely from the shipped `next/font/local` set (Section 6.2)
- [ ] The Section 6.4B read-only `raw_api_snapshots` verification query has been run at least once against a real production payload (or the site launches on the Fan Kit-only assumption with that gap explicitly acknowledged, not silently dropped)
- [ ] Every deferred route (Section 16) is absent from navigation and the sitemap, not a placeholder shell
- [ ] Post-deploy smoke check run at least once against real production data before calling launch complete
