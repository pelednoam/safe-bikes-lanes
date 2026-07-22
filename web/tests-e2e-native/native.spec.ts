// Emulates the Capacitor WebView app-layer against the shipped dist/ bundle.
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
    __swRegistered?: boolean;
  }
}

type Page = import("@playwright/test").Page;

/** Make the page believe it runs inside the native app, and spy on SW register. */
async function nativeShim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const noop = async (): Promise<void> => undefined;
    window.Capacitor = {
      isNativePlatform: () => true,
      registerPlugin: (name: string) => {
        if (name === "TextToSpeech") return { speak: noop, stop: noop };
        if (name === "Browser") return { open: noop };
        if (name === "BackgroundGeolocation") {
          return { addWatcher: async () => "w", removeWatcher: noop, openSettings: noop };
        }
        return {};
      },
    } as unknown as Window["Capacitor"];
    window.__swRegistered = false;
    if (navigator.serviceWorker) {
      const orig = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = ((...a: Parameters<typeof orig>) => {
        window.__swRegistered = true;
        return orig(...a);
      }) as typeof navigator.serviceWorker.register;
    }
  });
}

async function bootNative(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await nativeShim(page);
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 60_000,
  });
  return errors;
}

test("native boot: bundled data renders, no errors, SW not registered", async ({ page }) => {
  const errors = await bootNative(page);
  // the data resolver's bundled path (the native-only code the web E2E skips)
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["network"] }).length ?? 0,
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(50);
  // the fix: native must NOT register the app-shell service worker
  expect(await page.evaluate(() => window.__swRegistered)).toBe(false);
  expect(errors).toEqual([]);
});

test("native boot unregisters a pre-existing (stale) service worker", async ({ page }) => {
  await nativeShim(page);
  // simulate the trapped state: a SW already controlling this origin
  await page.goto("/");
  await page.evaluate(async () => {
    try {
      await navigator.serviceWorker.register("sw.js");
    } catch {
      /* fine */
    }
  });
  await page.reload();
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 60_000,
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)), {
      timeout: 20_000,
    })
    .toBe(0);
});

test("routes plan on native (data resolver feeds the router)", async ({ page }) => {
  await nativeShim(page);
  await page.goto("/#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 60_000,
  });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#s-dist")).toContainText("km");
});

test("update banner appears when the site has a newer release", async ({ page }) => {
  await nativeShim(page);
  await page.route("**/version.json", (route) => {
    const remote = route.request().url().includes("github.io");
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ version: remote ? "app-v999" : "app-v17" }),
    });
  });
  await page.goto("/");
  await expect(page.locator("#update-banner")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#update-text")).toContainText("app-v999");
});

test("fresh-data download shows the progress banner then clears", async ({ page }) => {
  await nativeShim(page);
  // remote data build is newer -> app downloads layers from the "website",
  // which we fulfill from the local bundle so the download succeeds
  await page.route(/pelednoam\.github\.io\/.*\/data\//, (route) => {
    const url = route.request().url();
    const name = url.substring(url.lastIndexOf("/data/") + 6).split("?")[0] ?? "";
    if (name.startsWith("meta.json")) {
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ built: "2099-01-01", sources: [] }),
      });
      return;
    }
    try {
      route.fulfill({ path: `dist/data/${name}` });
    } catch {
      route.fulfill({ status: 404, body: "" });
    }
  });
  await page.goto("/");
  await expect(page.locator("#data-update")).toBeVisible({ timeout: 15_000 });
  // once all layers are in, the banner hides again
  await expect(page.locator("#data-update")).toBeHidden({ timeout: 45_000 });
});
