// Marking a street as sketchy mid-ride re-plans the ride. It used to re-plan
// the whole trip from the start pin — a mile behind the rider — and navigation
// then switched to that route and told them to ride back to the beginning.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { installRider, ride } from "./rider.js";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;

const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

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

function metres(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180);
  const dy = (b[1] - a[1]) * 110_540;
  return Math.hypot(dx, dy);
}

test("marking a sketchy spot mid-ride re-plans from where the rider is", async ({ page }) => {
  test.slow();
  await installRider(page);
  await page.goto(`/${DAVIS_KENDALL}`);
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 90_000 });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 90_000 });
  const path = await drawnRoute(page);
  const start = path[0] as [number, number];
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
  const log = await ride(page, path, { speedKmh: 14, jitterM: 2, timeScale: 20, untilM: 1500 });
  expect(log.metres).toBeGreaterThan(1000);
  const here = await page.evaluate(() => {
    const c = window._map?.getCenter();
    return c ? ([c.lng, c.lat] as [number, number]) : null;
  });
  expect(here).not.toBeNull();

  // a street on screen, long-pressed (right-clicked, on a desktop browser)
  await page.waitForTimeout(1500);
  const pt = await page.evaluate(() => {
    const map = window._map;
    if (!map) return null;
    const hits = map.queryRenderedFeatures(undefined, { layers: ["network-hit"] });
    const w = map.getCanvas().clientWidth;
    const h = map.getCanvas().clientHeight;
    for (const f of hits) {
      if (f.geometry.type !== "LineString") continue;
      for (const c of f.geometry.coordinates) {
        const p = map.project(c as [number, number]);
        if (p.x > 40 && p.x < w - 40 && p.y > h * 0.35 && p.y < h * 0.6) {
          return { x: Math.round(p.x), y: Math.round(p.y) };
        }
      }
    }
    return null;
  });
  expect(pt, "no street on screen to mark").not.toBeNull();
  if (!pt || !here) return;
  await page.mouse.click(pt.x, pt.y, { button: "right" });
  await page.locator("button", { hasText: "mark this spot as sketchy" }).click();
  await page.waitForTimeout(2000);

  const replanned = await drawnRoute(page);
  const first = replanned[0] as [number, number];
  expect(
    metres(first, start),
    "the ride was re-planned from the start pin, behind the rider",
  ).toBeGreaterThan(500);
  expect(metres(first, here), "the new route does not begin where the rider is").toBeLessThan(150);
  await expect(page.locator("#nav-banner")).toBeVisible();
});
