// Turn-by-turn navigation on the real app, driven by simulated GPS fixes.
// This is the mode the app is actually used in while riding, so it covers the
// motion layer: the dot snapping to the route, the follow camera, the trip
// readout, ridden-progress dimming, and letting the rider keep their own zoom.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;

// Davis Sq -> Kendall, the ground-truth route used elsewhere in the suite
const ROUTE = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

test.use({ permissions: ["geolocation"], geolocation: { latitude: 42.396748, longitude: -71.122258 } });

/** Boot, plan the route, and start navigating. */
async function startNav(page: Page): Promise<void> {
  await page.goto(`/${ROUTE}`);
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  // speechSynthesis isn't available in headless chromium; stub so nav doesn't throw
  await page.evaluate(() => {
    // @ts-expect-error test stub
    window.speechSynthesis ??= { speak: () => undefined, cancel: () => undefined };
  });
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
}

/** Coordinates along the selected route, so simulated fixes follow it. */
async function routeCoords(page: Page): Promise<[number, number][]> {
  return page.evaluate(() => {
    const src = window._map?.getSource("route") as
      | { _data?: GeoJSON.FeatureCollection }
      | undefined;
    const fc = src?._data;
    if (!fc) return [];
    return fc.features.flatMap((f) =>
      f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
    );
  });
}

test("navigation follows simulated GPS along the route", async ({ page, context }) => {
  await startNav(page);
  const coords = await routeCoords(page);
  expect(coords.length).toBeGreaterThan(10);

  // ride the first stretch of the route
  for (const c of coords.slice(0, 12)) {
    await context.setGeolocation({ longitude: c[0], latitude: c[1] });
    await page.waitForTimeout(120);
  }

  // the trip readout shows distance, minutes and an arrival clock time
  await expect(page.locator("#nav-remaining")).toContainText(/min/, { timeout: 15_000 });
  await expect(page.locator("#nav-remaining")).toContainText(/arrive/);
  // and a turn instruction is displayed
  await expect(page.locator("#nav-dist")).not.toHaveText("–");
});

/** Where the position dot is actually drawn, as lon/lat. */
async function dotLngLat(page: Page): Promise<[number, number] | null> {
  return page.evaluate(() => {
    const map = window._map;
    const el = document.querySelector(".nav-dot") as HTMLElement | null;
    if (!map || !el) return null;
    const r = el.getBoundingClientRect();
    const c = map.getCanvas().getBoundingClientRect();
    const ll = map.unproject([r.left + r.width / 2 - c.left, r.top + r.height / 2 - c.top]);
    return [ll.lng, ll.lat] as [number, number];
  });
}

test("the position dot is snapped onto the route, not raw GPS", async ({ page, context }) => {
  await startNav(page);
  const coords = await routeCoords(page);
  const target = coords[8] as [number, number];
  // report a fix ~14 m off the route (typical bike GPS wander)
  const rawLat = target[1] + 14 / 110_540;
  await context.setGeolocation({ longitude: target[0], latitude: rawLat });
  await page.waitForTimeout(2000);

  const drawn = await dotLngLat(page);
  expect(drawn).not.toBeNull();
  if (!drawn) return;

  const metres = (a: [number, number], b: [number, number]): number =>
    Math.hypot(
      (a[0] - b[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180),
      (a[1] - b[1]) * 110_540,
    );
  // pulled away from the raw fix...
  expect(metres(drawn, [target[0], rawLat])).toBeGreaterThan(4);

  // ...and onto the route line itself. Measure to the nearest point on each
  // SEGMENT (nearest-vertex overstates it — vertices are tens of metres apart).
  const kx = 111_320 * Math.cos((drawn[1] * Math.PI) / 180);
  let offRoute = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i] as [number, number];
    const b = coords[i + 1] as [number, number];
    const ax = (drawn[0] - a[0]) * kx;
    const ay = (drawn[1] - a[1]) * 110_540;
    const bx = (b[0] - a[0]) * kx;
    const by = (b[1] - a[1]) * 110_540;
    const len2 = bx * bx + by * by;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (ax * bx + ay * by) / len2)) : 0;
    offRoute = Math.min(offRoute, Math.hypot(ax - t * bx, ay - t * by));
  }
  // a few metres of slack for reading the dot back out of screen pixels
  expect(offRoute).toBeLessThan(5);
});

test("ridden progress is dimmed behind the rider", async ({ page, context }) => {
  await startNav(page);
  const coords = await routeCoords(page);
  for (const c of coords.slice(0, 15)) {
    await context.setGeolocation({ longitude: c[0], latitude: c[1] });
    await page.waitForTimeout(100);
  }
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const src = window._map?.getSource("route-done") as
            | { _data?: GeoJSON.Feature<GeoJSON.LineString> }
            | undefined;
          return src?._data?.geometry?.coordinates?.length ?? 0;
        }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(1);
  expect(await page.evaluate(() => window._map?.getLayoutProperty("route-done", "visibility"))).toBe(
    "visible",
  );
});

test("the safety network can be toggled off and on mid-ride", async ({ page, context }) => {
  await startNav(page);
  const coords = await routeCoords(page);
  await context.setGeolocation({ longitude: coords[4]?.[0] ?? 0, latitude: coords[4]?.[1] ?? 0 });
  const vis = (): Promise<string | undefined> =>
    page.evaluate(
      () => window._map?.getLayoutProperty("network", "visibility") as string | undefined,
    );

  // the panel is hidden while navigating, so the control lives in the nav bar
  const btn = page.locator("#nav-net");
  await expect(btn).toBeVisible();
  await expect(btn).toHaveClass(/active/);

  await btn.click();
  await expect.poll(vis).toBe("none");
  await expect(btn).not.toHaveClass(/active/);
  // no network tile requests while it's hidden
  let fetched = 0;
  const count = (r: { url: () => string }): void => {
    if (r.url().includes("/nettiles/") && !r.url().endsWith("manifest.json")) fetched++;
  };
  page.on("request", count);
  for (const c of coords.slice(5, 12)) {
    await context.setGeolocation({ longitude: c[0], latitude: c[1] });
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(600);
  expect(fetched).toBe(0);
  page.off("request", count);

  // back on, and it repopulates
  await btn.click();
  await expect.poll(vis).toBe("visible");
  await expect(btn).toHaveClass(/active/);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const src = window._map?.getSource("network") as
            | { _data?: GeoJSON.FeatureCollection }
            | undefined;
          return src?._data?.features?.length ?? 0;
        }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
});

test("the rider's own zoom is kept (no snapping back), recenter restores follow", async ({
  page,
  context,
}) => {
  await startNav(page);
  const coords = await routeCoords(page);
  await context.setGeolocation({ longitude: coords[5]?.[0] ?? 0, latitude: coords[5]?.[1] ?? 0 });
  await page.waitForTimeout(800);

  // rider scroll/pinch-zooms out to look further ahead. This must be a real
  // input event — a programmatic zoomTo isn't a rider gesture and shouldn't
  // (and doesn't) hand zoom control over.
  // wheel until the app registers it as a rider gesture (the recenter button
  // appearing is that acknowledgement) — under load the first wheel can land
  // before the map is interactive
  await page.mouse.move(600, 400);
  const recenter = page.locator("#nav-recenter");
  for (let i = 0; i < 15 && !(await recenter.isVisible()); i++) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(150);
  }
  await expect(recenter).toBeVisible();
  // let the gesture's own inertia settle before sampling, so we measure the
  // steady state rather than a mid-animation value (flaky under load)
  const readZoom = (): Promise<number> => page.evaluate(() => window._map?.getZoom() ?? 0);
  let zoomed = await readZoom();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const z = await readZoom();
    if (Math.abs(z - zoomed) < 0.01) break;
    zoomed = z;
  }

  // more fixes arrive — the camera must NOT drag the zoom back in
  for (const c of coords.slice(6, 12)) {
    await context.setGeolocation({ longitude: c[0], latitude: c[1] });
    await page.waitForTimeout(150);
  }
  const after = await page.evaluate(() => window._map?.getZoom() ?? 0);
  expect(Math.abs(after - zoomed)).toBeLessThan(0.6);

  // recenter hands zoom control back to the follow camera
  await recenter.click();
  await context.setGeolocation({
    longitude: coords[13]?.[0] ?? 0,
    latitude: coords[13]?.[1] ?? 0,
  });
  await expect.poll(() => page.evaluate(() => window._map?.getZoom() ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(zoomed + 0.5);
});
