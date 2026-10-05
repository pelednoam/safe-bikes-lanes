// What the browser tests reach the page through: counters the app keeps for them, and the map.

import type { Map as MLMap } from "maplibre-gl";

import { map } from "./map.js";

declare global {
  interface Window {
    /** Test hook: how many hazard warnings have been displayed. */
    __navAlertsSeen?: number;
    /** Test hook: how many times search-grading has actually started routing.
     *
     * Here for the same reason as the counter above. Grading is up to five
     * routing runs on the main thread, and it must never start mid-ride — but it
     * works on rows the panel has already replaced, so nothing about it is
     * visible in the DOM by then. The only other instrument was timing, and a
     * loaded machine blocks the main thread for longer than a routing run does,
     * so that test failed on the runner rather than on the app. */
    __regradesStarted?: number;
    /** Test hook: panel paints still watching the map for their route to draw.
     * Each watches every frame until it fires or is superseded, so one that
     * never stops is a leak; before this hook the test counted MapLibre's
     * private _listeners, which the next upgrade could quietly empty. */
    __panelPaintsWaiting?: number;
    /** Set as app.js starts running; compat.js reads it (see there). */
    __appStarted?: boolean;
    _map?: MLMap;
  }
}

/** E2E (Playwright) asserts on live layer state through window._map. */
export function exposeMapToTests(): void {
  window._map = map;
}
