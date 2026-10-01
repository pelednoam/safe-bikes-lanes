// ---------------------------------------------------------------------------
// The basemap's tiles, through a cache the page owns rather than a service worker.
//
// The basemap is one file, basemap.pmtiles, which the site serves (see
// basemap.ts). MapLibre asks for tiles as bikecache://basemap/{z}/{x}/{y}.mvt,
// and the handler here answers from CacheStorage first and from the file
// second, reading just that tile out of it by byte range. It runs the same
// way on the web and in the Android app, which has no service worker (one
// would outlive APK updates and serve a stale shell), so "⬇ Offline map" works
// in both.
//
// Two caches, kept apart because they are kept for different reasons:
//
//   TILE_CACHE    tiles the rider downloaded for a route. Never evicted by the
//                 app; deleting them is the rider's call, not ours.
//   BROWSE_CACHE  every tile seen while browsing, so places already looked at
//                 still draw offline. Bounded: oldest out first.
//
// Tiles are cached, not the byte ranges they came from: CacheStorage can't
// keep a partial (206) response, and a tile is what a map offline needs.
// ---------------------------------------------------------------------------

import type { GetResourceResponse, RequestParameters } from "maplibre-gl";

export const TILE_CACHE = "bike-tiles-v1";
export const BROWSE_CACHE = "bike-tiles-browse-v1";

/** Browsed tiles kept. The basemap's z13-14 tiles run 10-100 KB, so this is on
 * the order of 50 MB: a few weeks of looking around one city. */
export const BROWSE_MAX = 1500;

/** Trimming lists every key; doing it once per this many new tiles keeps that
 * off the path of each tile while bounding the overshoot. */
const TRIM_EVERY = 25;

/** The scheme MapLibre is pointed at for basemap tiles. */
export const CACHE_PROTOCOL = "bikecache";

/** The basemap's tile URLs, as MapLibre asks for them. */
export const TILE_TEMPLATE = `${CACHE_PROTOCOL}://basemap/{z}/{x}/{y}.mvt`;

export type TileXYZ = [z: number, x: number, y: number];

/** One tile's bytes out of the basemap, or undefined where it has none (open
 * sea, beyond the region). */
export type ReadTile = (z: number, x: number, y: number, signal?: AbortSignal) => Promise<ArrayBuffer | undefined>;

/** What this module needs from the browser; tests hand in their own. */
export interface CacheDeps {
  /** Null where there is none (only secure contexts have CacheStorage): the
   * map still draws, from the file, and only the offline download can't work. */
  caches: CacheStorage | null;
  readTile: ReadTile;
}

/** The cache key for a tile. Never fetched: CacheStorage keys are URLs, and
 * this one names the tile rather than where its bytes came from, so a tile
 * stays found whether it arrived from the site or from the Android app's copy. */
export function tileKey(z: number, x: number, y: number): string {
  return `https://basemap.tile/${z}/${x}/${y}.mvt`;
}

/** z/x/y from a bikecache:// tile URL, or null for anything else. */
export function parseTileUrl(url: string): TileXYZ | null {
  const m = /^bikecache:\/\/basemap\/(\d+)\/(\d+)\/(\d+)\.mvt$/.exec(url);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Opened once per storage and name: every tile is looked up in two caches,
 * and reopening them each time is a round trip per tile for nothing. */
const opened = new WeakMap<CacheStorage, Map<string, Promise<Cache>>>();

function open(caches: CacheStorage, name: string): Promise<Cache> {
  let byName = opened.get(caches);
  if (byName === undefined) {
    byName = new Map();
    opened.set(caches, byName);
  }
  let cache = byName.get(name);
  if (cache === undefined) {
    cache = caches.open(name);
    // a failed open is not remembered, so the next tile tries again
    cache.catch(() => byName?.delete(name));
    byName.set(name, cache);
  }
  return cache;
}

async function lookup(caches: CacheStorage, key: string, names: string[]): Promise<Response | undefined> {
  for (const name of names) {
    const hit = await (await open(caches, name)).match(key);
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

const tileResponse = (data: ArrayBuffer): Response =>
  new Response(data, { headers: { "content-type": "application/x-protobuf" } });

async function rememberBrowsed(caches: CacheStorage, key: string, data: ArrayBuffer): Promise<void> {
  const cache = await open(caches, BROWSE_CACHE);
  await cache.put(key, tileResponse(data));
  putsSinceTrim++;
  if (putsSinceTrim >= TRIM_EVERY) {
    putsSinceTrim = 0;
    await trimCache(cache, BROWSE_MAX);
  }
}

/**
 * A tile's bytes: from a downloaded route, else from what was browsed, else
 * from the basemap file, stored for next time in the bounded browse cache.
 * A tile the basemap doesn't have is an empty one, which MapLibre draws as
 * nothing, as it should.
 */
export async function cachedTile(
  z: number,
  x: number,
  y: number,
  deps: CacheDeps,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const key = tileKey(z, x, y);
  const store = deps.caches;
  if (store !== null) {
    // A cache that won't open or answer (storage blocked, a quota error, a
    // private window) is a cache with nothing in it, not a map with no tiles:
    // the tile comes from the file instead.
    const hit = await lookup(store, key, [TILE_CACHE, BROWSE_CACHE]).catch(() => undefined);
    if (hit !== undefined) return hit.arrayBuffer();
  }
  const data = (await deps.readTile(z, x, y, signal)) ?? new ArrayBuffer(0);
  // Storing is best effort and must not delay the map, or fail it: a full
  // disk is not a reason to not draw the tile we already have.
  if (store !== null && data.byteLength > 0) {
    void rememberBrowsed(store, key, data.slice(0)).catch(() => undefined);
  }
  return data;
}

/** Carto's tiles and styles, cached before the basemap was ours. Nothing reads
 * them any more, and TILE_CACHE is never trimmed, so they'd stay for good. */
export async function forgetCarto(caches: CacheStorage): Promise<number> {
  let dropped = 0;
  for (const name of [TILE_CACHE, BROWSE_CACHE]) {
    const cache = await open(caches, name);
    for (const req of await cache.keys()) {
      if (/\.cartocdn\.com$/.test(new URL(req.url).hostname)) {
        await cache.delete(req);
        dropped++;
      }
    }
  }
  await caches.delete("bike-styles-v1");
  return dropped;
}

type AddProtocol = (
  name: string,
  fn: (p: RequestParameters, a: AbortController) => Promise<GetResourceResponse<ArrayBuffer>>,
) => void;

let protocolAdded = false;

/**
 * Answer MapLibre's bikecache:// tile requests from the cache and the basemap.
 * Once per page: MapLibre's protocols are global, and every map on the page
 * reads the same file. Must happen before a map asks for its first tile.
 */
export function installTileCache(addProtocol: AddProtocol, deps: CacheDeps): void {
  if (protocolAdded) return;
  protocolAdded = true;
  addProtocol(CACHE_PROTOCOL, async (params, abort) => {
    const t = parseTileUrl(params.url);
    if (t === null) throw new Error(`not a basemap tile: ${params.url}`);
    return { data: await cachedTile(t[0], t[1], t[2], deps, abort.signal) };
  });
  if (deps.caches !== null) void forgetCarto(deps.caches).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// the "⬇ Offline map" download
// ---------------------------------------------------------------------------

function tileXY(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latR = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2) * n);
  return [x, y];
}

/** Metres between two points, near enough for spacing samples. */
function approxM(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = (b[1] - a[1]) * 110_540;
  return Math.hypot(dx, dy);
}

/**
 * The basemap tiles a ride along `line` draws, at each of `zooms`: every tile
 * the line passes through, and at the deepest zoom the ring round it too, for
 * a view a little wider than the road.
 *
 * One tile set serves every basemap theme, so there is nothing to get wrong
 * when a rider flips to night mode halfway through an offline ride. The
 * basemap stops at z14 and MapLibre overzooms it for closer views, so z13-14
 * covers the z13-16 a ride displays.
 *
 * Sampled along each segment, not at its ends: a route's vertices can be far
 * apart on a straight road or a long path, and sampling only where they fell
 * left the tiles in between out of a download that said it was complete.
 */
export function routeTiles(line: [number, number][], zooms: number[]): TileXYZ[] {
  const deepest = Math.max(...zooms);
  const tiles = new Map<string, TileXYZ>();
  const add = (z: number, x: number, y: number): void => {
    tiles.set(`${z}/${x}/${y}`, [z, x, y]);
  };
  for (const z of zooms) {
    const spread = z === deepest ? 1 : 0;
    // a quarter of a tile's width at this zoom, which at this latitude is about
    // 1.8 km at z14 (2.4 km is the width at the equator, which the cosine takes
    // down), so no tile the line crosses is stepped over
    const stepM = (40_075_000 / 2 ** z) * Math.cos((42.4 * Math.PI) / 180) / 4;
    const visit = (p: [number, number]): void => {
      const [x, y] = tileXY(p[0], p[1], z);
      for (let dx = -spread; dx <= spread; dx++) {
        for (let dy = -spread; dy <= spread; dy++) add(z, x + dx, y + dy);
      }
    };
    for (let i = 0; i < line.length; i++) {
      const a = line[i] as [number, number];
      visit(a);
      const b = line[i + 1];
      if (b === undefined) break;
      const steps = Math.floor(approxM(a, b) / stepM);
      for (let k = 1; k <= steps; k++) {
        const t = k / (steps + 1);
        visit([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
  }
  return [...tiles.values()];
}

/** Ask the browser not to evict what is stored here under storage pressure,
 * and on iOS not to wipe it after seven days without a visit. Worth asking at
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
 * Store a route's tiles for offline use, in TILE_CACHE, which is never
 * trimmed. A tile already browsed is copied across rather than read again.
 * The style needs nothing stored: it is built in the page (basemap.ts).
 */
export async function downloadOffline(
  tiles: TileXYZ[],
  onProgress: (done: number, total: number) => void,
  deps: CacheDeps | null,
  nav: Navigator = navigator,
): Promise<DownloadResult> {
  if (deps === null || deps.caches === null) return { stored: 0, failed: tiles.length, persisted: false };
  const persisted = await requestPersistence(nav);
  const pinned = await deps.caches.open(TILE_CACHE);
  const browse = await deps.caches.open(BROWSE_CACHE);
  let stored = 0;
  let failed = 0;
  let done = 0;

  const queue = [...tiles];
  const worker = async (): Promise<void> => {
    for (;;) {
      const t = queue.shift();
      if (t === undefined) return;
      const key = tileKey(...t);
      try {
        if ((await pinned.match(key)) !== undefined) {
          stored++;
        } else {
          const seen = await browse.match(key);
          const data = seen !== undefined ? await seen.arrayBuffer() : await deps.readTile(...t);
          // A tile the basemap has no data for is still "stored": there is
          // nothing to draw there, online or off.
          await pinned.put(key, tileResponse(data ?? new ArrayBuffer(0)));
          stored++;
        }
      } catch {
        failed++; // offline mid-download: skip it
      }
      onProgress(++done, tiles.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { stored, failed, persisted };
}
