// Data-layer source resolution for the native app: prefer the website's data
// when it is newer than the bundle, cached on-device per build version so a
// weekly refresh downloads once. The website itself always uses local paths,
// and any failure falls back to the bundled copy — offline keeps working.
import { isNativeApp } from "./native.js";
const SITE_DATA = "https://pelednoam.github.io/safe-bikes-lanes/data/";
const CACHE_PREFIX = "remote-data-";
/** The site's data in use, by the name its cache is kept under; null = the bundle. */
let remoteId = null;
/** True when `remote` is a strictly newer YYYY-MM-DD build date. */
export function isNewerBuild(bundled, remote) {
    const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    return ok(bundled) && ok(remote) && remote > bundled;
}
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;
const VERSION = /^[0-9a-f]{16}$/;
/** Whether the site's data should replace the bundled copy: the name to cache
 * it under if so, null to stay on the bundle.
 *
 * Both stamped: when its content differs and it was made later. The date alone
 * was the rule until a second rebuild on the same day, which had the same name
 * as the first and so never reached a phone that already held it. A rebuild
 * that produced the same data has the same version and costs no download.
 * Anything unstamped keeps the date rule, strictly newer only. */
export function remoteDataId(bundled, remote) {
    const stamped = (m) => STAMP.test(m.builtAt ?? "") && VERSION.test(m.version ?? "");
    if (stamped(bundled) && stamped(remote)) {
        return remote.version !== bundled.version && remote.builtAt > bundled.builtAt
            ? remote.version
            : null;
    }
    if (bundled.built === undefined || remote.built === undefined)
        return null;
    if (!isNewerBuild(bundled.built, remote.built))
        return null;
    return stamped(remote) ? remote.version : remote.built;
}
/** Decide once per launch whether the site's data supersedes the bundle. */
export async function initDataSource() {
    if (!isNativeApp())
        return;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const remoteResp = await fetch(`${SITE_DATA}meta.json`, {
            cache: "no-store",
            signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!remoteResp.ok)
            return;
        const remote = (await remoteResp.json());
        const bundled = (await (await fetch("data/meta.json")).json());
        const id = remoteDataId(bundled, remote);
        if (id !== null) {
            remoteId = id;
            for (const key of await caches.keys()) {
                if (key.startsWith(CACHE_PREFIX) && key !== CACHE_PREFIX + id) {
                    await caches.delete(key);
                }
            }
        }
    }
    catch {
        remoteId = null; // offline or slow network: ride on the bundle
    }
}
/** Whether layers are currently served from the website. */
export function usingRemoteData() {
    return remoteId;
}
/** Where a data file lives right now, for a download link.
 *
 * Not loadJson: the CSV is handed to the browser as a file rather than parsed,
 * so it needs the URL the resolver would have used, not its contents. */
export function dataUrl(name) {
    return remoteId !== null ? SITE_DATA + name : `data/${name}`;
}
/** Load a data layer: the site's (cached per version) when it wins, else the bundle's. */
export async function loadJson(name) {
    if (remoteId !== null) {
        try {
            const cache = await caches.open(CACHE_PREFIX + remoteId);
            const url = SITE_DATA + name;
            const hit = await cache.match(url);
            if (hit)
                return (await hit.json());
            const resp = await fetch(url);
            if (resp.ok) {
                await cache.put(url, resp.clone());
                return (await resp.json());
            }
        }
        catch {
            // fall through to the bundled copy
        }
    }
    return (await (await fetch(`data/${name}`)).json());
}
