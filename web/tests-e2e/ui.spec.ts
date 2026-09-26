// The planner as a parent meets it: on a phone, outdoors, often one-handed,
// sometimes with a screen reader or a keyboard, sometimes in miles and
// sometimes in kilometres. These tests measure what reaches the person — sizes,
// positions, names, announcements and units — rather than what the code meant.
import { expect, test } from "@playwright/test";

import { budget } from "./budget.js";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;

const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";
const PHONE = { width: 390, height: 820 };

async function boot(page: Page, hash = ""): Promise<void> {
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => window._map?.isSourceLoaded("network") === true, null, {
    timeout: budget(45_000),
  });
}

async function routed(page: Page): Promise<void> {
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(30_000) });
}

test.describe("units", () => {
  test("the map's route chips say minutes, the way the cards do", async ({ page }) => {
    // "A · 64m" beside a card reading "64 min" — in an app that shows miles,
    // "m" reads as metres, and nobody's ride is 64 metres long
    await routed(page);
    const chips = await page.locator(".opt-chip").allTextContents();
    expect(chips.length).toBeGreaterThan(1);
    for (const c of chips) expect(c).toMatch(/^[A-F] · \d+ min$/);
  });

  test("the walking budget reads in the rider's unit", async ({ page }) => {
    await boot(page);
    const labels = (): Promise<string[]> =>
      page.locator("#walk-max option").allTextContents();
    // miles by default: "100 m" and "1 km" were the only metric left in the panel
    expect(await labels()).toEqual(["0 ft", "330 ft", "820 ft", "0.3 mi", "0.6 mi"]);
    await page.locator("summary", { hasText: "Preferences" }).click();
    await page.locator("#units-pref").selectOption("metric");
    expect(await labels()).toEqual(["0 m", "100 m", "250 m", "500 m", "1 km"]);
  });
});
