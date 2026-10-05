// The page's own tile cache: what makes a downloaded route draw with no signal,
// in the web app and in the Android app, which has no service worker. Tiles come
// out of the basemap file (basemap.pmtiles) through an injected reader, so these
// tests say exactly which tiles exist and when the file can't be reached.
import { describe, expect, it, vi } from "vitest";

import {
  BROWSE_CACHE,
  BROWSE_MAX,
  CACHE_PROTOCOL,
  cachedTile,
  downloadOffline,
  forgetCarto,
  installTileCache,
  parseTileUrl,
  routeTiles,
  TILE_CACHE,
  TILE_TEMPLATE,
  tileKey,
  type CacheDeps,
  type TileXYZ,
} from "../src/tilecache.js";
import { FakeCacheStorage } from "./fakecaches.js";

const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const decode = (buf: ArrayBuffer): string => new TextDecoder().decode(buf);
const tileResponse = (text: string): Response => new Response(bytes(text));

/** Stored puts are fire-and-forget; let them land. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** A basemap whose tiles are "z/x/y" as text, except any `missing`, and a
 * reader that can be taken offline. */
function basemap(missing: string[] = []): {
  deps: CacheDeps;
  store: FakeCacheStorage;
  asked: string[];
  offline: () => void;
} {
  const store = new FakeCacheStorage();
  const asked: string[] = [];
  let online = true;
  return {
    store,
    asked,
    offline: () => {
      online = false;
    },
    deps: {
      caches: store.asCacheStorage,
      readTile: async (z, x, y) => {
        const id = `${z}/${x}/${y}`;
        asked.push(id);
        if (!online) throw new TypeError("Failed to fetch");
        return missing.includes(id) ? undefined : bytes(id);
      },
    },
  };
}

describe("tile addresses", () => {
  it("reads z/x/y from the URLs MapLibre asks for, and nothing else", () => {
    expect(TILE_TEMPLATE.startsWith(`${CACHE_PROTOCOL}://`)).toBe(true);
    expect(parseTileUrl("bikecache://basemap/14/4956/6057.mvt")).toEqual([14, 4956, 6057]);
    expect(parseTileUrl("https://example.test/14/4956/6057.mvt")).toBeNull();
    expect(parseTileUrl("bikecache://basemap/14/x/6057.mvt")).toBeNull();
  });

  it("keys a tile by what it is, not where its bytes came from", () => {
    expect(tileKey(14, 4956, 6057)).toBe("https://basemap.tile/14/4956/6057.mvt");
  });
});

describe("reading a tile", () => {
  it("serves a downloaded tile with the file out of reach", async () => {
    const b = basemap();
    await (await b.store.open(TILE_CACHE)).put(tileKey(14, 1, 2), tileResponse("route"));
    b.offline();
    expect(decode(await cachedTile(14, 1, 2, b.deps))).toBe("route");
    expect(b.asked).toEqual([]);
  });

  it("reads the file once, and keeps what it gets for next time", async () => {
    const b = basemap();
    expect(decode(await cachedTile(14, 3, 4, b.deps))).toBe("14/3/4");
    await settle();
    expect(decode(await cachedTile(14, 3, 4, b.deps))).toBe("14/3/4");
    expect(b.asked).toEqual(["14/3/4"]);
    expect((await b.store.open(BROWSE_CACHE)).urls()).toEqual([tileKey(14, 3, 4)]);
  });

  it("draws a tile the basemap has no data for as empty, and doesn't keep it", async () => {
    // open sea, or beyond the region: nothing to draw, not a failure
    const b = basemap(["14/9/9"]);
    expect((await cachedTile(14, 9, 9, b.deps)).byteLength).toBe(0);
    await settle();
    expect((await b.store.open(BROWSE_CACHE)).urls()).toEqual([]);
  });

  it("lets a failure to reach the file through, so MapLibre retries it", async () => {
    const b = basemap();
    b.offline();
    await expect(cachedTile(14, 5, 5, b.deps)).rejects.toThrow("Failed to fetch");
  });

  it("keeps browsing bounded, oldest out first, and never evicts a download", async () => {
    const b = basemap();
    const pinned = await b.store.open(TILE_CACHE);
    await pinned.put(tileKey(13, 99, 1), tileResponse("route"));
    for (let x = 0; x < BROWSE_MAX + 60; x++) {
      await cachedTile(14, x, 0, b.deps);
      await settle();
    }
    const browse = (await b.store.open(BROWSE_CACHE)).urls();
    expect(browse.length).toBeLessThan(BROWSE_MAX + 30);
    expect(browse).not.toContain(tileKey(14, 0, 0));
    expect(browse).toContain(tileKey(14, BROWSE_MAX + 59, 0));
    expect(pinned.urls()).toEqual([tileKey(13, 99, 1)]);
  });
});

describe("with no cache to be had", () => {
  it("still draws the map, from the file", async () => {
    // CacheStorage exists only in secure contexts: the protocol used not to be
    // installed at all without it, and the page drew no basemap
    const b = basemap();
    expect(decode(await cachedTile(14, 3, 4, { caches: null, readTile: b.deps.readTile }))).toBe("14/3/4");
  });

  it("still draws the map when the cache refuses to open", async () => {
    // storage blocked, or a quota error: a cache with nothing in it, not a map
    // with no tiles
    const b = basemap();
    const broken = {
      open: async () => {
        throw new DOMException("blocked", "SecurityError");
      },
    } as unknown as CacheStorage;
    expect(decode(await cachedTile(14, 5, 6, { caches: broken, readTile: b.deps.readTile }))).toBe("14/5/6");
  });

  it("can't download a route offline, and says so", async () => {
    const b = basemap();
    const deps = { caches: null, readTile: b.deps.readTile };
    const result = await downloadOffline([[14, 1, 1]], () => undefined, deps);
    expect(result).toEqual({ stored: 0, failed: 1, persisted: false });
  });
});

describe("the offline download", () => {
  const nav = (persist: () => Promise<boolean>): Navigator =>
    ({ storage: { persist } }) as unknown as Navigator;

  it("stores the route's tiles and asks for storage that lasts", async () => {
    const b = basemap();
    const persist = vi.fn(async () => true);
    const progress: number[] = [];
    const tiles: TileXYZ[] = [
      [13, 1, 1],
      [14, 2, 2],
      [14, 3, 3],
    ];
    const result = await downloadOffline(tiles, (done) => progress.push(done), b.deps, nav(persist));
    expect(result).toEqual({ stored: 3, failed: 0, persisted: true });
    // Without this a browser under storage pressure, or Safari after seven
    // days without a visit, may wipe the download before the ride.
    expect(persist).toHaveBeenCalledOnce();
    expect((await b.store.open(TILE_CACHE)).urls().sort()).toEqual(tiles.map((t) => tileKey(...t)).sort());
    expect(progress[progress.length - 1]).toBe(tiles.length);
  });

  it("copies a tile already browsed instead of reading it again", async () => {
    const b = basemap();
    await (await b.store.open(BROWSE_CACHE)).put(tileKey(14, 5, 5), tileResponse("browsed"));
    await downloadOffline([[14, 5, 5]], () => undefined, b.deps, nav(async () => false));
    expect(b.asked).toEqual([]);
    const hit = await (await b.store.open(TILE_CACHE)).match(tileKey(14, 5, 5));
    expect(await hit?.text()).toBe("browsed");
  });

  it("counts what did not arrive rather than calling the route ready", async () => {
    const b = basemap();
    b.offline();
    const result = await downloadOffline(
      [
        [13, 1, 1],
        [14, 1, 1],
      ],
      () => undefined,
      b.deps,
      nav(async () => {
        throw new Error("not allowed");
      }),
    );
    expect(result).toEqual({ stored: 0, failed: 2, persisted: false });
  });

  it("stores a tile the basemap has no data for, so a ride there isn't 'missing' it", async () => {
    const b = basemap(["14/7/7"]);
    const result = await downloadOffline([[14, 7, 7]], () => undefined, b.deps, nav(async () => true));
    expect(result.stored).toBe(1);
    expect((await b.store.open(TILE_CACHE)).urls()).toEqual([tileKey(14, 7, 7)]);
  });

  it("does nothing, and says so, where there's no cache to store in", async () => {
    const result = await downloadOffline([[14, 1, 1]], () => undefined, null, nav(async () => true));
    expect(result).toEqual({ stored: 0, failed: 1, persisted: false });
  });
});

describe("what Carto left behind", () => {
  it("is cleared: its tiles, never read again, and its styles", async () => {
    const b = basemap();
    const pinned = await b.store.open(TILE_CACHE);
    await pinned.put("https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/14/1/1.mvt", tileResponse("old"));
    await pinned.put(tileKey(14, 1, 1), tileResponse("new"));
    // aerial imagery shares the cache and stays
    await pinned.put("https://tiles.arcgis.com/tiles/x/tile/14/1/1", tileResponse("photo"));
    await (await b.store.open("bike-styles-v1")).put("https://basemaps.cartocdn.com/style.json", tileResponse("{}"));
    expect(await forgetCarto(b.store.asCacheStorage)).toBe(1);
    expect(pinned.urls().sort()).toEqual([tileKey(14, 1, 1), "https://tiles.arcgis.com/tiles/x/tile/14/1/1"].sort());
    expect(await b.store.has("bike-styles-v1")).toBe(false);
  });
});

describe("wiring it into MapLibre", () => {
  it("answers basemap tiles from the cache and the file, once per page", async () => {
    const b = basemap();
    const handlers: ((p: { url: string }, a: AbortController) => Promise<{ data: ArrayBuffer }>)[] = [];
    const addProtocol = vi.fn((_name: string, fn: (typeof handlers)[number]) => {
      handlers.push(fn);
    });
    installTileCache(addProtocol as unknown as Parameters<typeof installTileCache>[0], b.deps);
    installTileCache(addProtocol as unknown as Parameters<typeof installTileCache>[0], b.deps);
    expect(addProtocol).toHaveBeenCalledOnce();
    expect(addProtocol.mock.calls[0]?.[0]).toBe(CACHE_PROTOCOL);
    const handler = handlers[0];
    if (handler === undefined) throw new Error("no handler");
    const { data } = await handler({ url: "bikecache://basemap/14/8/9.mvt" }, new AbortController());
    expect(decode(data)).toBe("14/8/9");
    await expect(handler({ url: "bikecache://elsewhere/1" }, new AbortController())).rejects.toThrow(
      "not a basemap tile",
    );
  });
});

describe("wiring it into MapLibre, with a cache that cannot be cleaned", () => {
  it("still installs, and ignores the failure to forget the old cache", async () => {
    // installing is once per page, and an earlier test has: a copy of the module of its own
    vi.resetModules();
    const fresh = await import("../src/tilecache.js");
    const addProtocol = vi.fn();
    const caches = { keys: () => Promise.reject(new Error("SecurityError")) } as unknown as CacheStorage;
    fresh.installTileCache(addProtocol as unknown as Parameters<typeof installTileCache>[0], {
      caches,
      readTile: async () => undefined,
    });
    expect(addProtocol).toHaveBeenCalledOnce();
    // an unhandled rejection here fails the run
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("which tiles a route needs offline", () => {
  const tileX = (lon: number, z: number): number => Math.floor(((lon + 180) / 360) * 2 ** z);

  it("covers a long straight stretch between two far-apart points, all of it", () => {
    // 20 km due east with no vertex in between, like a long path: sampling only
    // at the vertices left every tile in the middle out of the download
    const west = -71.35;
    const east = -71.1; // about 20 km at this latitude
    const tiles = routeTiles(
      [
        [west, 42.4],
        [east, 42.4],
      ],
      [13, 14],
    );
    for (const z of [13, 14]) {
      const xs = new Set(tiles.filter(([tz]) => tz === z).map(([, x]) => x));
      for (let x = tileX(west, z); x <= tileX(east, z); x++) expect(xs.has(x), `z${z} x${x}`).toBe(true);
    }
  });

  it("takes the ring round the line at the deepest zoom only", () => {
    const tiles = routeTiles([[-71.1, 42.4]], [13, 14]);
    expect(tiles.filter(([z]) => z === 14)).toHaveLength(9);
    expect(tiles.filter(([z]) => z === 13)).toHaveLength(1);
  });

  it("lists each tile once", () => {
    const line: [number, number][] = Array.from({ length: 200 }, (_v, i) => [-71.1 + i * 0.0001, 42.4]);
    const tiles = routeTiles(line, [13, 14]);
    expect(new Set(tiles.map((t) => t.join("/"))).size).toBe(tiles.length);
  });
});
