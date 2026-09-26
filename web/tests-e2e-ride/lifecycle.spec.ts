// A ride lives inside a page that a phone does things to: switches away from,
// wakes from sleep, updates. These tests do those things mid-ride.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { installRider } from "./rider.js";

declare global {
  interface Window {
    _map?: MLMap;
    __speechInTap?: boolean[];
  }
}

type Page = import("@playwright/test").Page;

const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

async function planned(page: Page, hash = DAVIS_KENDALL): Promise<void> {
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 90_000 });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 90_000 });
}

async function startRide(page: Page): Promise<void> {
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
}

test("Navigate starts speech inside the tap, as an iPhone requires", async ({ page }) => {
  await installRider(page);
  // Record, for every line handed to the engine, whether it happened while the
  // tap was still being handled. iOS only unlocks speech for a page from inside
  // a user gesture; anything spoken after an await is silently dropped.
  await page.addInitScript(() => {
    let inTap = false;
    window.__speechInTap = [];
    window.addEventListener("click", () => (inTap = true), true);
    window.addEventListener("click", () => (inTap = false));
    const synth = window.speechSynthesis as unknown as { speak: (u: unknown) => void };
    const speak = synth.speak.bind(synth);
    synth.speak = (u: unknown): void => {
      window.__speechInTap?.push(inTap);
      speak(u);
    };
  });
  await planned(page);
  await startRide(page);
  await expect.poll(() => page.evaluate(() => window.__speechInTap?.length ?? 0)).toBeGreaterThan(0);
  const inTap = await page.evaluate(() => window.__speechInTap ?? []);
  expect(inTap[0], "the first line was spoken after the tap was over").toBe(true);
});
