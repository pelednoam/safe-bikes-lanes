// The points of interest are loaded once per start, not once per consumer.
//
// pois.geojson is 786 KB. The loop planner needs its features and the map's
// POI layer needs the same collection, and each used to fetch and parse it on
// its own — twice the download on a phone's connection at startup, and twice
// the JSON parse on its main thread, for the same bytes.
import { expect, test } from "@playwright/test";

import { budget } from "./budget.js";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

// Page requests only: with a worker in the way, its own precache fetch of the
// same file would be counted too, and it says nothing about the page.
test.use({ serviceWorkers: "block" });

test("the app fetches the points of interest once", async ({ page }) => {
  let fetched = 0;
  // Routing through a handler also turns off the HTTP cache, so a second
  // fetch cannot hide behind a cache hit that makes no request.
  await page.route("**/data/pois.geojson", async (route) => {
    fetched++;
    await route.continue();
  });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: budget(45_000),
  });
  // Both consumers have had it: the POI layer has data to draw once shown...
  await page.locator("#show-pois").evaluate((el) => {
    const box = el as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window._map?.isSourceLoaded("pois") ? window._map.querySourceFeatures("pois").length : 0,
        ),
      { timeout: budget(30_000) },
    )
    .toBeGreaterThan(0);
  // ...and the startup data steps have all finished, the planner's included.
  await page.waitForLoadState("networkidle");
  expect(fetched).toBe(1);
});
