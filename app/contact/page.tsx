import type { Metadata } from "next";
import { ContactContent, CONTACT_METADATA, type ContactImageSrcs } from "@/components/contact/ContactContent";
import { buildMetadata } from "@/lib/seo/metadata";

import iconInbox from "../../reference_pages/contact/icon_inbox.png";
import iconCalendar from "../../reference_pages/contact/icon_calendar_league_day.png";
import iconWarning from "../../reference_pages/contact/warning_icon.png";
import iconTick from "../../reference_pages/contact/tick.png";
import iconSilentRed from "../../reference_pages/contact/img_silent_red.png";
import iconHunters from "../../reference_pages/contact/icon_hunters.png";
import iconSettings from "../../reference_pages/contact/icon_settings.png";
import iconPinBattle from "../../reference_pages/contact/pin_battle_button.png";
import character from "../../reference_pages/contact/barley_maple_barley_001.png";
import gemGrab from "../../reference_pages/contact/gem_grab_icon.png";
import gemRed from "../../reference_pages/contact/gem_red.png";

export const metadata: Metadata = buildMetadata(CONTACT_METADATA);

const images: ContactImageSrcs = {
  iconInbox: iconInbox.src,
  iconCalendar: iconCalendar.src,
  iconWarning: iconWarning.src,
  iconTick: iconTick.src,
  iconSilentRed: iconSilentRed.src,
  iconHunters: iconHunters.src,
  iconSettings: iconSettings.src,
  iconPinBattle: iconPinBattle.src,
  character: character.src,
  gemGrab: gemGrab.src,
  gemRed: gemRed.src,
};

export default function ContactPage() {
  return <ContactContent images={images} />;
}
