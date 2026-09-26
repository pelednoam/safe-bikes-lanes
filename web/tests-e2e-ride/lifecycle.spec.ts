// A ride lives inside a page that a phone does things to: switches away from,
// wakes from sleep, updates. These tests do those things mid-ride.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { installRider } from "./rider.js";

declare global {
  interface Window {
    _map?: MLMap;
    __lock?: { requests: number };
    __setHidden?: (hidden: boolean) => void;
    __speechInTap?: boolean[];
    __marker?: number;
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

test("the screen is kept awake again after the rider switches apps", async ({ page }) => {
  await installRider(page);
  // a wake lock the way a phone runs it: hiding the page releases it
  await page.addInitScript(() => {
    let hidden = false;
    const live: { released: boolean }[] = [];
    window.__lock = { requests: 0 };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async (): Promise<unknown> => {
          if (window.__lock) window.__lock.requests++;
          if (hidden) throw new Error("NotAllowedError");
          const s = {
            released: false,
            release: async (): Promise<void> => {
              s.released = true;
            },
          };
          live.push(s);
          return s;
        },
      },
    });
    window.__setHidden = (h: boolean): void => {
      hidden = h;
      if (h) for (const s of live) s.released = true;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  await planned(page);
  await startRide(page);
  await expect.poll(() => page.evaluate(() => window.__lock?.requests)).toBe(1);
  // a message comes in; the rider looks, and comes back
  await page.evaluate(() => window.__setHidden?.(true));
  await page.evaluate(() => window.__setHidden?.(false));
  await expect
    .poll(() => page.evaluate(() => window.__lock?.requests), {
      message: "the lock was never taken back: the phone sleeps mid-ride",
    })
    .toBe(2);
});

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

test("a new version of the app waits for the ride to end before reloading", async ({ page }) => {
  test.slow();
  await installRider(page);
  await planned(page);
  // the service worker controls the page from the second load on, which is
  // when the app starts listening for a newer one taking over
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 60_000,
  });
  await page.reload();
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 90_000 });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 90_000 });
  await startRide(page);
  await page.evaluate(() => {
    window.__marker = 1;
    navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
  });
  await page.waitForTimeout(3000);
  expect(
    await page.evaluate(() => window.__marker),
    "the page reloaded mid-ride and threw the ride away",
  ).toBe(1);
  await expect(page.locator("#nav-banner")).toBeVisible();

  // once the ride is over, the new version is picked up
  await page.locator("#nav-exit").click();
  await page.locator("#nav-ask-yes").click();
  await expect
    .poll(() => page.evaluate(() => window.__marker).catch(() => undefined), { timeout: 30_000 })
    .toBeUndefined();
});
