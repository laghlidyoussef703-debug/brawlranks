import type { Metadata } from "next";
import { TermsOfServiceContent, TERMS_OF_SERVICE_METADATA, type TermsImageSrcs } from "@/components/terms-of-service/TermsOfServiceContent";
import { buildMetadata } from "@/lib/seo/metadata";

import iconQuest from "../../reference_pages/Terms of Service/icon_quest.png";
import tick from "../../reference_pages/Terms of Service/tick.png";
import warningIcon from "../../reference_pages/Terms of Service/warning_icon.png";
import iconMagnet from "../../reference_pages/Terms of Service/icon_in_game_BrawlersMagnet_1_active.png";
import wipeoutIcon from "../../reference_pages/Terms of Service/wipeout_icon.png";
import warningExclamation from "../../reference_pages/Terms of Service/image_warning_pop_up_exclamation.png";
import iconGym from "../../reference_pages/Terms of Service/icon_skin_category_gym.png";
import iconSpeed from "../../reference_pages/Terms of Service/icon_speed.png";
import iconSettings from "../../reference_pages/Terms of Service/icon_settings.png";
import iconKnockout from "../../reference_pages/Terms of Service/icon_knockout_5v5_power_level.png";
import mapMaker from "../../reference_pages/Terms of Service/map_maker_icon.png";
import gemRed from "../../reference_pages/Terms of Service/gem_red.png";
import iconInbox from "../../reference_pages/Terms of Service/icon_inbox.png";

export const metadata: Metadata = buildMetadata(TERMS_OF_SERVICE_METADATA);

const images: TermsImageSrcs = {
  iconQuest: iconQuest.src,
  tick: tick.src,
  warningIcon: warningIcon.src,
  iconMagnet: iconMagnet.src,
  wipeoutIcon: wipeoutIcon.src,
  warningExclamation: warningExclamation.src,
  iconGym: iconGym.src,
  iconSpeed: iconSpeed.src,
  iconSettings: iconSettings.src,
  iconKnockout: iconKnockout.src,
  mapMaker: mapMaker.src,
  gemRed: gemRed.src,
  iconInbox: iconInbox.src,
};

export default function TermsOfServicePage() {
  return <TermsOfServiceContent images={images} />;
}
