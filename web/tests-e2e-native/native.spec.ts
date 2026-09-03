// Emulates the Capacitor WebView app-layer against the shipped dist/ bundle.
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
    } as unknown as NonNullable<Window["Capacitor"]>;
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
  // "404" alone is deliberately not in here: only a probe for an optional layer
  // that a given data snapshot may not carry yet is allowed to miss.
  return /pelednoam\.github\.io|nominatim|priorities|ERR_FAILED|ERR_INTERNET_DISCONNECTED|CORS policy/i.test(
    text,
  );
}

async function bootNative(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // A failed resource load logs "the server responded with a status of 404"
    // with no URL in the text, so the filter has to read the location too —
    // otherwise every 404 is an anonymous line that can't be judged, or
    // dismissed wholesale, which would hide real ones.
    const where = m.location()?.url ?? "";
    if (m.type() === "error" && !isExpectedOfflineNoise(`${m.text()} ${where}`)) {
      errors.push(`console: ${m.text()} (${where})`);
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
  await expect(page.locator("#s-dist")).toContainText("mi");
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

  // The rider is told where to look, and not told that it worked.
  //
  // This message used to read "downloading…" from the moment the button was
  // tapped, whatever Android then did with the request — so a download that
  // silently went nowhere was reported as a success, and the only way to find out
  // was to go looking in Downloads for a file that was never written.
  const said = (await page.locator("#update-text").textContent()) ?? "";
  expect(said).toMatch(/notification/i);
  expect(said, "the app should say where to look, not that the file arrived").toMatch(
    /downloads/i,
  );
  expect(said, "claimed the download succeeded without knowing").not.toMatch(/^downloading/i);
});

test("the Android side asks for a real download, not for something to open the link", async () => {
  // Not runnable in a browser: this is the Java that decides what tapping
  // "install" does, and it is where the bug was. The WebView's DownloadListener
  // used to fire an ACTION_VIEW intent — "let some app open this URL" — which is
  // not a download request at all: whichever app claimed the link decided what to
  // do, and the file never reliably reached anywhere the rider could find it.
  //
  // Asserted as text because the alternative is an instrumented device. It cannot
  // prove the download works; it can prove nobody quietly went back to asking an
  // app to look at a link.
  const { readFileSync } = await import("node:fs");
  const java = readFileSync(
    "android/app/src/main/java/com/pelednoam/safebikes/MainActivity.java",
    "utf8",
  );
  expect(java, "no DownloadListener: the WebView drops downloads silently").toContain(
    "setDownloadListener",
  );
  expect(java, "downloads are not going through the system download service").toContain(
    "DownloadManager.Request",
  );
  // into the folder the rider will actually open, under a name worth reading
  expect(java).toContain("DIRECTORY_DOWNLOADS");
  expect(java).toContain("family-bike-router.apk");
  // and it shows progress, because a 90 MB file over a phone connection is not instant
  expect(java).toContain("VISIBILITY_VISIBLE_NOTIFY_COMPLETED");
  // ACTION_VIEW survives only as the fallback, inside a catch
  const listenerBody = java.slice(java.indexOf("setDownloadListener"));
  const firstView = listenerBody.indexOf("ACTION_VIEW");
  const firstCatch = listenerBody.indexOf("catch (");
  expect(firstView, "ACTION_VIEW is back on the main path").toBeGreaterThan(firstCatch);
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
    } as unknown as NonNullable<Window["Capacitor"]>;
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

test("the where-to-build link works inside the app, offline", async ({ page }) => {
  // The planner layers link to build/. In the APK that resolves inside the
  // bundle, so the page and the data it needs have to be there — a link that
  // dead-ends is worse than no link, and nobody would see it on the website.
  await nativeShim(page);
  await page.goto("/");
  const box = page.locator("details.section", { has: page.locator("#show-net") });
  await box.locator("summary").click();
  await page.locator("#layers-build-link").click();
  await page.waitForURL(/\/build\/$/);
  await expect(page.locator("#rank-panel h1")).toBeVisible();
  // the ranking is drawn from the bundled data, with no network
  await expect(page.locator(".row").first()).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("#built")).not.toHaveText("—");
});

test("the app says which release it is", async ({ page }) => {
  // On the phone the stamp carries the release tag, which is the version someone
  // would quote when reporting a problem. dist/build.json is written by
  // assemble.sh from the tag CI built with, and baked into app.js so it describes
  // the bundle actually installed rather than whatever the site serves now.
  await nativeShim(page);
  await page.goto("/");
  await page.locator("#about-top").click();
  await expect(page.locator("#about")).toBeVisible();

  const stamp = (await page.locator("#build-stamp").textContent()) ?? "";
  const bundled = (await (await page.request.get("/build.json")).json()) as {
    version?: string;
    built?: string;
    commit?: string;
  };
  expect(bundled.commit, "assemble.sh did not record the commit").toBeTruthy();
  expect(bundled.built).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  // A local build says "dev"; a CI build says app-vNN. Either way the stamp
  // names it rather than leaving the reader to guess.
  expect(stamp).toContain("You're running");
  expect(stamp).toContain(bundled.commit as string);
  if ((bundled.version ?? "dev") !== "dev") {
    expect(stamp, "the release tag is missing from the stamp").toContain(
      bundled.version as string,
    );
  }
  // and never the placeholder: an unsubstituted stamp is a broken assembly
  expect(stamp).not.toContain("__BUILD_STAMP__");
  expect(stamp).not.toContain("Development build");
});
