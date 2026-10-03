// The functions one part of the app needs from another that imports it (see
// src/hooks.ts). Each is set once, by the module that has the function, as the
// app starts; until the part that has it moves into its own module, app.ts does.
import { hook } from "../hooks.js";

export const links = {
  /** Read the hazards stored on the device and redraw them. */
  refreshHazards: hook<[], Promise<void>>("refreshHazards"),
  /** Plan the route for the two ends as they stand. */
  requestRoute: hook<[], Promise<void>>("requestRoute"),
  /** Grade the search rows on screen again, after something that changes the grade. */
  regradeVisible: hook<[], void>("regradeVisible"),
  /** Plan between two points the rider picked from a list. */
  planBetween: hook<[start: [number, number], end: [number, number]], void>("planBetween"),
  /** Draw the marked spots' list again, after they were replaced (a restored backup). */
  renderSketchy: hook<[], void>("renderSketchy"),
  /** Close the card that follows the pointer over the map. */
  dropHoverCard: hook<[], void>("dropHoverCard"),
  /** Open the hazard report dialog at a place. */
  openHazardDialog: hook<[lon: number, lat: number], void>("openHazardDialog"),
};
