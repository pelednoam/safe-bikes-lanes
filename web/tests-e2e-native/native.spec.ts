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

/** Failures the app handles by design: the data resolver tries the website and
 * falls back to the bundled copy, and the reverse geocoder that names the ends
 * is a nicety the app rides without — so an unreachable network is not an app
 * error, and the sandbox running these tests has no route out. Anything else
 * counts. */
function isExpectedOfflineNoise(text: string): boolean {
  return /pelednoam\.github\.io|nominatim|ERR_FAILED|ERR_INTERNET_DISCONNECTED|CORS policy/i.test(
    text,
  );
}

async function bootNative(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !isExpectedOfflineNoise(m.text())) {
      errors.push(`console: ${m.text()}`);
    }
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

test("tapping install actually requests the APK", async ({ page }) => {
  // Regression: this used to go through the Capacitor Browser plugin, which
  // opens a Chrome Custom Tab — Custom Tabs silently drop file downloads, so
  // the button did nothing at all. It must now request the APK itself (the
  // WebView's DownloadListener hands that off to the system browser).
  await nativeShim(page);
  await page.route("**/version.json", (route) => {
    const remote = route.request().url().includes("github.io");
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ version: remote ? "app-v999" : "app-v17" }),
    });
  });
  let apkRequested = false;
  await page.route("**/family-bike-router.apk", (route) => {
    apkRequested = true;
    // don't actually navigate away in the test
    void route.abort();
  });
  await page.goto("/");
  await expect(page.locator("#update-banner")).toBeVisible({ timeout: 30_000 });
  await page.locator("#update-get").click();
  await expect.poll(() => apkRequested, { timeout: 10_000 }).toBe(true);
  // and the rider is told where the download went
  await expect(page.locator("#update-text")).toContainText(/notification/i);
});

// ── voice ─────────────────────────────────────────────────────────────────
// The stubs above make speech look like it works. On a real Android phone it
// can fail three ways that are identical from the saddle — no engine, no voice
// data for the language, or the WebView's voiceless speechSynthesis — and none
// of them announce themselves. These cover the reporting.

/** Native shim whose speech engine refuses, like a phone with no voice data. */
async function mutePhone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const noop = async (): Promise<void> => undefined;
    window.Capacitor = {
      isNativePlatform: () => true,
      registerPlugin: (name: string) => {
        if (name === "TextToSpeech") {
          return {
            speak: async () => {
              throw new Error("Language is not supported");
            },
            stop: noop,
          };
        }
        if (name === "Browser") return { open: noop };
        if (name === "BackgroundGeolocation") {
          return { addWatcher: async () => "w", removeWatcher: noop, openSettings: noop };
        }
        return {};
      },
    } as unknown as Window["Capacitor"];
    // Android's WebView: the API is there, the voices are not
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak: () => undefined, cancel: () => undefined, getVoices: () => [], speaking: false },
    });
  });
}

test("the voice test says which engine spoke", async ({ page }) => {
  await nativeShim(page);
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 60_000 });
  await page.locator("summary", { hasText: "Voice" }).first().click();
  await page.locator("#voice-test").click();
  await expect(page.locator("#voice-status")).toContainText(/phone's own voice engine/i);
  // and it points at the volume that actually matters
  await expect(page.locator("#voice-status")).toContainText(/MEDIA volume/i);
});

test("a phone with no voice data is told what to fix, not left silent", async ({ page }) => {
  await mutePhone(page);
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 60_000 });
  await page.locator("summary", { hasText: "Voice" }).first().click();
  await page.locator("#voice-test").click();
  // the engine's own reason, and where to fix it
  await expect(page.locator("#voice-status")).toContainText(/no usable voice/i);
  await expect(page.locator("#voice-status")).toContainText(/Language is not supported/);
  await expect(page.locator("#voice-status")).toContainText(/Text-to-speech/i);
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
