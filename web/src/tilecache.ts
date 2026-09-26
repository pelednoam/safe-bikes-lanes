// ---------------------------------------------------------------------------
// The basemap's offline cache, owned by the page rather than a service worker.
//
// "⬇ Offline map" used to fill CacheStorage and leave the reading to the
// service worker. The Android app has no service worker — it is deliberately
// never registered there, since one would outlive APK updates and serve a
// stale shell — so in the app the download filled a cache nothing read, and
// every launch then deleted it anyway. The button counted up, said "offline
// ready", and the map was blank on the road.
//
// So MapLibre loads Carto's vector tiles through a protocol handler that asks
// CacheStorage first and the network second. It runs the same way on the web
// and in the app, with or without a worker, and the worker now leaves these
// requests alone rather than caching every tile a second time.
//
// Three caches, kept apart because they are kept for different reasons:
//
//   TILE_CACHE    tiles the rider downloaded for a route. Never evicted by the
//                 app — deleting them is the rider's call, not ours.
//   BROWSE_CACHE  every tile seen while browsing, so places already looked at
//                 still draw offline. Bounded: oldest out first.
//   STYLE_CACHE   Carto's style JSON, without which a cold start offline has
//                 tiles and nothing to paint them with.
//
// TILE_CACHE keeps the name the worker used, so routes downloaded before this
// change are still found. It also holds whatever that worker cached while
// browsing, unbounded; there is no telling those tiles from downloaded ones,
// so they stay, and stop growing.
// ---------------------------------------------------------------------------

import type { GetResourceResponse, Map as MLMap, RequestParameters } from "maplibre-gl";

export const TILE_CACHE = "bike-tiles-v1";
export const BROWSE_CACHE = "bike-tiles-browse-v1";
export const STYLE_CACHE = "bike-styles-v1";

/** Browsed tiles kept. Carto's z13-14 street tiles run 20-120 KB, so this is
 * on the order of 50-100 MB — a few weeks of looking around one city. */
export const BROWSE_MAX = 1500;

/** Trimming lists every key; doing it once per this many new tiles keeps that
 * off the path of each tile while bounding the overshoot. */
const TRIM_EVERY = 25;

/** How long a style fetch may take before a cached copy is used instead. */
export const STYLE_TIMEOUT_MS = 5000;

/** The scheme MapLibre is pointed at for tiles that go through the cache. */
export const CACHE_PROTOCOL = "bikecache";

const CARTO_TILE_HOST = /^tiles(-[a-d])?\.basemaps\.cartocdn\.com$/;

/** What this module needs from the browser; tests hand in their own. */
export interface CacheDeps {
  caches: CacheStorage;
  fetch: typeof fetch;
}

function browserDeps(): CacheDeps | null {
  // CacheStorage exists only in secure contexts (https, localhost, the app's
  // own https://localhost). Elsewhere tiles simply come off the network.
  if (typeof caches === "undefined") return null;
  return { caches, fetch: (input, init) => fetch(input, init) };
}

/**
 * One cache key per tile, whichever of Carto's four hosts served it.
 *
 * MapLibre spreads vector tiles across tiles-a…d by tile coordinate, so the
 * host for a given tile is not ours to predict. Keying on the URL as requested
 * would store up to four copies of the same tile and, worse, let a route
 * downloaded against one host miss on all the others. The same rule as
 * tileKey in sw.js, which still keys what the worker caches.
 */
export function tileKey(requestUrl: string): string {
  const url = new URL(requestUrl);
  // Anchored to Carto's own hosts, not to anything merely beginning "tiles-b.".
  url.hostname = url.hostname.replace(
    /^tiles-[a-d]\.basemaps\.cartocdn\.com$/,
    "tiles-a.basemaps.cartocdn.com",
  );
  return url.toString();
}

/** A Carto vector tile — the only thing the protocol handler takes over. */
export function isCartoTile(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && CARTO_TILE_HOST.test(u.hostname) && u.pathname.endsWith(".mvt");
  } catch {
    return false;
  }
}

export const toCacheUrl = (url: string): string => url.replace(/^https:/, `${CACHE_PROTOCOL}:`);
export const fromCacheUrl = (url: string): string =>
  url.replace(new RegExp(`^${CACHE_PROTOCOL}:`), "https:");

/** An HTTP refusal, shaped like MapLibre's AJAXError so a 404 tile is treated
 * as an empty one rather than as a failure. */
export class TileHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
  ) {
    super(`tile ${status} ${statusText}: ${url}`);
    this.name = "AJAXError";
  }
}

/** Opened once per storage and name: every tile is looked up in two caches,
 * and reopening them each time is a round trip per tile for nothing. */
const opened = new WeakMap<CacheStorage, Map<string, Promise<Cache>>>();

function open(deps: CacheDeps, name: string): Promise<Cache> {
  let byName = opened.get(deps.caches);
  if (byName === undefined) {
    byName = new Map();
    opened.set(deps.caches, byName);
  }
  let cache = byName.get(name);
  if (cache === undefined) {
    cache = deps.caches.open(name);
    // a failed open is not remembered, so the next tile tries again
    cache.catch(() => byName?.delete(name));
    byName.set(name, cache);
  }
  return cache;
}

async function lookup(deps: CacheDeps, key: string, names: string[]): Promise<Response | undefined> {
  for (const name of names) {
    const hit = await (await open(deps, name)).match(key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Drop the oldest entries until at most `max` remain. CacheStorage lists keys
 * in insertion order, so the front of the list is the oldest. */
export async function trimCache(cache: Cache, max: number): Promise<number> {
  const keys = await cache.keys();
  const excess = keys.slice(0, Math.max(0, keys.length - max));
  for (const k of excess) await cache.delete(k);
  return excess.length;
}

let putsSinceTrim = 0;

async function rememberBrowsed(deps: CacheDeps, key: string, data: ArrayBuffer, type: string | null): Promise<void> {
  const cache = await open(deps, BROWSE_CACHE);
  await cache.put(key, new Response(data, { headers: { "content-type": type ?? "application/x-protobuf" } }));
  putsSinceTrim++;
  if (putsSinceTrim >= TRIM_EVERY) {
    putsSinceTrim = 0;
    await trimCache(cache, BROWSE_MAX);
  }
}

/**
 * A tile's bytes: from a downloaded route, else from what was browsed, else
 * from the network — stored for next time in the bounded browse cache.
 *
 * The network request goes to the host MapLibre asked for, not the canonical
 * one: spreading load across Carto's four hosts is the point of having four.
 */
export async function cachedTile(
  url: string,
  signal?: AbortSignal,
  deps: CacheDeps | null = browserDeps(),
): Promise<ArrayBuffer> {
  if (deps === null) {
    const resp = await fetch(url, signal ? { signal } : {});
    if (!resp.ok) throw new TileHttpError(resp.status, resp.statusText, url);
    return resp.arrayBuffer();
  }
  const key = tileKey(url);
  const hit = await lookup(deps, key, [TILE_CACHE, BROWSE_CACHE]);
  if (hit !== undefined) return hit.arrayBuffer();
  const resp = await deps.fetch(url, signal ? { signal } : {});
  // Never store a refusal as if it were a tile: a 403 or a 500 kept here is
  // served from disk for as long as it lives, turning one bad minute into a
  // permanently broken patch of map.
  if (!resp.ok) throw new TileHttpError(resp.status, resp.statusText, url);
  const data = await resp.arrayBuffer();
  // Storing is best effort and must not delay the map, or fail it: a full
  // disk is not a reason to not draw the tile we already have.
  void rememberBrowsed(deps, key, data.slice(0), resp.headers.get("content-type")).catch(
    () => undefined,
  );
  return data;
}

/**
 * A style's JSON: the network's if it answers in time, else the cached copy,
 * else — with nothing cached — whatever the network eventually says.
 *
 * Every successful fetch refreshes the cache, so a rider who has opened the map
 * once online has what a cold offline start needs, download or not.
 */
export async function cachedStyle<T>(
  url: string,
  deps: CacheDeps | null = browserDeps(),
  timeoutMs = STYLE_TIMEOUT_MS,
): Promise<T> {
  const fromNetwork = async (): Promise<T> => {
    const fetchFn = deps?.fetch ?? fetch;
    const resp = await fetchFn(url);
    if (!resp.ok) throw new Error(`carto style ${resp.status}`);
    const text = await resp.text();
    const parsed = JSON.parse(text) as T;
    if (deps !== null) {
      void deps.caches
        .open(STYLE_CACHE)
        .then((c) => c.put(url, new Response(text, { headers: { "content-type": "application/json" } })))
        .catch(() => undefined);
    }
    return parsed;
  };
  if (deps === null) return fromNetwork();
  const fromCache = async (): Promise<T | undefined> => {
    // TILE_CACHE too: the service worker used to keep styles there, and until
    // a start with signal refreshes STYLE_CACHE that copy is the only one.
    const hit = await lookup(deps, url, [STYLE_CACHE, TILE_CACHE]);
    return hit === undefined ? undefined : ((await hit.json()) as T);
  };
  const network = fromNetwork();
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const settle = (value: T): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      void fromCache().then((hit) => {
        if (hit !== undefined) settle(hit);
      });
    }, timeoutMs);
    network.then(settle, (err: unknown) => {
      void fromCache().then((hit) => {
        if (hit !== undefined) settle(hit);
        else if (!done) {
          done = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  });
}

let protocolAdded = false;

/**
 * Route `map`'s Carto vector tiles through the cache. Safe to call more than
 * once, and on more than one map.
 *
 * Must be called before the map requests its first tile — right after
 * constructing it — or those first tiles bypass the cache.
 */
export function installTileCache(
  map: Pick<MLMap, "setTransformRequest">,
  addProtocol: (name: string, fn: (p: RequestParameters, a: AbortController) => Promise<GetResourceResponse<ArrayBuffer>>) => void,
): void {
  if (browserDeps() === null) return;
  if (!protocolAdded) {
    protocolAdded = true;
    addProtocol(CACHE_PROTOCOL, async (params, abort) => ({
      data: await cachedTile(fromCacheUrl(params.url), abort.signal),
    }));
  }
  map.setTransformRequest((url, resourceType) =>
    resourceType === "Tile" && isCartoTile(url) ? { url: toCacheUrl(url) } : undefined,
  );
}

// ---------------------------------------------------------------------------
// the "⬇ Offline map" download
// ---------------------------------------------------------------------------

/** Ask the browser not to evict what is stored here under storage pressure —
 * and on iOS, not to wipe it after seven days without a visit. Worth asking at
 * the moment the rider shows they are counting on it. Browsers may say no;
 * the download goes ahead either way. */
export async function requestPersistence(nav: Navigator = navigator): Promise<boolean> {
  try {
    return (await nav.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export interface DownloadResult {
  stored: number;
  failed: number;
  persisted: boolean;
}

/**
 * Store a route's tiles, and the styles needed to paint them, for offline use.
 *
 * Tiles go into TILE_CACHE, which is never trimmed. A tile already browsed is
 * copied across rather than fetched again. Styles are refetched every time, so
 * a download also refreshes them.
 */
export async function downloadOffline(
  tileUrls: string[],
  styleUrls: string[],
  onProgress: (done: number, total: number) => void,
  deps: CacheDeps | null = browserDeps(),
  nav: Navigator = navigator,
): Promise<DownloadResult> {
  if (deps === null) return { stored: 0, failed: tileUrls.length, persisted: false };
  const persisted = await requestPersistence(nav);
  const pinned = await deps.caches.open(TILE_CACHE);
  const browse = await deps.caches.open(BROWSE_CACHE);
  const styles = await deps.caches.open(STYLE_CACHE);
  let stored = 0;
  let failed = 0;
  let done = 0;
  const total = tileUrls.length + styleUrls.length;

  const queue = [...tileUrls];
  const worker = async (): Promise<void> => {
    for (;;) {
      const url = queue.shift();
      if (url === undefined) return;
      const key = tileKey(url);
      try {
        if ((await pinned.match(key)) !== undefined) {
          stored++;
        } else {
          const seen = await browse.match(key);
          // A real CORS fetch, never mode:"no-cors": MapLibre has to read these
          // as bytes, and an opaque body stores fine and parses to nothing.
          const resp = seen ?? (await deps.fetch(url));
          if (resp.ok) {
            await pinned.put(key, resp);
            stored++;
          } else {
            failed++;
          }
        }
      } catch {
        failed++; // offline mid-download or a missing tile: skip it
      }
      onProgress(++done, total);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  for (const url of styleUrls) {
    try {
      const resp = await deps.fetch(url);
      if (resp.ok) await styles.put(url, resp);
    } catch {
      // the copy from the last online start, if any, is still there
    }
    onProgress(++done, total);
  }
  return { stored, failed, persisted };
}
