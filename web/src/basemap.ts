// ---------------------------------------------------------------------------
// The basemap: this region's streets, water, parks and names, from our own file.
//
// It came from Carto until September 2026. First their raster tiles came back
// with "API KEY REQUIRED" stamped across every one, found by users, not by
// monitoring, because nothing 404s and nothing throws. Then the map ran on
// Carto's vector tiles, still a third party's servers and terms. Now the tiles
// are one file, basemap.pmtiles, cut from Protomaps' OpenStreetMap build for
// this region (scripts/publish-basemap.sh) and served by the site itself. Its
// look is Protomaps' light and dark styles, built here in the page rather
// than fetched, so there's no style to download or cache either.
//
// Each theme's layers are added once and then toggled by visibility, rather
// than swapped with map.setStyle, which would tear down and re-add every layer
// this app puts on top (the route, the network, the overlays) on each flip.
// Label-free mode is the same layers with the symbol ones hidden.
// ---------------------------------------------------------------------------

import { layers as protomapsLayers, namedFlavor } from "@protomaps/basemaps";
import type { LayerSpecification, Map as MLMap, VectorSourceSpecification } from "maplibre-gl";
import { PMTiles } from "pmtiles";

import { isNativeApp } from "./native.js";
import { type CacheDeps, installTileCache, TILE_TEMPLATE } from "./tilecache.js";

export type BasemapTheme = "light" | "dark";

/** The source every basemap layer draws from. */
export const BASEMAP_SOURCE = "basemap";

/** The file stops at zoom 14, as Carto's tiles did; MapLibre overzooms them for
 * closer views, and the offline download only needs to go this deep. */
export const BASEMAP_MAXZOOM = 14;

export const BASEMAP_ATTRIBUTION =
  '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>';

/** Where the site serves the basemap file: the Android app, which doesn't carry
 * it, reads the site's copy. */
const SITE_BASEMAP = "https://pelednoam.github.io/safe-bikes-lanes/basemap.pmtiles";

/** The basemap file for this page. Every page's bundle sits at the site root,
 * beside the file, so it's found from the bundle's own address, from any page
 * (/, /build/, /somerville/). */
export function basemapUrl(): string {
  return isNativeApp() ? SITE_BASEMAP : new URL(/* @vite-ignore */ "./basemap.pmtiles", import.meta.url).href;
}

/** The label glyphs this app ships (see VENDORED_FONT_STACK), for any page. */
export function glyphsUrl(): string {
  return `${new URL(/* @vite-ignore */ "./fonts/glyphs/", import.meta.url).href}{fontstack}/{range}.pbf`;
}

/** The basemap's source, for a page's style. */
export function basemapSource(): VectorSourceSpecification {
  return {
    type: "vector",
    tiles: [TILE_TEMPLATE],
    maxzoom: BASEMAP_MAXZOOM,
    attribution: BASEMAP_ATTRIBUTION,
  };
}

/**
 * The one glyph stack this app ships (web/public/fonts/glyphs, Noto Sans: Latin,
 * Latin-1 and Extended-A, general punctuation, and the box/symbol ranges that
 * hold trail-difficulty marks; see ASSETS in sw.js).
 *
 * A style gets exactly one `glyphs` URL, and it has to stay the vendored one:
 * ride-mode street names are drawn from a symbol layer and have to keep working
 * with no network. Protomaps' layers ask for Noto Sans Regular, Medium and
 * Italic, some through an expression choosing between them. A stack the
 * directory doesn't have would request ranges that 404, and those labels would
 * simply not draw: no error, just a map with no names. So every label is drawn
 * in the Regular the others are cut from.
 */
export const VENDORED_FONT_STACK = ["Noto Sans Regular"];

const layerId = (prefix: string, theme: BasemapTheme, id: string): string => `${prefix}-${theme}-${id}`;

/**
 * One theme's layers, re-identified, re-fonted, and hidden until shown.
 *
 * No sprite: layers drawing only an icon (one-way arrows, route shields, POI
 * pins) are left out, and those drawing an icon beside their text (town dots)
 * keep the text. One fewer file to serve and cache, and the POIs this app
 * shows are its own.
 */
export function basemapLayers(
  theme: BasemapTheme,
  opts: { labelsOnly?: boolean; flavor?: BasemapTheme; prefix?: string } = {},
): LayerSpecification[] {
  const prefix = opts.prefix ?? "bm";
  const out: LayerSpecification[] = [];
  const source = protomapsLayers(BASEMAP_SOURCE, namedFlavor(opts.flavor ?? theme), {
    lang: "en",
    labelsOnly: opts.labelsOnly ?? false,
  });
  for (const src of source) {
    const layout: Record<string, unknown> = { ...(src.layout as object | undefined) };
    if (layout["icon-image"] !== undefined) {
      if (layout["text-field"] === undefined) continue;
      delete layout["icon-image"];
    }
    if (layout["text-font"] !== undefined) layout["text-font"] = VENDORED_FONT_STACK;
    layout["visibility"] = "none";
    // A LayerSpecification is a union discriminated on `type`; spreading and
    // re-typing keeps that narrowing rather than widening every branch.
    out.push({ ...src, id: layerId(prefix, theme, src.id), layout } as LayerSpecification);
  }
  return out;
}

type AddProtocol = Parameters<typeof installTileCache>[0];

/** MapLibre's addProtocol, from the global maplibre.ts sets. Read rather than
 * imported, so this module stays importable in unit tests, which have no map. */
function globalAddProtocol(): AddProtocol | undefined {
  const lib = (globalThis as { maplibregl?: { addProtocol?: AddProtocol } }).maplibregl;
  return lib?.addProtocol;
}

/** The tile cache's link to the basemap file: tiles read out of it by byte
 * range, one PMTiles reader per page. Null where there's no CacheStorage
 * (only secure contexts have it), which the protocol can't do without. */
let deps: CacheDeps | null | undefined;
export function tileDeps(): CacheDeps | null {
  if (deps !== undefined) return deps;
  if (typeof caches === "undefined") return (deps = null);
  const file = new PMTiles(basemapUrl());
  return (deps = {
    caches,
    readTile: async (z, x, y, signal) => (await file.getZxy(z, x, y, signal))?.data,
  });
}

export interface Basemap {
  /** Add one theme's layers, if not already on the map. Per theme, not both:
   * a rider who never opens night mode doesn't pay for its seventy layers. */
  ensure(theme: BasemapTheme): Promise<void>;
  /** Show one theme, with or without labels; `on: false` shows no basemap.
   * The last request is remembered and re-applied when late layers land. */
  show(opts: { theme: BasemapTheme; labels: boolean; on: boolean }): void;
}

export interface BasemapOptions {
  /** Install only the label layers, for drawing street and place names over
   * something else, such as aerial photography. */
  labelsOnly?: boolean;
  /** Draw every theme in this look. The photo labels use the dark one, drawn
   * light on dark, which is what reads over aerial imagery. */
  flavor?: BasemapTheme;
  /** Layer id prefix. Two instances on one map need different ones, or their
   * layers collide. Defaults to "bm", which the planner and its tests expect. */
  prefix?: string;
}

/**
 * Manage the basemap's layers on `map`, inserting them beneath the layer that
 * `anchor` names. `anchor` is a callback rather than an id because the caller
 * adds its own layers as the map loads, after this is created.
 */
export function createBasemap(map: MLMap, anchor: () => string | undefined, options: BasemapOptions = {}): Basemap {
  // Here rather than at each call site: every page builds its basemap through
  // this, right after constructing its map, before the first tile is asked for.
  const addProtocol = globalAddProtocol();
  const cacheDeps = tileDeps();
  if (addProtocol !== undefined && cacheDeps !== null) installTileCache(addProtocol, cacheDeps);
  // The source itself is in each page's initial style (basemapSource()): the
  // style is still loading here, when adding one would throw.

  const installed = new Map<BasemapTheme, { all: string[]; labels: Set<string> }>();
  /** The most recent show() request, re-applied when a theme's layers land. */
  let wanted: { theme: BasemapTheme; labels: boolean; on: boolean } | null = null;

  const show = (opts: { theme: BasemapTheme; labels: boolean; on: boolean }): void => {
    wanted = opts;
    for (const [theme, group] of installed) {
      const active = opts.on && theme === opts.theme;
      for (const id of group.all) {
        if (map.getLayer(id) === undefined) continue;
        const visible = active && (opts.labels || !group.labels.has(id));
        map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    }
  };

  const ensure = (theme: BasemapTheme): Promise<void> => {
    if (installed.has(theme)) return Promise.resolve();
    const group = { all: [] as string[], labels: new Set<string>() };
    installed.set(theme, group);
    const beforeId = anchor();
    // a page that didn't declare it in its style; by now the style has loaded
    if (map.getSource(BASEMAP_SOURCE) === undefined) map.addSource(BASEMAP_SOURCE, basemapSource());
    // Every layer in one synchronous pass. MapLibre re-lays-out each loaded
    // tile against the whole layer list whenever that list changes, so adding
    // them in batches pays for a full pass over every tile each time.
    for (const layer of basemapLayers(theme, options)) {
      // Adding before a layer that has gone (a style reload) would throw and
      // take the caller's chain with it; appending is the safe miss.
      map.addLayer(layer, beforeId !== undefined && map.getLayer(beforeId) ? beforeId : undefined);
      group.all.push(layer.id);
      if (layer.type === "symbol") group.labels.add(layer.id);
    }
    // Visibility has to match whatever was asked for before these layers
    // existed, or the basemap arrives stuck hidden, or shows its labels in the
    // middle of a ride, which is what plain mode exists to prevent.
    if (wanted) show(wanted);
    return Promise.resolve();
  };

  return { ensure, show };
}
