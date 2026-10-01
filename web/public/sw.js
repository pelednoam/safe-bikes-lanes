// Service worker: offline support for the app shell + data layers, engineered
// so returning visitors get the newest build without a hard refresh.
// Plain JS (not built from TS): the DOM and WebWorker type libs conflict in a
// single tsconfig project; this file is small, boilerplate, and stable.
"use strict";

// One shell cache per build, named by the build from what it precaches
// (vite.config.ts writes the id in; "dev" only in an unbuilt copy). A fixed
// name, as this was until v12, kept every build's content-hashed bundles in one
// cache forever: activate below deletes only caches with other names, so a
// phone collected each deploy until storage ran out, and then a new build's
// install failed and it stayed on the old one.
const CACHE = "family-bike-router-" + /* BUILD_ID */ "dev";
// The site's data (routing and display tiles, manifests, POIs) is cached apart
// from the code, named by the data it was built with (BUILD data id, written in
// by vite.config.ts from data/meta.json). It used to sit in the shell cache,
// whose name changes with every deploy, so every code change, however small,
// threw away the routing tiles a rider had browsed, and the next ride over the
// same streets, on a weak signal, had none. A code deploy now leaves them; a
// data deploy replaces them, which is what it should: a new data build's
// tiles don't join the last one's, and the old ones would be served beside the
// new manifest. Only the current data is kept. (A page still open across a data
// deploy has its router built already, and the network gives it the new tiles for
// any more, as it always has; keeping the old data's cache for such a page was
// tried, and it can't be done soundly here: which pages are on which data is not
// something a worker that can be stopped and restarted at any moment remembers.)
const DATA_CACHE = "family-bike-data-" + /* DATA_ID */ "dev";
const DATA_PREFIX = "family-bike-data-";

/** Whether a path is the site's data, and so belongs in the data cache: for a
 * request's pathname ("/safe-bikes-lanes/data/tiles/1_1.json") and for the
 * precache list's own entries ("data/meta.json") alike, from one rule. */
function isDataPath(path) {
  return path.startsWith("data/") || path.includes("/data/");
}

/** The cache a same-origin response is kept in. */
function cacheNameFor(url) {
  return isDataPath(url.pathname) ? DATA_CACHE : CACHE;
}

// Which shell builds were live, newest first. caches.keys() is in creation
// order, which isn't the order they were used in: deploy A, then B, then A again
// (a rollback) leaves A's cache first, and "the newest of the others" would then
// be B and A would be deleted while pages still run it. Kept in a cache of its
// own (not a shell's or data's prefix, so nothing below deletes it).
const ORDER_CACHE = "bike-cache-order";
const ORDER_KEY = new URL("__order-shell", self.location).href;
/** The data order an earlier version kept; nothing reads it now. Deleted at each
 * activation until every phone has been through one (remove this after app-v60). */
const LEGACY_DATA_ORDER_KEY = new URL("__order-data", self.location).href;

async function readOrder() {
  try {
    const hit = await (await caches.open(ORDER_CACHE)).match(ORDER_KEY);
    const names = hit === undefined ? [] : await hit.json();
    return Array.isArray(names) ? names.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}

async function writeOrder(names) {
  const cache = await caches.open(ORDER_CACHE);
  await cache.put(ORDER_KEY, new Response(JSON.stringify(names.slice(0, 8))));
}

/** The shell used before `current`, if there is one: the one activated last
 * before it, or, for any the order doesn't know (the first run after it was
 * added), the newest created. */
function previousShell(keys, current, order) {
  const others = keys.filter((k) => k.startsWith(SHELL_PREFIX) && k !== current);
  const known = order.filter((n) => others.includes(n));
  const unknown = others.filter((n) => !order.includes(n)).reverse();
  return [...known, ...unknown][0];
}

/** What is cached for a request, current build first.
 *
 * The site's data comes from the data cache only. The old shell caches may
 * still hold data from before it had a cache of its own, and `caches.match`
 * would find it there, beside a manifest it doesn't belong to.
 *
 * Everything else: the current shell, then any other cache. Asking
 * `caches.match` alone searches oldest first, so with the last build's shell
 * still kept an unhashed name like index.html would answer with the OLD one
 * whenever the network was slow. The older caches are for what the current one
 * lacks: the hashed bundles of a page still running the build before. */
async function fromCaches(request) {
  const url = new URL(request.url);
  if (isDataPath(url.pathname)) return (await caches.open(DATA_CACHE)).match(request);
  const mine = await (await caches.open(CACHE)).match(request);
  if (mine !== undefined) return mine;
  return caches.match(request);
}
// Precache the shell + the tile manifests + eager POIs. The routing graph
// (data/tiles/*.json), the display network (data/nettiles/*.json), and the
// heavy overlays (heatmap/elevation/lane) all load on demand — cached
// opportunistically by the fetch handler as requested, so offline works after
// the areas you've visited have been seen once.
const ASSETS = [
  ".",
  "index.html",
  // Everything the planner page loads from the build: its code (content-hashed,
  // so a new build is a new name), its CSS, its fonts. Written in at build time
  // from Vite's own manifest (vite.config.ts), so it can't miss a file. It
  // replaced a hand-kept list of modules that a test had to police, and still
  // missed one (search.js) before that test existed.
  /* BUILD_ASSETS */
  // the old-browser notice runs before the app, and must be there when it can't
  "compat.js",
  // MapLibre itself, outside the bundle: the page imports maplibre-gl.mjs, which
  // imports the shared chunk and starts the worker from its own URL. Missing any
  // one, a first offline load has no map. scripts/check-dist.mjs reads the
  // vendored module for the files it loads rather than trusting this list.
  "maplibre-gl.mjs",
  "maplibre-gl-shared.mjs",
  "maplibre-gl-worker.mjs",
  "maplibre-gl.css",
  "manifest.json",
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
  event.waitUntil(
    (async () => {
      const before = await caches.keys();
      const shellExisted = before.includes(CACHE);
      const dataExisted = before.includes(DATA_CACHE);
      const shell = await caches.open(CACHE);
      const data = await caches.open(DATA_CACHE);
      try {
        await shell.addAll(ASSETS.filter((a) => !isDataPath(a)));
        await data.addAll(ASSETS.filter((a) => isDataPath(a)));
      } catch (err) {
        // A shell that didn't finish installing is not a build: left, it would be
        // the newest of the others at the next update, and kept in place of the
        // one a page is running. Whatever this install created goes; what was
        // there already (last week's data, which is what the rider has been
        // browsing) stays.
        if (!shellExisted) await caches.delete(CACHE);
        if (!dataExisted) await caches.delete(DATA_CACHE);
        throw err;
      }
    })(),
  );
});

/** Every version of the app shell's cache is named this, and nothing else is.
 * The shell is the only thing a new build replaces; every other cache holds
 * the rider's data — maps downloaded for a ride, styles, browsed tiles — and
 * belongs to them, not to the build that happened to write it. */
const SHELL_PREFIX = "family-bike-router-";

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Only older shells, and older data. This used to delete everything that
      // was not the current shell, so every deploy silently threw away the offline
      // maps riders had downloaded: found on the road, with no signal.
      const keys = await caches.keys();
      const order = await readOrder();
      // The last build's shell stays too: a page open since before the update, a
      // rider mid-ride, is still running that build's code, and loads the bundles
      // it imports, lazily, from there. Two builds back and older are gone, which
      // is what stops a phone collecting every deploy. Data is the current build's
      // only: see DATA_CACHE.
      const keep = previousShell(keys, CACHE, order);
      const stale = keys.filter(
        (k) =>
          (k.startsWith(SHELL_PREFIX) && k !== CACHE && k !== keep) ||
          (k.startsWith(DATA_PREFIX) && k !== DATA_CACHE),
      );
      await Promise.all(stale.map((k) => caches.delete(k)));
      await writeOrder([CACHE, ...order.filter((n) => n !== CACHE)]);
      // housekeeping: failing at it (storage pressure) must not stop the new worker
      // taking control of open pages, which is the next line
      await caches
        .open(ORDER_CACHE)
        .then((c) => c.delete(LEGACY_DATA_ORDER_KEY))
        .catch(() => undefined);
      // take control of open pages so the update reaches them at once
      await self.clients.claim();
    })(),
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

// The basemap is absent: the page reads basemap.pmtiles tile by tile through
// its own cache (tilecache.ts), and handling it here as well would store every
// tile twice. What is left is aerial imagery, and tile.openstreetmap.org only so
// raster tiles an older build cached still serve offline; nothing requests it.
const TILE_HOSTS = ["tile.openstreetmap.org", "tiles.arcgis.com"];

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
    url.pathname.endsWith(".mjs") || // MapLibre, which must match the maplibre.js importing it
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
        return caches
          .open(cacheNameFor(new URL(event.request.url)))
          .then((cache) => cache.put(event.request, clone));
      })
      .catch(() => undefined),
  );
  const cached = () => fromCaches(event.request);
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
        // The network may have answered while the cache was being read: then
        // the page is running what the network sent, and marking it stale would
        // answer the rest of its shell from the cache, gluing two builds together.
        if (answered) return;
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
  // The basemap file is read by byte range, a tile at a time (basemap.ts). A
  // cache can't keep a partial response, and a detour through the network-first
  // path below would only slow every tile. The page caches the tiles themselves.
  if (url.pathname.endsWith(".pmtiles")) return;
  if (url.origin === self.location.origin) {
    const shell = event.request.mode === "navigate" || isShell(url);
    if (shell && event.clientId && staleClients.has(event.clientId)) {
      event.respondWith(
        fromCaches(event.request).then((hit) => hit ?? networkFirst(event, event.request)),
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
