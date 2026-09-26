// A shared link, from both ends: what the sender's URL gives away, and what
// the recipient gets when they open it.
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

async function drawnRoute(page: Page): Promise<[number, number][]> {
  return page.evaluate(async () => {
    const src = window._map?.getSource("route") as
      | { getData(): Promise<GeoJSON.FeatureCollection> }
      | undefined;
    return ((await src?.getData())?.features ?? []).flatMap((f) =>
      f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
    );
  });
}

function metres(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180);
  const dy = (b[1] - a[1]) * 110_540;
  return Math.hypot(dx, dy);
}

const KENDALL: [number, number] = [-71.086705, 42.362552];

test("a trip from your location is shared as that, not as your address", async ({
  page,
  context,
}) => {
  // the sender is at home
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.39876543, longitude: -71.12345678 });
  await page.goto(`/#e=${KENDALL[0]},${KENDALL[1]}&m=young_kids`);
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(90_000) });
  const hash = await page.evaluate(() => window.location.hash);
  // "from where you are", not the sender's front door
  expect(hash).toMatch(/[#&]s=here(&|$)/);
  expect(hash).not.toContain("42.3987");
  // and nothing in it is more precise than about 11 m
  expect(hash).not.toMatch(/\d\.\d{5,}/);
});

test("opening a from-here link routes from the recipient", async ({ page, context }) => {
  // the recipient is somewhere else entirely
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 42.3813, longitude: -71.0995 });
  await page.goto(`/#s=here&e=${KENDALL[0]},${KENDALL[1]}&m=young_kids`);
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(90_000) });
  const route = await drawnRoute(page);
  expect(metres(route[0] as [number, number], [-71.0995, 42.3813])).toBeLessThan(150);
  // the From field is still "Your location", not a pin that stops following
  await expect(page.locator("#from-field")).toHaveAttribute("placeholder", "Your location");
});

test("a link pasted into a tab that is already open is followed", async ({ page }) => {
  await page.goto("/#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(90_000) });
  // someone sends a different trip; it is pasted over the address bar
  const newEnd: [number, number] = [-71.0995, 42.3875];
  await page.evaluate((e) => {
    window.location.hash = `#s=-71.1043,42.3818&e=${e[0]},${e[1]}&m=young_kids`;
  }, newEnd);
  await expect
    .poll(
      async () => {
        const r = await drawnRoute(page);
        const last = r[r.length - 1];
        return last ? metres(last, newEnd) : Infinity;
      },
      { timeout: budget(60_000), message: "the pasted link was ignored" },
    )
    .toBeLessThan(150);
  // one start pin and one end pin, not the old trip's as well
  await expect(page.locator('.maplibregl-marker[title="start (drag to move)"]')).toHaveCount(1);
  await expect(page.locator('.maplibregl-marker[title="end (drag to move)"]')).toHaveCount(1);
});
