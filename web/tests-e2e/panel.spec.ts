// The route panel and the map around it: what switching between options
// leaves behind, and where a route is framed on a phone held sideways.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { budget } from "./budget.js";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;

test.describe.configure({ timeout: 180_000 });

const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

async function planned(page: Page): Promise<void> {
  await page.goto(`/${DAVIS_KENDALL}`);
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(90_000) });
}

test("switching options quickly leaves no per-frame work behind", async ({ page }) => {
  // Each option painted its panel once the line was drawn, watching every
  // render for it. One superseded before it fired returned before taking its
  // listeners off — and then ran queryRenderedFeatures on every frame for the
  // rest of the session.
  await planned(page);
  await page.waitForTimeout(4000);
  const listeners = (): Promise<number> =>
    page.evaluate(() => {
      const m = window._map as unknown as { _listeners?: Record<string, unknown[]> };
      return (m._listeners?.["render"]?.length ?? 0) + (m._listeners?.["sourcedata"]?.length ?? 0);
    });
  const before = await listeners();
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>(".option-card")];
    for (let i = 0; i < 5; i++) for (const c of cards) c.click();
  });
  // past the three-second hard stop every paint has
  await page.waitForTimeout(4500);
  expect(await listeners(), "render listeners leaked by superseded paints").toBe(before);
});

test("on a phone held sideways, the route is framed above the sheet", async ({ page }) => {
  // The panel is a bottom sheet on a landscape phone too (max-height: 500px),
  // but the framing asked only about width and used the desktop padding — the
  // route went under the sheet.
  await page.setViewportSize({ width: 844, height: 390 });
  await planned(page);
  await page.waitForTimeout(2500); // the fit animates
  const lowest = await page.evaluate(async () => {
    const map = window._map;
    const src = map?.getSource("route") as { getData(): Promise<GeoJSON.FeatureCollection> } | undefined;
    const ys = ((await src?.getData())?.features ?? []).flatMap((f) =>
      f.geometry.type === "LineString"
        ? f.geometry.coordinates.map((c) => map?.project(c as [number, number]).y ?? 0)
        : [],
    );
    return Math.max(...ys);
  });
  const sheetTop = await page.evaluate(
    () => document.getElementById("panel")?.getBoundingClientRect().top ?? 0,
  );
  expect(lowest, "the route runs under the bottom sheet").toBeLessThan(sheetTop + 10);
});
