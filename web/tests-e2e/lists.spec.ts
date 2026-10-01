// The lists a rider keeps on the device: the spots they marked to avoid, and
// their recorded rides. Drawn from what is stored (src/ui/Lists.tsx), so each
// row's buttons act on the entry the row shows, and a removal takes the row
// away, from the page and from storage.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { budget } from "./budget.js";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type LngLat = [number, number];

function aRide(id: string, day: string, meters: number, polyline: LngLat[]): Record<string, unknown> {
  return {
    id,
    startedAt: `2026-09-${day}T10:00:00.000Z`,
    meters,
    durationS: 1500,
    movingS: 1200,
    byClass: { path: meters },
    pctProtected: 80,
    pctQuiet: 20,
    profile: "young_kids",
    polyline,
  };
}

// two rides that differ in everything a row shows, and on the map
const RIDE_A: LngLat[] = [
  [-71.12, 42.39],
  [-71.1, 42.38],
];
const RIDE_B: LngLat[] = [
  [-71.2, 42.4],
  [-71.18, 42.41],
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([rides]) => {
      if (localStorage.getItem("seeded") !== null) return; // a reload keeps what the test did
      localStorage.setItem("seeded", "1");
      localStorage.setItem(
        "sketchyMarks",
        JSON.stringify([
          [-71.1, 42.385],
          [-71.105, 42.39],
        ]),
      );
      localStorage.setItem("rideHistory", JSON.stringify(rides));
    },
    [[aRide("a", "01", 5200, RIDE_A), aRide("b", "02", 9100, RIDE_B)]],
  );
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
});

test("a marked spot is listed, and removing it removes that one", async ({ page }) => {
  await page.evaluate(() => {
    const d = document.getElementById("sketchy-list")?.closest("details");
    if (d) d.open = true;
  });
  const rows = page.locator("#sketchy-list .sketchy-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("marked spot 2");
  await rows.nth(0).locator("button", { hasText: "✕" }).click();
  await expect(rows).toHaveCount(1);
  // the one left is the second, renumbered as the list now stands
  await expect(rows.nth(0)).toContainText("marked spot 1");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("sketchyMarks") ?? "[]") as unknown);
  expect(stored).toEqual([[-71.105, 42.39]]);
  await page.reload();
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await expect(page.locator("#sketchy-list .sketchy-row")).toHaveCount(1);
});

test("the rides are listed with their totals; each row deletes and shows its own ride", async ({ page }) => {
  await page.locator("#rides-btn").click();
  await expect(page.locator("#ride-totals")).toContainText("2 rides");
  const rows = page.locator("#ride-list tr:has(td)");
  await expect(rows).toHaveCount(2);
  const [first, second] = await rows.allTextContents();
  expect(first, "the two rides read the same").not.toBe(second);

  // ✕ on the first row removes the first ride, and only that one
  await rows.nth(0).locator("button", { hasText: "✕" }).click();
  await expect(rows).toHaveCount(1);
  expect(await rows.nth(0).textContent(), "the wrong row was deleted").toBe(second);
  const left = await page.evaluate(
    () => (JSON.parse(localStorage.getItem("rideHistory") ?? "[]") as { id: string }[]).map((r) => r.id),
  );
  expect(left, "the wrong ride was deleted").toEqual(["b"]);
  // one is "1 ride", not "1 rides"
  await expect(page.locator("#ride-totals")).toContainText(/\b1 ride\b(?!s)/);

  // "map" draws that ride's own line, and gets the dialog out of the way
  await rows.nth(0).locator("button", { hasText: "map" }).click();
  await expect(page.locator("#rides")).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const src = window._map?.getSource("history") as
          | { getData(): Promise<GeoJSON.Feature<GeoJSON.LineString>> }
          | undefined;
        return JSON.stringify((await src?.getData())?.geometry?.coordinates ?? null);
      }),
    )
    .toBe(JSON.stringify(RIDE_B));
});
