// The hover popup and the street card it shows, shared by the layers that open a card.

import type { Popup } from "maplibre-gl";

import { SegmentCardView } from "../ui/SegmentCard.js";

/** The hover popup on the map now, if any: one at a time. */
export const hover: { popup: Popup | null } = { popup: null };

/** The street card the hover popup shows (src/ui/SegmentCard.tsx). */
export const segmentCard = new SegmentCardView();

/** Take the hover card down for a click card of the same thing. Both open on a
 * desktop tap — the pointer is over it — and two cards over one spot is noise;
 * the click card is the one with a close button, so it stays. */
export function dropHoverCard(): void {
  hover.popup?.remove();
  hover.popup = null;
}
