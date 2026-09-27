// "⬇ Offline map": pre-download a route's basemap so the ride survives no signal.
//
// This is the one path in the app whose failure is invisible until it matters.
// Everything reports success — the button counts up and says "offline ready" —
// and the map is blank an hour later on a road with no bars, where nobody can
// debug it. So the test cuts the network for real and asks whether the map
// draws, rather than whether the download claimed to work.
//
// Three things have to be true together, and each fails silently on its own:
//
//   - the tiles stored must be ones the map will use. The basemap stops at
//     z14 and MapLibre overzooms it, so storing z15-16 stores nothing that
//     exists;
//   - the bodies must be tiles, not the byte ranges they were read out of.
//     CacheStorage can't keep a 206, and a range that isn't one whole tile
//     parses to nothing: a download that reports success over an empty map;
//   - the cache keys must match what is later asked for. The tiles are read
//     out of one file (basemap.pmtiles), and keyed by z/x/y, not by the file's
//     address, so the lookup offline never needs the file at all.
import { expect, test } from "@playwright/test";

import { budget } from "./budget.js";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;

// Davis Sq -> Kendall, the ground-truth route used elsewhere in the suite
const ROUTE = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";
const TILE_CACHE = "bike-tiles-v1";

async function planned(page: Page): Promise<void> {
  await page.goto(`/${ROUTE}`);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(60_000) });
}

/** Download the selected route's tiles and wait for it to actually finish.
 *
 * Waits on the button's disabled state, not its label. The label is idle at
 * "⬇ Offline map" and returns to it four seconds after finishing, so "not
 * started" and "done" are the same string — a wait on the text passes
 * immediately and samples a half-filled cache. The button is disabled for
 * exactly the length of the download.
 */
async function downloadOfflineMap(page: Page): Promise<void> {
  await page.locator("summary", { hasText: "Export & offline" }).first().click();
  const btn = page.locator("#offline-btn");
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await page.waitForFunction(
    () => (document.getElementById("offline-btn") as HTMLButtonElement).disabled,
    null,
    { timeout: budget(30_000) },
  );
  await page.waitForFunction(
    () => !(document.getElementById("offline-btn") as HTMLButtonElement).disabled,
    null,
    { timeout: budget(180_000) },
  );
}

function cachedTiles(page: Page, cacheName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    const cache = await caches.open(name);
    return (await cache.keys()).map((r) => r.url);
  }, cacheName);
}

test("a downloaded route draws its map with the network cut", { tag: "@live" }, async ({ page, context }) => {
  test.slow();
  // Watch the first load, while the cache is still empty and tiles really do
  // come out of the file. Once they are cached the tile cache answers without
  // a request being made.
  const basemapReads: { host: string; status: number }[] = [];
  const elsewhere = new Set<string>();
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (url.pathname.endsWith("/basemap.pmtiles")) basemapReads.push({ host: url.host, status: r.status() });
    // tile servers; Nominatim, which names the route's ends, is not one
    else if (/cartocdn|tile\.openstreetmap|protomaps/.test(url.hostname)) elsewhere.add(url.hostname);
  });
  await planned(page);
  await downloadOfflineMap(page);

  const urls = await cachedTiles(page, TILE_CACHE);
  const mvt = urls.filter((u) => u.endsWith(".mvt"));
  expect(mvt.length, "the download cached no basemap tiles at all").toBeGreaterThan(0);

  // Only zooms the map can use. The basemap stops at 14 and MapLibre overzooms
  // it for closer views, so a z15 or z16 entry here is a tile that doesn't exist.
  const zooms = [...new Set(mvt.map((u) => /^https:\/\/basemap\.tile\/(\d+)\//.exec(u)?.[1]))].sort();
  expect(zooms, "cached zooms").toEqual(["13", "14"]);

  // The basemap is ours: read from this site's own file, a range at a time,
  // and from no third party's tile server.
  expect(basemapReads.length, "the map never read basemap.pmtiles").toBeGreaterThan(0);
  expect(new Set(basemapReads.map((r) => r.host))).toEqual(new Set([new URL(page.url()).host]));
  expect(basemapReads.every((r) => r.status === 206), "the file must be read by range, not whole").toBe(true);
  expect([...elsewhere], "basemap requests to a third party").toEqual([]);

  // ...and now the part that matters. Everything above is the app agreeing with
  // itself; this asks the map.
  //
  // Wait for the worker to be in control first. It claims clients as soon as it
  // activates, but "as soon as" is a race on a loaded runner, and cutting the
  // network before it wins means the reload below cannot even fetch the page —
  // a failure about test timing that would read as a broken offline map.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: budget(30_000),
  });
  await context.setOffline(true);

  await page.goto(`/${ROUTE}`);
  await page.waitForFunction(
    () => (window._map?.getStyle().layers ?? []).some((l) => l.id.startsWith("bm-")),
    null,
    { timeout: budget(60_000) },
  );
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const map = window._map;
          if (!map) return 0;
          const lines = (map.getStyle().layers ?? [])
            .filter((l) => l.id.startsWith("bm-") && l.type === "line")
            .map((l) => l.id);
          return map.queryRenderedFeatures(undefined, { layers: lines }).length;
        }),
      { timeout: budget(45_000) },
    )
    // Rendered features, not "the source loaded": a stored body that isn't a
    // whole tile loads as one and parses to nothing, the failure a download
    // keeping byte ranges instead of tiles would have shipped.
    .toBeGreaterThan(0);

  // Deliberately not "every tile drew". The viewport is not the route, so a
  // window taller or wider than this one legitimately asks for tiles beyond
  // the downloaded corridor and legitimately doesn't get them. What has to be
  // true is that the map drew, which is asserted above.
});
