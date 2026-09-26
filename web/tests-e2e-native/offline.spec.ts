// "⬇ Offline map" inside the Android app, where there is no service worker.
//
// On the website the download worked because the worker read the cache back.
// The app deliberately never registers one — it would outlive APK updates and
// serve a stale shell — so in the app the download filled a cache nothing
// read, and every launch then deleted it. The button counted up and said
// "offline ready" all the same. Nothing on the website could show this: the
// failure only exists where isNativeApp() is true.
//
// So the app is booted as the app (dist/ bundle, Capacitor shimmed), a route
// is downloaded, the app is relaunched, the internet is cut — everything but
// the bundle itself, which on a phone is on the phone — and the map is asked
// whether it drew, in both themes a rider might switch between.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

declare global {
  interface Window {
    _map?: MLMap;
  }
}

type Page = import("@playwright/test").Page;
type BrowserContext = import("@playwright/test").BrowserContext;

// Davis Sq -> Kendall, the ground-truth route used elsewhere in the suite
const ROUTE = "/#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

async function asTheApp(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
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
    } as unknown as NonNullable<Window["Capacitor"]>;
  });
}

/** Everything off the device is unreachable; the bundle is still there. */
async function cutTheInternet(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    (route) => route.abort("internetdisconnected"),
  );
}

async function downloadOfflineMap(page: Page): Promise<void> {
  await page.locator("summary", { hasText: "Export & offline" }).first().click();
  const btn = page.locator("#offline-btn");
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  // disabled for exactly the length of the download — the label is the same
  // before and after, so it cannot be waited on
  await page.waitForFunction(
    () => (document.getElementById("offline-btn") as HTMLButtonElement).disabled,
    null,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => !(document.getElementById("offline-btn") as HTMLButtonElement).disabled,
    null,
    { timeout: 120_000 },
  );
}

/** Rendered basemap line features of one theme — what a rider would see, not
 * whether a source claims to have loaded. */
function basemapDrawn(page: Page, theme: "light" | "dark"): Promise<number> {
  return page.evaluate((t) => {
    const map = window._map;
    if (!map) return 0;
    const lines = (map.getStyle().layers ?? [])
      .filter((l) => l.id.startsWith(`bm-${t}-`) && l.type === "line")
      .map((l) => l.id);
    if (lines.length === 0) return 0;
    return map.queryRenderedFeatures(undefined, { layers: lines }).length;
  }, theme);
}

test("a downloaded route draws its map in the app with no internet", async ({ context }) => {
  test.slow();
  await asTheApp(context);
  const page = await context.newPage();
  await page.goto(ROUTE);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 60_000 });
  await downloadOfflineMap(page);
  await expect(page.locator("#offline-btn")).not.toContainText(/missing|failed/);

  // Relaunch: every launch of the app used to delete the tile cache.
  await page.reload();
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 60_000,
  });
  const kept = await page.evaluate(async () => {
    const names = await caches.keys();
    const tiles = names.includes("bike-tiles-v1")
      ? (await (await caches.open("bike-tiles-v1")).keys()).length
      : 0;
    return { names, tiles };
  });
  expect(kept.tiles, `relaunching emptied the download (caches: ${kept.names.join(", ")})`).toBeGreaterThan(0);
  await page.close();

  // A cold start with no signal: a new page, nothing in memory, no internet.
  await cutTheInternet(context);
  const cold = await context.newPage();
  await cold.goto(ROUTE);
  await expect
    .poll(() => basemapDrawn(cold, "light"), { timeout: 60_000 })
    .toBeGreaterThan(0);

  // Night mode on the way home: the other theme's style was downloaded too.
  await cold.evaluate(() => {
    const box = document.getElementById("dark-mode") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect
    .poll(() => basemapDrawn(cold, "dark"), { timeout: 60_000 })
    .toBeGreaterThan(0);
});
