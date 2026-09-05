// Service worker: offline support for the app shell + data layers, engineered
// so returning visitors get the newest build without a hard refresh.
// Plain JS (not built from TS): the DOM and WebWorker type libs conflict in a
// single tsconfig project; this file is small, boilerplate, and stable.
"use strict";

const CACHE = "family-bike-router-v11";
// Precache the shell + the tile manifests + eager POIs. The routing graph
// (data/tiles/*.json), the display network (data/nettiles/*.json), and the
// heavy overlays (heatmap/elevation/lane) all load on demand — cached
// opportunistically by the fetch handler as requested, so offline works after
// the areas you've visited have been seen once.
const ASSETS = [
  ".",
  "index.html",
  // Every module app.js imports, not a subset. The rest were being cached
  // opportunistically by the fetch handler, which works only if the page finishes
  // loading them before the network goes — and a module added later (search.js
  // was) is exactly the one a first offline load would be missing. A test asserts
  // this list covers the import graph, so the next one cannot be forgotten.
  "app.js",
  // MapLibre itself, vendored. index.html loads it with a plain <script src>, and
  // without it in the precache a first offline load fails before app.js runs —
  // the same failure the module list above was extended to prevent, one file
  // further out. A test now reads index.html rather than trusting this list.
  "maplibre-gl.js",
  "maplibre-gl.css",
  "basemap.js",
  "data.js",
  "hazards.js",
  "native.js",
  "nav.js",
  "places.js",
  "rides.js",
  "router.js",
  "search.js",
  "segment.js",
  "sharecard.js",
  "tiles.js",
  "types.js",
  "units.js",
  "manifest.json",
  "fonts/Barlow-400.woff2",
  "fonts/Barlow-500.woff2",
  "fonts/Barlow-600.woff2",
  "fonts/Barlow-700.woff2",
  "fonts/BarlowSemiCondensed-600.woff2",
  "fonts/BarlowSemiCondensed-700.woff2",
  // map label glyphs: street names while navigating come from a symbol layer,
  // which needs these even when the ride is offline
  "fonts/glyphs/Noto Sans Regular/0-255.pbf",
  "fonts/glyphs/Noto Sans Regular/256-511.pbf",
  "data/tiles/manifest.json",
  "data/nettiles/manifest.json",
  "data/pois.geojson",
  "data/meta.json",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (event) => {
  // activate this build immediately instead of waiting for all tabs to close
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      // take control of open pages so the update reaches them at once
      .then(() => self.clients.claim()),
  );
});

const TILE_CACHE = "bike-tiles-v1";
// tile.openstreetmap.org stays listed only so basemap tiles cached by an older
// build still serve offline; nothing requests it any more. basemaps.cartocdn.com
// is now the vector *styles* rather than raster tiles — Carto stamps "API KEY
// REQUIRED" across those — while tiles(-a…d).basemaps.cartocdn.com serve the
// TileJSON and the .mvt tiles themselves.
const TILE_HOSTS = [
  "tile.openstreetmap.org",
  "basemaps.cartocdn.com",
  "tiles.basemaps.cartocdn.com",
  "tiles-a.basemaps.cartocdn.com",
  "tiles-b.basemaps.cartocdn.com",
  "tiles-c.basemaps.cartocdn.com",
  "tiles-d.basemaps.cartocdn.com",
  "tiles.arcgis.com",
];

/**
 * One cache key per tile, whichever of Carto's four hosts served it.
 *
 * MapLibre spreads vector tiles across tiles-a…d by tile coordinate, so the
 * host for a given tile is not ours to predict. Keying on the URL as requested
 * would store up to four copies of the same tile and, worse, let a route
 * pre-cached against one host miss on all the others — an offline ride with
 * most of its map absent while the download had reported success.
 */
function tileKey(requestUrl) {
  const url = new URL(requestUrl);
  // Anchored to Carto's own hosts, not to anything merely beginning
  // "tiles-b.": this is only ever called for hosts in TILE_HOSTS today, but a
  // rule that rewrites somebody else's host is a trap for whoever adds one.
  url.hostname = url.hostname.replace(
    /^tiles-[a-d]\.basemaps\.cartocdn\.com$/,
    "tiles-a.basemaps.cartocdn.com",
  );
  return url.toString();
}

/** The app shell must never be served stale: bypass the HTTP cache so the
 * SW's network fetch can't return a CDN-cached old app.js/index.html. */
function isShell(url) {
  return (
    url.pathname.endsWith("/") ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith("manifest.json")
  );
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    const req =
      event.request.mode === "navigate" || isShell(url)
        ? new Request(event.request, { cache: "reload" }) // skip HTTP cache
        : event.request;
    // network-first: freshest app/data, fall back to cache offline
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            void caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(event.request).then((c) => c ?? Response.error())),
    );
    return;
  }
  // basemap tiles: cache-first (pre-cached along a route by the app, or
  // opportunistically as you browse), so the map works offline
  if (TILE_HOSTS.includes(url.hostname)) {
    const key = tileKey(event.request.url);
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(key).then(
          (cached) =>
            cached ??
            fetch(event.request).then((resp) => {
              // Don't cache a refusal as if it were a tile: a 403 or a 500
              // stored here is served from disk for as long as the cache lives,
              // so one bad minute becomes a permanently broken patch of map.
              // Opaque responses (status 0) are how no-cors image tiles come
              // back and are still worth keeping.
              if (resp.ok || resp.type === "opaque") void cache.put(key, resp.clone());
              return resp;
            }),
        ),
      ),
    );
  }
});
