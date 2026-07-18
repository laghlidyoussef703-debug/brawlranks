import type { Metadata } from "next";
import { EditorialPolicyContent, EDITORIAL_POLICY_METADATA, type EditorialImageSrcs } from "@/components/editorial-policy/EditorialPolicyContent";
import { buildMetadata } from "@/lib/seo/metadata";

// Local, page-specific assets from reference_pages/editorial-policy/. Static
// imports let Next's build fingerprint/optimize each PNG; only the resolved
// `.src` string is handed to the content component (kept bundler-agnostic so
// the plain tsx test runner can render it with fixture paths).
import iconSettings from "../../reference_pages/editorial-policy/icon_settings.png";
import foldableRobotPin from "../../reference_pages/editorial-policy/foldable_robot_pin.png";
import iconHunters from "../../reference_pages/editorial-policy/icon_hunters.png";
import tick from "../../reference_pages/editorial-policy/tick.png";
import emojiMobaCenter from "../../reference_pages/editorial-policy/emoji_moba_center.png";
import shieldFront from "../../reference_pages/editorial-policy/shield_front.png";
import mysteryIcon from "../../reference_pages/editorial-policy/mystery_icon.png";
import iconQuest from "../../reference_pages/editorial-policy/icon_quest.png";
import iconCalendarLeagueDay from "../../reference_pages/editorial-policy/icon_calendar_league_day.png";
import iconLeaderboardDemonic from "../../reference_pages/editorial-policy/icon_leaderboard_demonic.png";
import warningIcon from "../../reference_pages/editorial-policy/warning_icon.png";
import wipeoutIcon from "../../reference_pages/editorial-policy/wipeout_icon.png";
import iconModifierTimedeto from "../../reference_pages/editorial-policy/icon_modifier_timedeto.png";
import pinBattleButton from "../../reference_pages/editorial-policy/pin_battle_button.png";
import bannerCharacter from "../../reference_pages/editorial-policy/barley_maple_barley_001.png";
import gemGrabIcon from "../../reference_pages/editorial-policy/gem_grab_icon.png";
import gemRed from "../../reference_pages/editorial-policy/gem_red.png";

export const metadata: Metadata = buildMetadata(EDITORIAL_POLICY_METADATA);

const images: EditorialImageSrcs = {
  iconAutomated: iconSettings.src,
  iconAiAssisted: foldableRobotPin.src,
  iconHuman: iconHunters.src,
  tick: tick.src,
  noteStar: emojiMobaCenter.src,
  stepDataCollection: shieldFront.src,
  stepValidation: mysteryIcon.src,
  stepQualityChecks: iconQuest.src,
  stepPublish: iconCalendarLeagueDay.src,
  policyUnsupported: iconLeaderboardDemonic.src,
  policyCorrections: warningIcon.src,
  policyConflict: wipeoutIcon.src,
  policyFreshness: iconModifierTimedeto.src,
  policySource: iconQuest.src,
  policyRankings: pinBattleButton.src,
  bannerCharacter: bannerCharacter.src,
  decorStar: emojiMobaCenter.src,
  decorSkull: wipeoutIcon.src,
  decorFace: gemGrabIcon.src,
  decorGem: gemRed.src,
};

export default function EditorialPolicyPage() {
  return <EditorialPolicyContent images={images} />;
}
