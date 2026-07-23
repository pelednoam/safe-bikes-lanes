// Service worker: offline support for the app shell + data layers, engineered
// so returning visitors get the newest build without a hard refresh.
// Plain JS (not built from TS): the DOM and WebWorker type libs conflict in a
// single tsconfig project; this file is small, boilerplate, and stable.
"use strict";

const CACHE = "family-bike-router-v8";
// Precache the shell + the layers loaded eagerly at startup. The routing graph
// is now tiled (data/tiles/*.json) and the heavy overlays (heatmap/elevation/
// lane) load on demand — both are cached opportunistically by the fetch
// handler as they're requested, so offline still works after a first visit.
const ASSETS = [
  ".",
  "index.html",
  "app.js",
  "router.js",
  "types.js",
  "tiles.js",
  "manifest.json",
  "data/tiles/manifest.json",
  "data/network.geojson",
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
const TILE_HOSTS = ["tile.openstreetmap.org", "basemaps.cartocdn.com"];

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
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(event.request).then(
          (cached) =>
            cached ??
            fetch(event.request).then((resp) => {
              void cache.put(event.request, resp.clone());
              return resp;
            }),
        ),
      ),
    );
  }
});
