// Keeping the app current: the newer-version check for the phone app, and the
// service worker that keeps the web app and its data fresh.

import { DeferredReload } from "../lifecycle.js";
import { store } from "./store.js";
import { isNativeApp, isNewerAppVersion, startDownload } from "../native.js";
import { el } from "./dom.js";

/** A new build waits for the ride to end before the page reloads into it. */
export const swReload = new DeferredReload(
  () => store.navActive,
  () => location.reload(),
);

// The release asset, not the Pages mirror. Pages has a ~100 GB/month bandwidth
// allowance and the APK is 90 MB, so a thousand downloads would be the entire
// month's budget and would take the site down with it. Release downloads don't
// count against that at all.
const APK_URL =
  "https://github.com/pelednoam/safe-bikes-lanes/releases/latest/download/family-bike-router.apk";

async function checkAppUpdate(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const bundled = (await (await fetch("version.json")).json()) as { version?: string };
    const resp = await fetch(
      "https://pelednoam.github.io/safe-bikes-lanes/app/version.json",
      { cache: "no-store" },
    );
    if (!resp.ok) return;
    const latest = (await resp.json()) as { version?: string };
    if (
      bundled.version === undefined ||
      latest.version === undefined ||
      !isNewerAppVersion(bundled.version, latest.version)
    ) {
      return;
    }
    const banner = el<HTMLDivElement>("update-banner");
    el<HTMLElement>("update-text").textContent =
      `Update available: ${bundled.version} → ${latest.version}`;
    banner.style.display = "flex";
    const getBtn = el<HTMLAnchorElement>("update-get");
    getBtn.href = APK_URL; // plain link: works even if the handler never runs
    const text = el<HTMLElement>("update-text");
    getBtn.addEventListener("click", (ev: Event) => {
      ev.preventDefault();
      // Says where to look, not that it worked.
      //
      // This used to read "downloading…" the instant the button was tapped,
      // before anything had been asked of Android and whatever the answer was —
      // so when the download silently went nowhere, the app still reported
      // success. The wording now names the two places the file can appear and
      // leaves the rider able to tell that it hasn't.
      text.textContent = "asked Android to download it — look in your notifications, then Downloads";
      startDownload(APK_URL, latest.version);
    });
    el<HTMLButtonElement>("update-dismiss").addEventListener("click", () => {
      banner.style.display = "none";
    });
  } catch {
    // offline or first launch — try again next time
  }
}

export function initAppUpdate(): void {
  void checkAppUpdate();
}

export function initServiceWorker(): void {
  // service worker: register only on the website (PWA offline). In the native
  // app Capacitor already bundles everything offline, and a persistent SW would
  // serve a STALE app shell across APK updates (its origin outlives installs) —
  // so unregister any existing one, clear the cached shell, and reload once to
  // drop the stale shell immediately.
  if ("serviceWorker" in navigator) {
    if (isNativeApp()) {
      void (async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        let had = false;
        for (const r of regs) {
          had = true;
          await r.unregister();
        }
        try {
          // Only the stale shell a worker left behind. The bike-tiles* and
          // bike-styles* caches are the rider's downloaded offline maps, which
          // the app reads itself (tilecache.ts) — deleting them here, as this
          // once did on every launch, made "⬇ Offline map" a no-op in the app.
          for (const k of await caches.keys()) {
            if (k.startsWith("family-bike-router")) await caches.delete(k);
          }
        } catch {
          // caches API unavailable in this webview — nothing to clear
        }
        if (had && navigator.serviceWorker.controller && !sessionStorage.getItem("swCleared")) {
          sessionStorage.setItem("swCleared", "1");
          location.reload();
        }
      })();
    } else {
      // web PWA: auto-update to the newest build without a hard refresh.
      // Reload once when a NEW service worker takes control — but only if one
      // was already controlling at load (i.e. a genuine update, not first visit,
      // so we never reload-loop on initial install/clients.claim).
      if (navigator.serviceWorker.controller) {
        let reloaded = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (reloaded) return;
          reloaded = true;
          swReload.request(); // not mid-ride: held until the ride ends
        });
      }
      // updateViaCache:"none" — always fetch sw.js fresh so updates are detected
      void navigator.serviceWorker
        .register("sw.js", { updateViaCache: "none" })
        .then((reg) => reg.update())
        .catch(() => undefined);
    }
  }
}
