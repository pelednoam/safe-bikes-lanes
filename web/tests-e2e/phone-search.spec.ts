// Searching for a place on a phone, where the keyboard takes half the screen.
//
// Reported from the Android app as "it's hard to look for an address", and it
// was worse than hard. The panel is a bottom sheet that starts collapsed, so
// "Where to?" sat at the very bottom of the screen — exactly where the keyboard
// opens. Measured on a 390x820 phone before the fix: the field at y=760-800,
// under a keyboard starting around y=480, and five results rendered at y=932,
// below the screen and clipped by the collapsed sheet anyway. You typed into a
// field you could not see and got answers you could not reach.
//
// The Android app is the worst case because it targets SDK 35+, which forces
// edge-to-edge, where the keyboard overlays the WebView instead of resizing it —
// so the page never even learns the keyboard is there. These tests therefore do
// not rely on a keyboard (headless Chromium has none to show). They assert the
// thing that makes a keyboard harmless: while searching, the field and its
// answers are in the top part of the screen, where no keyboard reaches.
import { expect, test } from "@playwright/test";

import { budget } from "./budget.js";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;

const W = 390;
const H = 820;
/** Where a keyboard's top edge can be. Gboard and Samsung's keyboard take ~40%
 * of a phone screen with the suggestion strip; 45% leaves room for a taller
 * one, so "above this line" means above any common keyboard. */
const KEYBOARD_TOP = H * 0.55;

test.use({ viewport: { width: W, height: H }, isMobile: true, hasTouch: true });

async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => window._map?.isSourceLoaded("network") === true, null, {
    timeout: budget(45_000),
  });
}

const sheet = (page: Page): Promise<string | undefined> =>
  page.evaluate(() =>
    ["peek", "half", "full"].find((c) => document.getElementById("panel")?.classList.contains(c)),
  );

test("the field and its answers are above where the keyboard opens", async ({ page }) => {
  await boot(page);
  expect(await sheet(page), "the premise: a phone starts with the sheet collapsed").toBe("peek");

  await page.locator("#search").tap();
  await page.keyboard.type("Davis", { delay: 40 });
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({
    timeout: budget(10_000),
  });

  const where = await page.evaluate(() => {
    const box = (e: Element): { top: number; bottom: number } => {
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    };
    const panel = box(document.getElementById("panel") as HTMLElement);
    return {
      panel,
      field: box(document.getElementById("search") as HTMLElement),
      rows: [...document.querySelectorAll("#search-results .search-row")].map(box),
    };
  });

  expect(where.field.bottom, "the field you are typing into is under the keyboard").toBeLessThan(
    KEYBOARD_TOP,
  );
  expect(where.rows.length).toBeGreaterThan(0);
  // Every answer, not just the first: the fifth is as likely to be the address.
  for (const [i, row] of where.rows.entries()) {
    expect(row.bottom, `result ${i + 1} is under the keyboard`).toBeLessThan(KEYBOARD_TOP);
    // and actually inside the sheet, not rendered and clipped — which is what the
    // collapsed sheet did with all five, keyboard or none
    expect(row.top, `result ${i + 1} is clipped by the sheet`).toBeGreaterThanOrEqual(
      where.panel.top,
    );
  }
  // The answers directly under the field, not below the round-trip block.
  const first = where.rows[0];
  expect(first && first.top - where.field.bottom).toBeLessThan(40);
});

test("choosing an answer gives the map back and closes the keyboard", async ({ page }) => {
  await boot(page);
  await page.locator("#search").tap();
  await page.keyboard.type("Davis", { delay: 40 });
  const firstRow = page.locator("#search-results .search-row .search-text").first();
  await expect(firstRow).toBeVisible({ timeout: budget(10_000) });

  await firstRow.tap();

  // "half": the chosen place and the route about to be drawn to it, on the map,
  // with the route options under them — not a full-height sheet hiding both.
  await expect.poll(() => sheet(page)).toBe("half");
  // Focus off the field is what dismisses a phone's keyboard; left there, it
  // would sit over the route the rider just asked for.
  const focused = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(focused).not.toBe("search");
  await expect(page.locator("#loop-row"), "the round trip is back once searching ends").toBeVisible();
});

test("walking away from an empty search puts the sheet back", async ({ page }) => {
  await boot(page);
  await page.locator("#search").tap();
  await expect.poll(() => sheet(page)).toBe("full");

  // changed their mind: nothing typed, nothing to tap
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => sheet(page)).toBe("peek");
  await expect(page.locator("#loop-row")).toBeVisible();
});

test("a list still showing keeps the sheet open, so the row stays under the finger", async ({
  page,
}) => {
  // On touch, blur fires on touchstart and the click only on touchend. If the
  // sheet shrank on blur, the row being tapped would slide away before the tap
  // landed — so while there are answers on screen, losing focus changes nothing.
  await boot(page);
  await page.locator("#search").tap();
  await page.keyboard.type("Davis", { delay: 40 });
  await expect(page.locator("#search-results .search-row").first()).toBeVisible({
    timeout: budget(10_000),
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(300);
  expect(await sheet(page)).toBe("full");
});
