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
  /** What AppShell reports about location; a test may change it mid-run. */
  location: { precise: boolean; approximate: boolean; enabled: boolean; notifications: string };
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
  // The bundled data only. With the site reachable, the app fetches a newer data
  // build when there is one, and the route waits on that download — a network
  // race these tests are not about.
  await page.route(/pelednoam\.github\.io/, (route) => route.abort());
  await page.addInitScript((opts: ShimOptions) => {
    const shell: ShellState = {
      calls: [],
      args: [],
      back: null,
      watcher: null,
      location: opts.location ?? {
        precise: true,
        approximate: true,
        enabled: true,
        notifications: "prompt",
      },
    };
    window.__shell = shell;
    const record =
      (name: string, result: () => unknown = () => undefined) =>
      async (arg?: unknown): Promise<unknown> => {
        shell.calls.push(name);
        shell.args.push(arg);
        return result();
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
        locationStatus: record("AppShell.locationStatus", () => shell.location),
        requestLocation: record("AppShell.requestLocation", () => shell.location),
        requestNotifications: record("AppShell.requestNotifications", () => {
          shell.location = { ...shell.location, notifications: "granted" };
          return { notifications: "granted" };
        }),
        openLocationSettings: record("AppShell.openLocationSettings"),
        openAppSettings: record("AppShell.openAppSettings"),
        keepScreenOn: record("AppShell.keepScreenOn"),
        downloadUpdate: record("AppShell.downloadUpdate", () => ({ status: "started" })),
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

// ── location and notifications when a ride starts ─────────────────────────

test("opening the app asks for nothing", async ({ page }) => {
  // It used to raise Android's location dialog at launch, before anyone had
  // planned a trip; now a ride asks, or "Your location" does when first used.
  await androidShim(page);
  await boot(page);
  const made = await calls(page);
  expect(made).not.toContain("AppShell.requestLocation");
  expect(made).not.toContain("AppShell.requestNotifications");
});

test("a ride asks for location, then notifications, and only then starts the watcher", async ({
  page,
}) => {
  await androidShim(page);
  await startRide(page);
  await expect.poll(() => calls(page)).toContain("BackgroundGeolocation.addWatcher");
  const made = await calls(page);
  const at = (name: string): number => made.indexOf(name);
  expect(at("AppShell.requestLocation")).toBeGreaterThanOrEqual(0);
  expect(at("AppShell.requestNotifications")).toBeGreaterThan(at("AppShell.requestLocation"));
  // The service starts with the permission already held, so the plugin must not
  // ask again inside addWatcher — that is where the Android 14 start failed.
  expect(at("BackgroundGeolocation.addWatcher")).toBeGreaterThan(
    at("AppShell.requestNotifications"),
  );
  const options = await page.evaluate(
    () => window.__shell.args[window.__shell.calls.indexOf("BackgroundGeolocation.addWatcher")],
  );
  expect(options).toMatchObject({ requestPermissions: false });
  // the line shown while the dialog was up is gone once it is answered
  await expect(page.locator("#nav-alert")).toBeHidden();

  // a second ride does not ask about notifications again
  await pressBack(page);
  await page.locator("#nav-ask-yes").click();
  await page.locator("#nav-btn").click();
  await expect
    .poll(async () => (await calls(page)).filter((c) => c.endsWith("addWatcher")).length)
    .toBe(2);
  expect((await calls(page)).filter((c) => c === "AppShell.requestNotifications")).toHaveLength(1);
});

test("approximate location is explained, and no watcher starts on it", async ({ page }) => {
  await androidShim(page, {
    location: { precise: false, approximate: true, enabled: true, notifications: "granted" },
  });
  await startRide(page);
  const alert = page.locator("#nav-alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/precise location/i);
  await expect(alert).not.toContainText(/all the time/i);
  expect(await calls(page)).not.toContain("BackgroundGeolocation.addWatcher");
  await alert.click();
  await expect.poll(() => calls(page)).toContain("AppShell.openAppSettings");

  // back from Settings with precise location on: the ride picks itself up,
  // without raising another dialog
  await page.evaluate(() => {
    window.__shell.location = { ...window.__shell.location, precise: true };
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => calls(page)).toContain("BackgroundGeolocation.addWatcher");
  expect((await calls(page)).filter((c) => c === "AppShell.requestLocation")).toHaveLength(1);
});

test("a refused permission says 'while using the app', not 'all the time'", async ({ page }) => {
  await androidShim(page, {
    location: { precise: false, approximate: false, enabled: true, notifications: "granted" },
  });
  await startRide(page);
  const alert = page.locator("#nav-alert");
  await expect(alert).toContainText(/while using the app/i);
  await expect(alert).not.toContainText(/all the time/i);
  expect(await calls(page)).not.toContain("BackgroundGeolocation.addWatcher");
});

test("location switched off says so, and taps through to the switch", async ({ page }) => {
  await androidShim(page, {
    location: { precise: true, approximate: true, enabled: false, notifications: "granted" },
  });
  await startRide(page);
  const alert = page.locator("#nav-alert");
  await expect(alert).toContainText(/location is off/i);
  // the watcher starts anyway: its fixes arrive the moment location is on
  await expect.poll(() => calls(page)).toContain("BackgroundGeolocation.addWatcher");
  await alert.click();
  await expect.poll(() => calls(page)).toContain("AppShell.openLocationSettings");
  expect(await calls(page)).not.toContain("AppShell.openAppSettings");
});

test("the watcher's NOT_AUTHORIZED is explained by what is actually wrong", async ({ page }) => {
  await androidShim(page);
  await startRide(page);
  await expect.poll(() => page.evaluate(() => window.__shell.watcher !== null)).toBe(true);
  // location is switched off mid-ride, and the plugin reports NOT_AUTHORIZED
  await page.evaluate(() => {
    window.__shell.location = { ...window.__shell.location, enabled: false };
    window.__shell.watcher?.(undefined, {
      code: "NOT_AUTHORIZED",
      message: "Location services disabled.",
    });
  });
  const alert = page.locator("#nav-alert");
  await expect(alert).toContainText(/location is off/i);
  await expect(alert).not.toContainText(/all the time/i);
  // and nothing was opened without being asked
  expect(await calls(page)).not.toContain("BackgroundGeolocation.openSettings");
  expect(await calls(page)).not.toContain("AppShell.openLocationSettings");
});

// ── the update ─────────────────────────────────────────────────────────────

test("an update downloads under its own version's name, through Android", async ({ page }) => {
  await androidShim(page);
  await page.route("**/version.json", (route) => {
    const remote = route.request().url().includes("github.io");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ version: remote ? "app-v999" : "app-v17" }),
    });
  });
  let iframeFetch = false;
  await page.route("**/family-bike-router.apk", (route) => {
    iframeFetch = true;
    return route.abort();
  });
  await page.goto("/");
  await expect(page.locator("#update-banner")).toBeVisible({ timeout: 30_000 });
  await page.locator("#update-get").click();
  await expect.poll(() => calls(page)).toContain("AppShell.downloadUpdate");
  const asked = await page.evaluate(
    () => window.__shell.args[window.__shell.calls.indexOf("AppShell.downloadUpdate")],
  );
  expect(asked).toMatchObject({
    url: expect.stringContaining("releases/latest/download/family-bike-router.apk"),
    fileName: "family-bike-router-app-v999.apk",
  });
  // not also through the iframe, which Capacitor may divert to the browser
  expect(iframeFetch).toBe(false);
});

// ── the status bar ─────────────────────────────────────────────────────────

test("the status bar follows the app's dark mode, not the phone's", async ({ page }) => {
  // Capacitor's default follows the phone's theme: white icons over the
  // near-white map for anyone whose phone is in dark mode.
  await page.emulateMedia({ colorScheme: "dark" }); // the phone is dark...
  await androidShim(page);
  await boot(page); // ...the app is light unless switched
  const styles = (): Promise<unknown[]> =>
    page.evaluate(() =>
      window.__shell.args.filter((_a, i) => window.__shell.calls[i] === "SystemBars.setStyle"),
    );
  await expect.poll(styles).toEqual([{ style: "LIGHT" }]);
  await page.evaluate(() => document.getElementById("dark-mode")?.click());
  await expect.poll(styles).toEqual([{ style: "LIGHT" }, { style: "DARK" }]);
  await page.evaluate(() => document.getElementById("dark-mode")?.click());
  await expect.poll(styles).toEqual([{ style: "LIGHT" }, { style: "DARK" }, { style: "LIGHT" }]);
});

// ── the screen ─────────────────────────────────────────────────────────────

test("the screen is held on for a ride, and let go when it ends", async ({ page }) => {
  // It used to be held on for as long as the app was open, planning included.
  await androidShim(page);
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  expect(await calls(page), "planning must not hold the screen on").not.toContain(
    "AppShell.keepScreenOn",
  );
  await page.locator("#nav-btn").click();
  await expect.poll(() => calls(page)).toContain("AppShell.keepScreenOn");
  const screenArgs = (): Promise<unknown[]> =>
    page.evaluate(() =>
      window.__shell.args.filter((_a, i) => window.__shell.calls[i] === "AppShell.keepScreenOn"),
    );
  expect(await screenArgs()).toEqual([{ on: true }]);

  await pressBack(page);
  await page.locator("#nav-ask-yes").click();
  await expect.poll(screenArgs).toEqual([{ on: true }, { on: false }]);
});
