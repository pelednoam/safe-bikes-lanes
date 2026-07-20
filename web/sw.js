// Service worker: cache-first offline support for the app shell + data layers.
// Plain JS (not built from TS): the DOM and WebWorker type libs conflict in a
// single tsconfig project; this file is small, boilerplate, and stable.
"use strict";

const CACHE = "family-bike-router-v2";
const ASSETS = [
  ".",
  "index.html",
  "app.js",
  "router.js",
  "types.js",
  "manifest.json",
  "data/graph.json",
  "data/network.geojson",
  "data/heatmap.geojson",
  "data/elevation.geojson",
  "data/pois.geojson",
  "data/gateways.geojson",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // tiles/CDN: network only
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ??
        fetch(event.request).then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            void caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          }
          return resp;
        }),
    ),
  );
});
