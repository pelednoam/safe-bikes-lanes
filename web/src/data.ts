// Data-layer source resolution for the native app: prefer the website's data
// when it is newer than the bundle, cached on-device per build version so a
// weekly refresh downloads once. The website itself always uses local paths,
// and any failure falls back to the bundled copy — offline keeps working.

import { isNativeApp } from "./native.js";

const SITE_DATA = "https://pelednoam.github.io/safe-bikes-lanes/data/";
const CACHE_PREFIX = "remote-data-";

/** The site's data in use, by the name its cache is kept under; null = the bundle. */
let remoteId: string | null = null;

/** True when `remote` is a strictly newer YYYY-MM-DD build date. */
export function isNewerBuild(bundled: string, remote: string): boolean {
  const ok = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
  return ok(bundled) && ok(remote) && remote > bundled;
}

/** What a data snapshot says about itself (meta.json). `version` and `builtAt`
 * come from pipeline/stamp_version.py; snapshots from before it have `built`,
 * a calendar date, only. */
export interface SnapshotMeta {
  built?: string;
  builtAt?: string;
  version?: string;
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
export function remoteDataId(bundled: SnapshotMeta, remote: SnapshotMeta): string | null {
  const stamped = (m: SnapshotMeta): boolean =>
    STAMP.test(m.builtAt ?? "") && VERSION.test(m.version ?? "");
  if (stamped(bundled) && stamped(remote)) {
    return remote.version !== bundled.version && (remote.builtAt as string) > (bundled.builtAt as string)
      ? (remote.version as string)
      : null;
  }
  if (bundled.built === undefined || remote.built === undefined) return null;
  if (!isNewerBuild(bundled.built, remote.built)) return null;
  return stamped(remote) ? (remote.version as string) : remote.built;
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
    const remote = (await remoteResp.json()) as SnapshotMeta;
    const bundled = (await (await fetch("data/meta.json")).json()) as SnapshotMeta;
    const id = remoteDataId(bundled, remote);
    if (id !== null) {
      remoteId = id;
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && key !== CACHE_PREFIX + id) {
          await caches.delete(key);
        }
      }
    }
  } catch {
    remoteId = null; // offline or slow network: ride on the bundle
  }
}

/** Whether layers are currently served from the website. */
export function usingRemoteData(): string | null {
  return remoteId;
}

/** Where a data file lives right now, for a download link.
 *
 * Not loadJson: the CSV is handed to the browser as a file rather than parsed,
 * so it needs the URL the resolver would have used, not its contents. */
export function dataUrl(name: string): string {
  return remoteId !== null ? SITE_DATA + name : `data/${name}`;
}

/** Where data comes from, decided once per launch by initDataSource: enough
 * for a Web Worker, which can't see this module's state, to load exactly what
 * the page would. */
export interface DataSource {
  /** The site's data in use (see usingRemoteData); null = the bundle. */
  remoteId: string | null;
  /** The bundle's data directory: "data/" on the page, an absolute URL in a
   * worker, whose relative URLs resolve against its own script. */
  bundled: string;
}

/** This page's data source, to hand to a worker. */
export function dataSource(): DataSource {
  return { remoteId, bundled: new URL("data/", document.baseURI).href };
}

/** The one tile set that only makes sense whole, from one build: routing tiles
 * are stitched together by node ids that hold within a build and not between
 * two. (Network tiles are only drawn, and a bundled one among the site's is a
 * slightly older street, not a broken graph.) */
const ONE_BUILD = /^tiles\//;

/** What a routing tile of the site's build that can't be had fails with: the
 * routing worker then routes on the bundle's whole set instead (routing.ts). */
export const SITE_TILE_MISSING = "of the site's data";

/** Load a data layer: the site's (cached per version) when it wins, else the bundle's. */
export async function loadJsonFrom<T>(source: DataSource, name: string): Promise<T> {
  if (source.remoteId !== null) {
    try {
      const cache = await caches.open(CACHE_PREFIX + source.remoteId);
      const url = SITE_DATA + name;
      const hit = await cache.match(url);
      if (hit) return (await hit.json()) as T;
      const resp = await fetch(url);
      if (resp.ok) {
        await cache.put(url, resp.clone());
        return (await resp.json()) as T;
      }
    } catch {
      // fall through to the bundled copy, unless it is from another build
    }
    // One tile of the site's build that didn't arrive, filled in from the
    // bundle's, joined the graph to tiles of another build: a graph that
    // routes, wrongly, and says nothing. Failing is honest, and is retried.
    if (ONE_BUILD.test(name)) throw new Error(`couldn't load ${name} ${SITE_TILE_MISSING}`);
  }
  return (await (await fetch(source.bundled + name)).json()) as T;
}

/** Load a data layer for this page. */
export function loadJson<T>(name: string): Promise<T> {
  return loadJsonFrom<T>({ remoteId, bundled: "data/" }, name);
}
