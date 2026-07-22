// Data-layer source resolution for the native app: prefer the website's data
// when it is newer than the bundle, cached on-device per build version so a
// weekly refresh downloads once. The website itself always uses local paths,
// and any failure falls back to the bundled copy — offline keeps working.

import { isNativeApp } from "./native.js";

const SITE_DATA = "https://pelednoam.github.io/safe-bikes-lanes/data/";
const CACHE_PREFIX = "remote-data-";

let remoteBuilt: string | null = null;

/** True when `remote` is a strictly newer YYYY-MM-DD build date. */
export function isNewerBuild(bundled: string, remote: string): boolean {
  const ok = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
  return ok(bundled) && ok(remote) && remote > bundled;
}

/** Decide once per launch whether the site's data supersedes the bundle. */
export async function initDataSource(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const remoteResp = await fetch(`${SITE_DATA}meta.json`, {
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!remoteResp.ok) return;
    const remote = (await remoteResp.json()) as { built?: string };
    const bundled = (await (await fetch("data/meta.json")).json()) as { built?: string };
    if (
      remote.built !== undefined &&
      bundled.built !== undefined &&
      isNewerBuild(bundled.built, remote.built)
    ) {
      remoteBuilt = remote.built;
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && key !== CACHE_PREFIX + remoteBuilt) {
          await caches.delete(key);
        }
      }
    }
  } catch {
    remoteBuilt = null; // offline or slow network: ride on the bundle
  }
}

/** Whether layers are currently served from the website. */
export function usingRemoteData(): string | null {
  return remoteBuilt;
}

/** Load a data layer: site (cached per build) when newer, else the bundle. */
export async function loadJson<T>(name: string): Promise<T> {
  if (remoteBuilt !== null) {
    try {
      const cache = await caches.open(CACHE_PREFIX + remoteBuilt);
      const url = SITE_DATA + name;
      const hit = await cache.match(url);
      if (hit) return (await hit.json()) as T;
      const resp = await fetch(url);
      if (resp.ok) {
        await cache.put(url, resp.clone());
        return (await resp.json()) as T;
      }
    } catch {
      // fall through to the bundled copy
    }
  }
  return (await (await fetch(`data/${name}`)).json()) as T;
}
