// The app with nowhere to keep anything: site data blocked, which makes every
// touch of localStorage throw.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { budget } from "./budget.js";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

test("with site data blocked, the planner still starts and routes", async ({ page }) => {
  // app.ts read two preferences at module level with no guard, so on such a
  // browser the whole module stopped at line 293: a map with nothing wired to
  // it, and no route ever.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get(): never {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  });
  await page.goto("/#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: budget(60_000) });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(90_000) });
  await expect(page.locator("#error")).toBeHidden();
  expect(errors).toEqual([]);
});
