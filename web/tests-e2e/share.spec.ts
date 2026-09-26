// Files out of the app — a GPX, a share card — the way WebKit hands them over.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { budget } from "./budget.js";

test.describe.configure({ timeout: 180_000 });

declare global {
  interface Window {
    _map?: MLMap;
    __dl?: string[];
    __shares?: { inTap: boolean; files: number }[];
  }
}

test("a downloaded GPX keeps its file alive long enough to be saved", async ({ page }) => {
  // WebKit starts a download after the click returns; the URL was revoked on
  // the very next line, so an iPhone saved an empty file or nothing.
  await page.addInitScript(() => {
    window.__dl = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (u: string): void => {
      window.__dl?.push("revoke");
      revoke(u);
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
      if (this.download !== "") {
        window.__dl?.push(`download ${this.download}`);
        return; // the test only needs to know it was asked for
      }
      click.call(this);
    };
  });
  await page.goto("/#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(90_000) });
  await page.locator('summary:has-text("Export")').click();
  await page.locator("#gpx").click();
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__dl)).toEqual(["download family-bike-route.gpx"]);
});

test("sharing ride stats opens the share sheet inside the tap", async ({ page }) => {
  // The card was drawn after the tap and share() called once it was ready —
  // which WebKit refuses outside a gesture, silently, so the button did nothing.
  await page.addInitScript(() => {
    if (localStorage.getItem("rideHistory") === null) {
      localStorage.setItem(
        "rideHistory",
        JSON.stringify([
          {
            id: "1",
            startedAt: "2026-09-01T10:00:00.000Z",
            meters: 5200,
            durationS: 1500,
            movingS: 1300,
            byClass: { path: 3000, quiet_street: 2200 },
            pctProtected: 58,
            pctQuiet: 42,
            profile: "young_kids",
            polyline: [
              [-71.12, 42.39],
              [-71.1, 42.38],
            ],
          },
        ]),
      );
    }
    let inTap = false;
    window.addEventListener("click", () => (inTap = true), true);
    window.addEventListener("click", () => (inTap = false));
    window.__shares = [];
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (d: { files?: unknown[] }): Promise<void> => {
        window.__shares?.push({ inTap, files: d.files?.length ?? 0 });
        if (!inTap) throw new DOMException("Must be handling a user gesture", "NotAllowedError");
      },
    });
  });
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await page.locator("#rides-btn").click();
  await expect(page.locator("#rides-share")).toBeVisible();
  await page.waitForTimeout(1500); // a person reads the list before sharing it
  await page.locator("#rides-share").click();
  await expect.poll(() => page.evaluate(() => window.__shares?.length ?? 0)).toBeGreaterThan(0);
  const shares = await page.evaluate(() => window.__shares ?? []);
  expect(shares[0], "share() came after the tap, which an iPhone refuses").toEqual({
    inTap: true,
    files: 1,
  });
});
