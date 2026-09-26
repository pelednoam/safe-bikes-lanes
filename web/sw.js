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
  "tilecache.js",
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
  // which needs these even when the ride is offline. 8192-8447 is general
  // punctuation (’ – … “ ”), in ordinary names like "St. Paul’s"; the two after
  // it hold the trail-difficulty marks (■ ♦) the network names MTB trails by.
  // A range that 404s drops a tile's labels, not just the one character.
  "fonts/glyphs/Noto Sans Regular/0-255.pbf",
  "fonts/glyphs/Noto Sans Regular/256-511.pbf",
  "fonts/glyphs/Noto Sans Regular/8192-8447.pbf",
  "fonts/glyphs/Noto Sans Regular/9472-9727.pbf",
  "fonts/glyphs/Noto Sans Regular/9728-9983.pbf",
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

/** Every version of the app shell's cache is named this, and nothing else is.
 * The shell is the only thing a new build replaces; every other cache holds
 * the rider's data — maps downloaded for a ride, styles, browsed tiles — and
 * belongs to them, not to the build that happened to write it. */
const SHELL_PREFIX = "family-bike-router-";

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Only older shells. This used to delete everything that was not the
      // current shell, so every deploy silently threw away the offline maps
      // riders had downloaded — found on the road, with no signal.
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(SHELL_PREFIX) && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      // take control of open pages so the update reaches them at once
      .then(() => self.clients.claim()),
  );
});

// Map caches. The same names, and the same rules, as tilecache.ts, which owns
// them: the page reads and fills them itself, in the Android app too, where
// there is no worker at all.
//   TILE_CACHE    routes the rider downloaded. Read here, never written or
//                 trimmed: they go when the rider says, not when we need room.
//   BROWSE_CACHE  what was seen while browsing. Bounded, oldest out first.
const TILE_CACHE = "bike-tiles-v1";
const BROWSE_CACHE = "bike-tiles-browse-v1";
const BROWSE_MAX = 1500;
const TRIM_EVERY = 25;

// Carto's vector tiles and styles are deliberately absent: the page loads them
// through its own cache (tilecache.ts), and handling them here as well would
// store every tile twice. What is left is what the city and build pages draw
// from elsewhere — Carto's glyph server and aerial imagery — and
// tile.openstreetmap.org, only so raster tiles an older build cached still
// serve offline; nothing requests it any more.
const TILE_HOSTS = ["tile.openstreetmap.org", "tiles.basemaps.cartocdn.com", "tiles.arcgis.com"];

/** A downloaded copy first, then a browsed one. */
async function lookup(key) {
  for (const name of [TILE_CACHE, BROWSE_CACHE]) {
    const hit = await (await caches.open(name)).match(key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

let putsSinceTrim = 0;

/** Keep a browsed resource, and every so often drop the oldest beyond
 * BROWSE_MAX. Keys list in insertion order, so the front is the oldest. */
async function rememberBrowsed(key, resp) {
  const cache = await caches.open(BROWSE_CACHE);
  await cache.put(key, resp);
  if (++putsSinceTrim < TRIM_EVERY) return;
  putsSinceTrim = 0;
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - BROWSE_MAX))) await cache.delete(k);
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

/**
 * How long a same-origin request gets before a cached copy is served instead.
 *
 * Network-first on its own has no answer for one bar of signal: a request that
 * neither arrives nor fails holds the page blank at startup, or a mid-ride
 * reroute waiting on a routing tile, until the browser gives up on it —
 * a minute or more — with the answer sitting in the cache the whole time.
 * Long enough that a slow connection that is working still wins, which is what
 * keeps a stale shell off a phone that is online.
 */
const NETWORK_TIMEOUT_MS = 4000;

/**
 * Pages that were themselves served from cache after a timeout. Their shell
 * requests are answered from the same cache, without racing the network: a
 * cached index.html running a freshly fetched app.js, or the reverse, is two
 * builds glued together — a broken app, not a slightly old one. The cached
 * page's own network fetch refreshes the cache behind it, so the next load
 * is new. Kept in memory only; a restarted worker simply races again.
 */
const staleClients = new Set();

/** Network-first with a timeout. Whatever the network sends is cached for
 * next time, even when it arrives after the cache has already answered. */
function networkFirst(event, req) {
  const network = fetch(req);
  // Clone before anything reads the body, and keep the worker alive until the
  // copy is stored: after a timeout the page has its answer and nothing else
  // would wait for this.
  event.waitUntil(
    network
      .then((resp) => {
        if (!resp.ok) return undefined;
        const clone = resp.clone();
        return caches.open(CACHE).then((cache) => cache.put(event.request, clone));
      })
      .catch(() => undefined),
  );
  const cached = () => caches.match(event.request);
  return new Promise((resolve) => {
    let answered = false;
    const answer = (resp) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      resolve(resp);
    };
    const timer = setTimeout(() => {
      void cached().then((hit) => {
        // Nothing cached: keep waiting — a late answer beats none.
        if (hit === undefined) return;
        if (event.request.mode === "navigate" && event.resultingClientId) {
          staleClients.add(event.resultingClientId);
        }
        answer(hit);
      });
    }, NETWORK_TIMEOUT_MS);
    network.then(answer, () => {
      void cached().then((hit) => answer(hit ?? Response.error()));
    });
  });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    const shell = event.request.mode === "navigate" || isShell(url);
    if (shell && event.clientId && staleClients.has(event.clientId)) {
      event.respondWith(
        caches.match(event.request).then((hit) => hit ?? networkFirst(event, event.request)),
      );
      return;
    }
    const req = shell
      ? new Request(event.request, { cache: "reload" }) // skip HTTP cache
      : event.request;
    // network-first: freshest app/data, fall back to cache offline or when the
    // network is too slow to be worth waiting for
    event.respondWith(networkFirst(event, req));
    return;
  }
  // Other pages' map resources: cache-first, so what has been seen still draws
  // offline. Vector tiles are the page's (see TILE_HOSTS).
  if (TILE_HOSTS.includes(url.hostname) && !url.pathname.endsWith(".mvt")) {
    const key = event.request.url;
    event.respondWith(
      lookup(key).then(
        (cached) =>
          cached ??
          fetch(event.request).then((resp) => {
            // Only a readable success. A 403 or a 500 stored here would be
            // served from disk for as long as it lived, turning one bad minute
            // into a permanently broken patch of map; and an opaque response
            // (a no-cors fetch) stores a body nothing can read. Nothing in the
            // app makes no-cors requests any more — MapLibre fetches with CORS
            // — so there is nothing to keep one for.
            if (resp.ok) event.waitUntil(rememberBrowsed(key, resp.clone()));
            return resp;
          }),
      ),
    );
  }
});
