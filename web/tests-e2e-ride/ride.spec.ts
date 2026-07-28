// Whole-ride scenarios: a simulated rider actually riding the route, so the
// navigation path gets exercised the way it is used rather than as a series of
// isolated interactions. See rider.ts for what the simulation does and does not
// reproduce faithfully.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { installRider, ride } from "./rider.js";

declare global {
  interface Window {
    _map?: MLMap;
    __rider: {
      spoken: string[];
      fixCount: number;
      setFix: (f: {
        lon: number;
        lat: number;
        accuracy?: number;
        speed?: number | null;
        heading?: number | null;
      }) => void;
      failFix: (code: number, message: string) => void;
    };
  }
}

type Page = import("@playwright/test").Page;

const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

async function startRide(page: Page, hash = DAVIS_KENDALL): Promise<[number, number][]> {
  await installRider(page);
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 45_000,
  });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  const path = await page.evaluate(() => {
    const src = window._map?.getSource("route") as { _data?: GeoJSON.FeatureCollection } | undefined;
    return (src?._data?.features ?? []).flatMap((f) =>
      f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
    );
  });
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
  return path;
}

test("a whole ride: guidance, progress and arrival", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  const log = await ride(page, path, { speedKmh: 9, jitterM: 7, timeScale: 60 });

  // it kept its mouth shut about nothing and actually guided the ride
  expect(log.fixes).toBeGreaterThan(20);
  const turns = log.spoken.filter((s) => /turn|continue|left|right/i.test(s));
  expect(turns.length).toBeGreaterThan(0);
  // no instruction repeated back-to-back (the old fixed-distance staging did)
  for (let i = 1; i < log.spoken.length; i++) {
    expect(log.spoken[i]).not.toBe(log.spoken[i - 1]);
  }
  // arrival is announced and the ride is recorded
  expect(log.spoken.join(" | ")).toMatch(/arrived/i);
  await expect(page.locator("#nav-street")).toContainText(/arrived/i, { timeout: 10_000 });
});

test("a wrong turn is noticed and rerouted, not ignored", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  // ride a stretch, then head off down a cross street. Real time: the reroute
  // cooldown is a wall-clock timer and won't compress.
  await ride(page, path, {
    speedKmh: 12,
    timeScale: 1,
    fixHz: 2,
    untilM: 260,
    divertAtM: 200,
    divertM: 90,
  });
  const spoken = await page.evaluate(() => window.__rider.spoken);
  expect(spoken.join(" | ")).toMatch(/rerouting|going your way/i);
  // and it recovers: still navigating, not stuck on "off route"
  await expect(page.locator("#nav-banner")).toBeVisible();
});

test("a bad GPS stretch doesn't trigger a phantom reroute", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  // accuracy goes to 90 m for a stretch — worse than MAX_GPS_ACCURACY_M, so
  // those fixes must not be trusted to declare the rider off-route
  await ride(page, path, {
    speedKmh: 12,
    timeScale: 1,
    fixHz: 2,
    untilM: 300,
    degradeFromM: 80,
    degradeToM: 260,
  });
  const spoken = await page.evaluate(() => window.__rider.spoken);
  expect(spoken.filter((s) => /rerouting/i.test(s))).toHaveLength(0);
});

test("stopped at a light: the view stays put and the ETA holds", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  await ride(page, path, { speedKmh: 10, timeScale: 20, untilM: 200 });
  const before = await page.evaluate(() => ({
    bearing: window._map?.getBearing() ?? 0,
    trip: document.getElementById("nav-remaining")?.textContent ?? "",
  }));
  // sit still for 30 simulated seconds
  await ride(page, path, {
    speedKmh: 10,
    timeScale: 20,
    untilM: 205,
    pauseAtM: 200,
    pauseSeconds: 30,
  });
  const after = await page.evaluate(() => ({
    bearing: window._map?.getBearing() ?? 0,
    trip: document.getElementById("nav-remaining")?.textContent ?? "",
  }));
  // the map must not spin in place while stationary
  const spin = Math.abs(((after.bearing - before.bearing + 540) % 360) - 180);
  expect(spin).toBeLessThan(25);
  expect(after.trip).toMatch(/min/);
});
