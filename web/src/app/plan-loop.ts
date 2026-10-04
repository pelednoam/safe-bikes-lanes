// A round trip: how long it may be, and planning it from where the rider is.

import { store } from "./store.js";
import { ensureRouter, poisReady, showStage } from "./data-load.js";
import { el } from "./dom.js";
import { fmtDistTight, getUnits, toMeters, unitName, unitShort } from "../units.js";
import { routing, trip } from "./services.js";
import { selectOption } from "./plan-options.js";
import { maplibregl } from "../maplibre.js";
import { map } from "./map.js";
import { POI_META } from "./classes.js";
import { beginPlan, locateStart, plainError } from "./plan-route.js";
import { routingInputsReady } from "./avoid.js";

/** How long a round trip can be, in the units the rider types in. The field's
 * own min/max are advice a browser doesn't enforce on typing: Firebase Test
 * Lab's explorer typed 44,303 and then 57,773 miles, and both were taken. A
 * loop's corridor reaches half its length in every direction, so an absurd one
 * would try to pull in every routing tile there is. Round numbers per unit
 * system, not one limit converted: "31.1 mi" can't be both what the message
 * says and what the check allows. */
export const LOOP_LIMITS: Record<"imperial" | "metric", [min: number, max: number]> = {
  imperial: [0.5, 30],
  metric: [1, 50],
};

export async function requestLoop(): Promise<void> {
  if (store.navActive) return; // a new round trip is not something to swap in mid-ride
  const ticket = beginPlan();
  await routingInputsReady();
  if (ticket.stale()) return;
  const errBox = el<HTMLDivElement>("error");
  errBox.style.display = "none";
  // the distance first: an impossible one shouldn't ask for the rider's
  // location before saying so
  const typed = Number(el<HTMLInputElement>("loop-dist").value);
  if (!Number.isFinite(typed) || typed <= 0) {
    errBox.textContent = `How far would you like to ride? Enter a distance in ${unitName()}.`;
    errBox.style.display = "block";
    return;
  }
  const [loopMin, loopMax] = LOOP_LIMITS[getUnits()];
  if (typed < loopMin || typed > loopMax) {
    errBox.textContent =
      `A round trip can be ${loopMin} to ${loopMax} ${unitShort()} long. ` +
      "How far would you like to ride?";
    errBox.style.display = "block";
    return;
  }
  const targetM = toMeters(typed);
  if (!store.start) {
    // A round trip starts where you are, so find that rather than refusing.
    // Telling someone to "click the map to set a start point first" is asking
    // them to do work the app can do, in answer to a button they just pressed.
    const located = await locateStart(
      ticket,
      "Couldn't get your location — tap 🗺 next to the start field to pick where the ride begins.",
    );
    if (located === null) return;
  }
  await poisReady;
  if (ticket.stale()) return;
  const km = targetM / 1000;
  const kind = el<HTMLSelectElement>("loop-stop").value;
  // null is "no stop wanted" — the router picks a turnaround geometrically,
  // because sometimes the point is just to be out. An empty list is different:
  // it means the stop they asked for has none near enough, which is an error.
  const candidates =
    kind === "none" ? null : kind === "any" ? store.pois : store.pois.filter((p) => p.properties.kind === kind);
  const loading = el<HTMLDivElement>("loading");
  showStage("Loading the map around you…");
  const progress = (done: number, total: number): void => {
    if (total > 4 && !ticket.stale()) {
      showStage("Loading the map around you…", `${done} of ${total}`);
    }
  };
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (ticket.stale() || !store.start) return;
  try {
    const s = store.start.getLngLat();
    // a loop can range out to roughly half its length from the start
    const mapped = await ensureRouter([[s.lng, s.lat]], targetM / 2, 2, progress);
    if (ticket.stale()) return;
    if (!mapped) throw new Error("this area isn't mapped for routing yet");
    showStage(`Finding a ${fmtDistTight(targetM)} loop…`);
    const { option, poi, more } = await routing.loopRoute(
      [s.lng, s.lat],
      targetM,
      candidates,
      store.profileId,
      store.preferFlat,
    );
    if (ticket.stale()) return;
    store.end?.remove();
    store.end = null;
    // a choice of loops, not a verdict: the runner-ups go in the same option
    // cards the point-to-point router uses, so picking between them is the
    // gesture the rider already knows
    if (!trip.publish(ticket, [option, ...more.map((m) => m.option)])) return;
    store.loopParams = { km, kind };
    selectOption("loop");
    store.poiMarker?.remove();
    store.poiMarker = null;
    if (poi !== null) {
      // no marker on a ride with no stop: the loop is the whole of it
      store.poiMarker = new maplibregl.Marker({ color: "#e67e22" })
        .setLngLat(poi.geometry.coordinates)
        .addTo(map);
      const meta = POI_META[poi.properties.kind];
      store.poiMarker.getElement().title =
        `${meta?.emoji ?? ""} ${poi.properties.name || meta?.label || "stop"}`;
    }
  } catch (err) {
    if (ticket.stale()) return;
    errBox.textContent = plainError(err);
    errBox.style.display = "block";
  } finally {
    if (!ticket.stale()) loading.style.display = "none";
  }
}
