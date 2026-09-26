// The Android shell's side of the app, against the shipped dist/ bundle: Back,
// asking for permissions at the right moment, and saying the right thing when
// location is not usable. The plugins are shims that record what they were
// asked, since what matters here is the order and the wording — whether Android
// then does what it is asked is for a phone to show.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

type Page = import("@playwright/test").Page;

interface ShellState {
  /** Every native call, in order, as "Plugin.method". */
  calls: string[];
  /** What each call was passed, in the same order. */
  args: unknown[];
  /** The App plugin's Back listener, once the app has registered one. */
  back: (() => void) | null;
  /** The watcher's callback, to deliver errors through it. */
  watcher: ((position?: unknown, error?: { code?: string; message?: string }) => void) | null;
}

declare global {
  interface Window {
    _map?: MLMap;
    __shell: ShellState;
  }
}

interface ShimOptions {
  /** What locationStatus/requestLocation report. */
  location?: { precise: boolean; approximate: boolean; enabled: boolean; notifications: string };
  /** Whether the AppShell plugin exists at all (an older shell has none). */
  appShell?: boolean;
}

async function androidShim(page: Page, options: ShimOptions = {}): Promise<void> {
  await page.addInitScript((opts: ShimOptions) => {
    const shell: ShellState = { calls: [], args: [], back: null, watcher: null };
    window.__shell = shell;
    const record =
      (name: string, result: unknown = undefined) =>
      async (arg?: unknown): Promise<unknown> => {
        shell.calls.push(name);
        shell.args.push(arg);
        return result;
      };
    const location = opts.location ?? {
      precise: true,
      approximate: true,
      enabled: true,
      notifications: "prompt",
    };
    const plugins: Record<string, Record<string, unknown>> = {
      TextToSpeech: { speak: record("TextToSpeech.speak"), stop: async () => undefined },
      BackgroundGeolocation: {
        addWatcher: async (options: unknown, cb: ShellState["watcher"]) => {
          shell.calls.push("BackgroundGeolocation.addWatcher");
          shell.args.push(options);
          shell.watcher = cb;
          return "w1";
        },
        removeWatcher: record("BackgroundGeolocation.removeWatcher"),
        openSettings: record("BackgroundGeolocation.openSettings"),
      },
      App: {
        addListener: async (event: string, cb: () => void) => {
          if (event === "backButton") shell.back = cb;
          return { remove: async () => undefined };
        },
        minimizeApp: record("App.minimizeApp"),
      },
      SystemBars: { setStyle: record("SystemBars.setStyle") },
    };
    if (opts.appShell !== false) {
      plugins["AppShell"] = {
        locationStatus: record("AppShell.locationStatus", location),
        requestLocation: record("AppShell.requestLocation", location),
        requestNotifications: record("AppShell.requestNotifications", {
          notifications: "granted",
        }),
        openLocationSettings: record("AppShell.openLocationSettings"),
        openAppSettings: record("AppShell.openAppSettings"),
        keepScreenOn: record("AppShell.keepScreenOn"),
        downloadUpdate: record("AppShell.downloadUpdate", { status: "started" }),
      };
    }
    window.Capacitor = {
      isNativePlatform: () => true,
      registerPlugin: (name: string) => plugins[name] ?? {},
    } as unknown as NonNullable<Window["Capacitor"]>;
    // headless Chromium has no voices; the ride only needs speak() not to throw
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak: () => undefined, cancel: () => undefined, getVoices: () => [], speaking: false },
    });
  }, options);
}

const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

async function boot(page: Page, hash = ""): Promise<void> {
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 60_000,
  });
}

async function startRide(page: Page): Promise<void> {
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
}

async function pressBack(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__shell.back !== null)).toBe(true);
  await page.evaluate(() => window.__shell.back?.());
}

async function calls(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__shell.calls);
}

// ── Back ───────────────────────────────────────────────────────────────────

test("Back closes an open dialog instead of leaving the app", async ({ page }) => {
  await androidShim(page);
  await boot(page);
  await page.locator("#about-top").click();
  await expect(page.locator("#about")).toBeVisible();
  await pressBack(page);
  await expect(page.locator("#about")).toBeHidden();
  expect(await calls(page)).not.toContain("App.minimizeApp");
});

test("Back on the planner sends the app to the background, not closed", async ({ page }) => {
  await androidShim(page);
  await boot(page);
  await pressBack(page);
  await expect.poll(() => calls(page)).toContain("App.minimizeApp");
});

test("Back mid-ride asks before ending it, and a second Back keeps riding", async ({ page }) => {
  await androidShim(page);
  await startRide(page);
  await pressBack(page);
  await expect(page.locator("#nav-ask")).toBeVisible();
  await expect(page.locator("#nav-ask-text")).toHaveText("End the ride?");
  // the ride is still on: nothing was stopped, nothing minimised
  expect(await calls(page)).not.toContain("BackgroundGeolocation.removeWatcher");
  expect(await calls(page)).not.toContain("App.minimizeApp");

  await pressBack(page);
  await expect(page.locator("#nav-ask")).toBeHidden();
  await expect(page.locator("#nav-banner")).toBeVisible();
  expect(await calls(page)).not.toContain("BackgroundGeolocation.removeWatcher");

  // and answering yes does end it
  await pressBack(page);
  await page.locator("#nav-ask-yes").click();
  await expect(page.locator("#nav-banner")).toBeHidden();
  await expect.poll(() => calls(page)).toContain("BackgroundGeolocation.removeWatcher");
});

test("Back closes the stops menu before it asks about the ride", async ({ page }) => {
  await androidShim(page);
  await startRide(page);
  await page.locator("#nav-stops").click();
  await expect(page.locator("#nav-stops-menu")).toBeVisible();
  await pressBack(page);
  await expect(page.locator("#nav-stops-menu")).toBeHidden();
  await expect(page.locator("#nav-ask")).toBeHidden();
});
