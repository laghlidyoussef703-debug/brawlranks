"use client";

import { useEffect } from "react";
import { ErrorContent, type ErrorImageSrcs } from "@/components/error/ErrorContent";

import character from "../reference_pages/Error/error1.png";
import tierList from "../reference_pages/Error/icon_skin_cursed.png";
import brawlers from "../reference_pages/Error/icon_in_game_BrawlersMagnet_1_active.png";
import gameModes from "../reference_pages/Error/htt_summer_game_mode_icons_800x800.png";
import guides from "../reference_pages/Error/icon_map_info.png";
import help from "../reference_pages/Error/showdown_icon.png";

const images: ErrorImageSrcs = {
  character: character.src,
  tierList: tierList.src,
  brawlers: brawlers.src,
  gameModes: gameModes.src,
  guides: guides.src,
  help: help.src,
};

/**
 * Root error boundary (spec Section 17.28). Rendered inside the root
 * layout, so it keeps the shared Header/Footer. The underlying error is
 * logged for engineering visibility but never surfaced to the user — no
 * stack trace, message, or digest is rendered anywhere in the UI. "Try
 * again" re-attempts the failed render via Next.js's reset().
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return <ErrorContent images={images} onRetry={reset} />;
}
