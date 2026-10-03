// Night rides: the dark basemap and the dark UI, remembered across launches, and
// light until the rider turns it on, whatever the phone's own theme says.

import { el } from "./dom.js";
import { store } from "./store.js";
import { map } from "./map.js";
import { type BasemapTheme } from "../basemap.js";
import { basemap } from "./services.js";
import { CLASS_MARKS, MARK_INK, TICK_INK_DARK, classWidth, isTick } from "./classes.js";
import { setSystemBarsDark } from "../native.js";
import { readItem, writeItem } from "../storage.js";

export const DARK_KEY = "darkMode";

export function applyBasemap(): void {
  const dark = document.body.classList.contains("dark");
  const aerial = el<HTMLInputElement>("show-aerial").checked;
  const netOn = el<HTMLInputElement>("show-net").checked;
  // while riding, the map is turned to the heading: drop the basemap's baked
  // labels and draw our own, which stay the right way up
  const plain = store.navActive;
  const setVis = (): void => {
    // Skip layers that aren't added yet: this runs during map load too, from
    // whichever data callback lands first, and setLayoutProperty throws on an
    // unknown id — which took the calling chain (and the route panel) with it.
    const vis = (id: string, on: boolean): void => {
      if (map.getLayer(id) !== undefined) {
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      }
    };
    vis("aerial", aerial);
    // One theme at a time, its label layers dropped while riding, and the whole
    // basemap off under the aerial view. show() is instant for a theme already
    // installed; ensure() covers the first use of one, then shows it.
    const wanted = {
      theme: (dark ? "dark" : "light") as BasemapTheme,
      labels: !plain,
      on: !aerial,
    };
    basemap.show(wanted);
    void basemap
      .ensure(wanted.theme)
      .then(() => basemap.show(wanted))
      .catch((err: unknown) => {
        // No basemap is a degraded map, not a broken app: the route, the
        // network and the aerial view all still draw, over the ground colour.
        // But say so — "the basemap is quietly missing" is a failure this app
        // has shipped before, and it looks identical to a slow network.
        console.warn("basemap failed to load", err);
      });
    // not gated on the network toggle: with the basemap's labels gone, hiding
    // the network would leave a map with no names on it at all
    vis("street-labels", plain);
    if (map.getLayer("street-labels") !== undefined) {
      map.setPaintProperty("street-labels", "text-color", dark || aerial ? "#f2f5fa" : "#1d2430");
      map.setPaintProperty(
        "street-labels",
        "text-halo-color",
        dark || aerial ? "rgba(10,14,22,0.9)" : "rgba(255,255,255,0.92)",
      );
    }
    if (map.getLayer("route-casing") !== undefined) {
      map.setPaintProperty("route-casing", "line-color", dark || aerial ? "#9db8ff" : "#1440a0");
    }
    if (map.getLayer("alts") !== undefined) {
      map.setPaintProperty("alts", "line-color", dark || aerial ? "#ccc" : "#777");
    }
    // over photos the lanes need contrast: dark halo + thicker, solid lines
    vis("network-casing", aerial && netOn);
    const [lo, hi] = aerial ? [2.0, 5.0] : [1.2, 3.5];
    const width = classWidth(lo, hi);
    for (const m of CLASS_MARKS) {
      const id = `network-mark-${m.id}`;
      if (map.getLayer(id) === undefined) continue;
      map.setPaintProperty(id, "line-width", classWidth(lo, hi, m.scale));
      map.setPaintProperty(id, "line-opacity", plain ? 0.3 : 0.75);
      if (isTick(m)) {
        map.setPaintProperty(id, "line-color", dark && !aerial ? TICK_INK_DARK : MARK_INK);
      }
    }
    for (const layer of ["network", "network-unconfirmed"]) {
      if (map.getLayer(layer) === undefined) continue;
      map.setPaintProperty(layer, "line-width", width);
      // the network is drawn in the same palette as the route, so while riding
      // it steps back: the line you're following has to be the obvious one.
      // This lives here rather than in startNav because any later call would
      // otherwise undo the dim.
      map.setPaintProperty(layer, "line-opacity", plain ? 0.35 : aerial ? 0.95 : 0.75);
    }
  };
  // map.loaded() is false whenever tiles are streaming, and "load" fires only
  // once per map — gate on layer existence instead, or toggles made while
  // tiles load would be silently dropped.
  //
  // "aerial" is the first layer the load handler adds, so its presence means
  // the others are there too. It used to be "osm-dark", one of the raster
  // basemaps; when those gave way to the vector basemap the id stopped
  // existing, this test went permanently false, and every call queued itself
  // behind a "load" event that had already fired — leaving the basemap added
  // but invisible, with nothing logged.
  if (map.getLayer("aerial") !== undefined) setVis();
  else map.once("load", setVis);
}

export function applyDark(dark: boolean): void {
  document.body.classList.toggle("dark", dark);
  el<HTMLInputElement>("dark-mode").checked = dark;
  setSystemBarsDark(dark); // the status bar icons follow the app's theme, not the phone's
  applyBasemap();
}

export function initDarkMode(): void {
  // Light by default: this is a daylight map, and the basemap + safety colours
  // are tuned for it. Dark is opt-in and remembered — following the phone's
  // system theme turned it on for riders who never asked for it.
  applyDark(readItem(DARK_KEY) === "1");

  el<HTMLInputElement>("dark-mode").addEventListener("change", (e: Event) => {
    const dark = (e.target as HTMLInputElement).checked;
    writeItem(DARK_KEY, dark ? "1" : "0");
    applyDark(dark);
  });

  el<HTMLInputElement>("show-aerial").addEventListener("change", applyBasemap);
}
