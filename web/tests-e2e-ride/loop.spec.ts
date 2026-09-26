// A round trip ends where it starts, so its "destination" is the start — and
// every reroute used to aim there, sending a rider who missed a turn a mile
// into a loop straight home.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { installRider, ride } from "./rider.js";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;

const LOOP = "#s=-71.122258,42.396748&l=5,none&m=young_kids";

async function drawnRoute(page: Page): Promise<[number, number][]> {
  return page.evaluate(() => {
    const src = window._map?.getSource("route") as
      | { _data?: GeoJSON.FeatureCollection }
      | undefined;
    return (src?._data?.features ?? []).flatMap((f) =>
      f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
    );
  });
}

function length(path: [number, number][]): number {
  let m = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as [number, number];
    const b = path[i] as [number, number];
    const dx = (b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180);
    const dy = (b[1] - a[1]) * 110_540;
    m += Math.hypot(dx, dy);
  }
  return m;
}

test("a wrong turn on a round trip rejoins the loop, not the way home", async ({ page }) => {
  test.slow();
  await installRider(page);
  await page.goto(`/${LOOP}`);
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 90_000 });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 90_000 });
  const loop = await drawnRoute(page);
  const loopM = length(loop);
  expect(loopM).toBeGreaterThan(3000);
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();

  // a quarter of the way round, the rider takes a wrong turn and keeps going
  const divertAtM = loopM * 0.25;
  await ride(page, loop, {
    speedKmh: 12,
    jitterM: 3,
    timeScale: 8,
    divertAtM,
    divertBearingDeg: 45,
    divertM: 160,
    untilM: divertAtM + 4,
  });
  // back at the turn it missed, and stopped there: let the reroute land
  const unchanged = JSON.stringify(loop);
  await expect
    .poll(async () => JSON.stringify(await drawnRoute(page)) !== unchanged, {
      timeout: 30_000,
      message: "no reroute at all",
    })
    .toBe(true);
  await page.waitForTimeout(1000);
  const rerouted = await drawnRoute(page);
  // The way home from a quarter of the way round is about a quarter of the
  // loop. The rest of the ride is three quarters of it.
  expect(
    length(rerouted),
    "the reroute went back to the start instead of round the rest of the loop",
  ).toBeGreaterThan((loopM - divertAtM) * 0.7);
  // and it finishes the way the loop does
  expect(JSON.stringify(rerouted.slice(-15))).toBe(JSON.stringify(loop.slice(-15)));
  // A loop ends where it starts, and the first fix used to snap to the finish:
  // "you have arrived" as the ride began, with the recorder closed.
  const spoken = await page.evaluate(
    () => (window as unknown as { __rider: { spoken: string[] } }).__rider.spoken,
  );
  expect(spoken.join(" | ")).not.toMatch(/you have arrived/i);
});

test("resuming after a stop mid-loop carries on round it", async ({ page }) => {
  test.slow();
  await installRider(page);
  await page.goto(`/${LOOP}`);
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 90_000 });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 90_000 });
  const loop = await drawnRoute(page);
  const loopM = length(loop);
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
  const atM = loopM * 0.3;
  await ride(page, loop, { speedKmh: 14, jitterM: 2, timeScale: 20, untilM: atM });
  // a detour for water, then straight back to it
  await page.locator("#nav-stops").click();
  await page.locator("#nav-water").click();
  await expect(page.locator("#nav-resume")).toBeVisible({ timeout: 20_000 });
  await page.locator("#nav-resume").click();
  await expect(page.locator("#nav-resume")).toBeHidden();
  const resumed = await drawnRoute(page);
  expect(
    length(resumed),
    "resuming went home instead of round the rest of the loop",
  ).toBeGreaterThan((loopM - atM) * 0.7);
  expect(JSON.stringify(resumed.slice(-15))).toBe(JSON.stringify(loop.slice(-15)));
});

test("finishing a round trip doesn't announce an old destination", async ({ page }) => {
  // The arrival line read the destination field, which a round trip never
  // touches — so it named wherever the rider had last searched for.
  test.slow();
  await installRider(page);
  await page.goto("/#s=-71.122258,42.396748&l=1.5,none&m=young_kids");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 90_000 });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 90_000 });
  // what the field says after an earlier search, left there by the round trip
  await page.evaluate(() => {
    (document.getElementById("search") as HTMLInputElement).value = "Kendall Square";
  });
  const loop = await drawnRoute(page);
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
  await ride(page, loop, { speedKmh: 14, jitterM: 2, timeScale: 40 });
  await expect(page.locator("#nav-dist")).toContainText("Arrived", { timeout: 30_000 });
  await expect(page.locator("#nav-street")).not.toContainText("Kendall");
});
