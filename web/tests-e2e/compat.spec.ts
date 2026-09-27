// When this browser can't run the app, the rider is told so, instead of being
// left with a white map and controls that do nothing. Found by Firebase Test
// Lab: its Android 9 image has WebView 66, where app.js (ES2020) never runs.
import { expect, test } from "@playwright/test";

// page.route can't reach requests a service worker makes itself, and these
// tests stand in for app.js
test.use({ serviceWorkers: "block" });

const ANDROID_9 =
  "Mozilla/5.0 (Linux; Android 9; Android SDK built for arm64 Build/PSR1.210301.009.B6; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/66.0.3359.158 Mobile Safari/537.36";

test("a browser that runs the app never sees the notice", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 60_000 });
  await expect(page.locator("#compat")).toBeHidden();
});

test.describe("an Android WebView too old for the app", () => {
  test.use({ userAgent: ANDROID_9 });

  test("gets told to update Android System WebView", async ({ page }) => {
    // what WebView 66 makes of app.js: a syntax error, so none of it runs
    // (the planner's bundle is app-<hash>.js)
    await page.route(/\/app-[\w-]+\.js$/, (r) =>
      r.fulfill({ contentType: "text/javascript", body: "const x = a?.b ?? c; let ;" }),
    );
    await page.goto("/");
    await expect(page.locator("#compat")).toBeVisible();
    await expect(page.locator("#compat")).toHaveAttribute("data-reason", "app-did-not-start");
    await expect(page.locator("#compat-android")).toBeVisible();
    await expect(page.locator("#compat a")).toHaveAttribute("href", /id=com\.google\.android\.webview/);
    await expect(page.locator("#compat-browser")).toBeHidden();
  });
});

test("a browser without WebGL2 is told, rather than shown an empty map", async ({ page }) => {
  // MapLibre 6 draws with WebGL2 only
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
      return id === "webgl2" ? null : (get as (...a: unknown[]) => unknown).call(this, id, ...rest);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto("/");
  await expect(page.locator("#compat")).toBeVisible();
  await expect(page.locator("#compat")).toHaveAttribute("data-reason", "no-webgl2");
  await expect(page.locator("#compat-browser")).toBeVisible();
});
