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
//   - the tiles asked for must be ones the map will use. Vector tiles stop at
//     z14 and MapLibre overzooms them, so caching z15-16 fetches nothing that
//     exists;
//   - the bodies must be readable. Fetched with mode:"no-cors" they cache as
//     opaque responses, which store fine, serve fine, and cannot be parsed —
//     a download that reports success over a map that stays empty;
//   - the cache keys must match what is later asked for. MapLibre spreads
//     vector tiles across tiles-a...d by tile coordinate (measured: an even
//     split across all four), so keying on the URL as requested would leave
//     roughly three quarters of a downloaded route unfindable.
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

test("a downloaded route draws its map with the network cut", async ({ page, context }) => {
  test.slow();
  // Watch the first load, while the cache is still empty and tiles really do
  // come off the network. This is the only moment the spread is observable:
  // once they are cached the worker answers without a request being made.
  const askedHosts = new Set<string>();
  page.on("request", (r) => {
    if (r.url().endsWith(".mvt")) askedHosts.add(new URL(r.url()).hostname);
  });
  await planned(page);
  await downloadOfflineMap(page);

  const urls = await cachedTiles(page, TILE_CACHE);
  const mvt = urls.filter((u) => u.endsWith(".mvt"));
  expect(mvt.length, "the download cached no vector tiles at all").toBeGreaterThan(0);

  // Only zooms the map can use. Vector tiles stop at 14 and MapLibre overzooms
  // them for closer views, so a z15 or z16 entry here is a request for a tile
  // that does not exist — which the old raster set did have, and this replaced.
  const zooms = [...new Set(mvt.map((u) => /\/v1\/(\d+)\//.exec(u)?.[1]))].sort();
  expect(zooms, "cached zooms").toEqual(["13", "14"]);

  // One host, because the service worker folds Carto's four onto this one when
  // it looks a tile up. Caching them under whichever host answered would make
  // most of the route unfindable later.
  const hosts = [...new Set(mvt.map((u) => new URL(u).hostname))];
  expect(hosts).toEqual(["tiles-a.basemaps.cartocdn.com"]);

  // ...while the map itself asks several hosts for the same tiles. That gap is
  // the whole reason the worker rewrites the key, and it is what makes the
  // offline check below meaningful rather than accidental: with the two sides
  // unreconciled, roughly three quarters of these lookups would miss.
  expect(
    askedHosts.size,
    `MapLibre no longer spreads tiles across hosts (saw ${[...askedHosts].join(", ")})`,
  ).toBeGreaterThan(1);

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
  const failedTiles: string[] = [];
  page.on("requestfailed", (r) => {
    if (r.url().endsWith(".mvt")) failedTiles.push(r.url());
  });

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
    // Rendered features, not "the source loaded": an opaque cached body loads
    // as a tile and parses to nothing, which is exactly the failure mode that
    // a no-cors download would have shipped.
    .toBeGreaterThan(0);

  // Deliberately not "no tile request failed". The viewport is not the route,
  // so a window taller or wider than this one legitimately asks for tiles
  // beyond the downloaded corridor and legitimately doesn't get them. What has
  // to be true is that the map drew, which is asserted above.
  expect(failedTiles.length, "failed tiles are outside the corridor, not all of it").toBeLessThan(
    mvt.length,
  );
});
