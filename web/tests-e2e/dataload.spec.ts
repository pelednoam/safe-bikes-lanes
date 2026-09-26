// The app's startup data on a bad connection: a load that fails is tried
// again, and says so in words, instead of leaving "loading map…" up for good.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { budget } from "./budget.js";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

// page.route cannot see what the service worker answers
test.use({ serviceWorkers: "block" });
test.describe.configure({ timeout: 180_000 });

test("routing data that fails to load is tried again, and the trip arrives", async ({ page }) => {
  let failures = 2;
  await page.route(/\/data\/tiles\/manifest\.json$/, (route) =>
    failures-- > 0 ? route.abort("internetdisconnected") : route.continue(),
  );
  await page.goto("/#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  // said plainly, while it waits
  await expect(page.locator("#error")).toContainText(/trying again/i, {
    timeout: budget(30_000),
  });
  // and the route comes once the data does, with nothing left on screen
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(120_000) });
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#loading")).toBeHidden();
});

test("a street network that will not load does not throw on every pan", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && /Uncaught/.test(m.text())) errors.push(m.text());
  });
  await page.route(/\/data\/nettiles\/manifest\.json$/, (route) =>
    route.abort("internetdisconnected"),
  );
  await page.goto("/#c=-71.105,42.383,14");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  for (const dx of [120, -200, 160]) {
    await page.evaluate((x) => window._map?.panBy([x, 40], { duration: 0 }), dx);
    await page.waitForTimeout(700);
  }
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  expect(errors).toEqual([]);
});
