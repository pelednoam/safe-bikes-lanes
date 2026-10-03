// What a tap on a map layer opens: each layer registers its own handler, and the
// one map click answers with the most specific.

import { type MapLayerMouseEvent } from "maplibre-gl";

/** What a tap on the map means, decided in one place (onMapTap).
 *
 * Every layer used to answer its own taps with map.on("click", layer, …), and
 * the plain map click answered them all again: the listeners fired in the order
 * they happened to be registered, and each guessed what the others did. So a
 * tap on a construction site also planned a trip to it, two overlapping layers
 * both opened a card, and the fix for the first broke dismissing the ride's
 * stops menu. A layer now registers what a tap on it opens, and onMapTap picks
 * one thing to do. */
export type TapOpen = (e: MapLayerMouseEvent) => void;

export interface TapTarget {
  open: TapOpen;
  /** Also set a trip point, as a tap on bare map would. Only for destinations:
   * tapping a playground is a fair way to say "take us there". */
  alsoSetsPoint: boolean;
}

/** Most specific first: when a tap lands on several, only the first opens. A
 * rider's own hazard report outranks the permit beneath it, which outranks the
 * planner's layers, which outrank a place. */
export const TAP_ORDER = [
  "hazardpts",
  "construction-pts",
  "construction-lines",
  "gateways",
  "crossings",
  "build",
  "pois",
] as const;

export type TapLayer = (typeof TAP_ORDER)[number];

export const tapTargets = new Map<TapLayer, TapTarget>();

export function onTap(layer: TapLayer, open: TapOpen, alsoSetsPoint = false): void {
  tapTargets.set(layer, { open, alsoSetsPoint });
}
