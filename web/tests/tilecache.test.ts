// The page's own tile cache: what makes a downloaded route draw with no signal,
// in the web app and in the Android app, which has no service worker.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSE_CACHE,
  BROWSE_MAX,
  CACHE_PROTOCOL,
  STYLE_CACHE,
  STYLE_TIMEOUT_MS,
  TILE_CACHE,
  TileHttpError,
  cachedStyle,
  cachedTile,
  downloadOffline,
  installTileCache,
  type CacheDeps,
} from "../src/tilecache.js";
import { FakeCacheStorage } from "./fakecaches.js";

const tile = (host: string, z: number, x: number, y = 6057): string =>
  `https://${host}.basemaps.cartocdn.com/vectortiles/carto.streets/v1/${z}/${x}/${y}.mvt`;

function bytes(text: string): Response {
  return new Response(new TextEncoder().encode(text), {
    headers: { "content-type": "application/x-protobuf" },
  });
}

const decode = (buf: ArrayBuffer): string => new TextDecoder().decode(buf);

/** Stored puts are fire-and-forget; let them land. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

function deps(fetchImpl: (url: string) => Promise<Response>): {
  deps: CacheDeps;
  store: FakeCacheStorage;
  asked: string[];
} {
  const store = new FakeCacheStorage();
  const asked: string[] = [];
  return {
    store,
    asked,
    deps: {
      caches: store.asCacheStorage,
      fetch: ((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        asked.push(url);
        return fetchImpl(url);
      }) as typeof fetch,
    },
  };
}

const offline = (): Promise<Response> => Promise.reject(new TypeError("Failed to fetch"));

describe("reading a tile", () => {
  it("serves a downloaded tile with no network, whichever host MapLibre asks", async () => {
    const d = deps(offline);
    await (await d.store.open(TILE_CACHE)).put(tile("tiles-a", 14, 4956), bytes("downloaded"));
    for (const host of ["tiles-a", "tiles-b", "tiles-c", "tiles-d"]) {
      expect(decode(await cachedTile(tile(host, 14, 4956), undefined, d.deps))).toBe("downloaded");
    }
    expect(d.asked).toEqual([]);
  });

  it("goes to the host asked for, and keeps what it gets for next time", async () => {
    const d = deps(async () => bytes("fresh"));
    expect(decode(await cachedTile(tile("tiles-c", 14, 1), undefined, d.deps))).toBe("fresh");
    // Carto's four hosts exist to spread load; the canonical one is only a key.
    expect(d.asked).toEqual([tile("tiles-c", 14, 1)]);
    await settle();
    expect((await d.store.open(BROWSE_CACHE)).urls()).toEqual([tile("tiles-a", 14, 1)]);
    // browsed, not downloaded: a route download is the rider's, and only theirs
    expect((await d.store.open(TILE_CACHE)).urls()).toEqual([]);
    // ...and it is served from there next time
    const again = deps(offline);
    again.store.store.set(BROWSE_CACHE, await d.store.open(BROWSE_CACHE));
    expect(decode(await cachedTile(tile("tiles-b", 14, 1), undefined, again.deps))).toBe("fresh");
  });

  it("never stores a refusal as a tile, and reports its status", async () => {
    const d = deps(async () => new Response("nope", { status: 404, statusText: "Not Found" }));
    const err = await cachedTile(tile("tiles-b", 14, 2), undefined, d.deps).catch((e: unknown) => e);
    // MapLibre draws a 404 vector tile as empty rather than as a failure, and
    // tells them apart by this status.
    expect(err).toBeInstanceOf(TileHttpError);
    expect((err as TileHttpError).status).toBe(404);
    await settle();
    for (const name of await d.store.keys()) {
      expect((await d.store.open(name)).urls()).toEqual([]);
    }
  });

  it("keeps browsing bounded, oldest out first, and never evicts a download", async () => {
    // Every browsed tile used to be kept forever, with no ceiling.
    let n = 0;
    const d = deps(async () => bytes(`t${n++}`));
    const pinned = await d.store.open(TILE_CACHE);
    await pinned.put(tile("tiles-a", 13, 99), bytes("route"));
    for (let x = 0; x < BROWSE_MAX + 60; x++) {
      await cachedTile(tile("tiles-b", 14, x), undefined, d.deps);
      await settle();
    }
    const browse = (await d.store.open(BROWSE_CACHE)).urls();
    expect(browse.length).toBeLessThan(BROWSE_MAX + 30);
    expect(browse).not.toContain(tile("tiles-a", 14, 0));
    expect(browse).toContain(tile("tiles-a", 14, BROWSE_MAX + 59));
    expect(pinned.urls()).toEqual([tile("tiles-a", 13, 99)]);
  });
});

describe("the offline download", () => {
  const STYLES = [
    "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  ];
  const nav = (persist: () => Promise<boolean>): Navigator =>
    ({ storage: { persist } }) as unknown as Navigator;

  it("stores the route's tiles, both styles, and asks for storage that lasts", async () => {
    const d = deps(async (url) => (url.endsWith(".json") ? new Response('{"layers":[]}') : bytes(url)));
    const persist = vi.fn(async () => true);
    const progress: number[] = [];
    const urls = [tile("tiles-a", 13, 1), tile("tiles-a", 14, 2), tile("tiles-a", 14, 3)];
    const result = await downloadOffline(urls, STYLES, (done) => progress.push(done), d.deps, nav(persist));

    expect(result).toEqual({ stored: 3, failed: 0, persisted: true });
    // Without this a browser under storage pressure — or Safari after seven
    // days without a visit — may wipe the download before the ride.
    expect(persist).toHaveBeenCalledOnce();
    expect((await d.store.open(TILE_CACHE)).urls().sort()).toEqual([...urls].sort());
    // A cold start with no signal needs a style to paint the tiles with.
    expect((await d.store.open(STYLE_CACHE)).urls().sort()).toEqual([...STYLES].sort());
    expect(progress[progress.length - 1]).toBe(urls.length + STYLES.length);
  });

  it("copies a tile already browsed instead of fetching it again", async () => {
    const d = deps(async () => bytes("network"));
    await (await d.store.open(BROWSE_CACHE)).put(tile("tiles-a", 14, 5), bytes("browsed"));
    await downloadOffline([tile("tiles-a", 14, 5)], [], () => undefined, d.deps, nav(async () => false));
    expect(d.asked).toEqual([]);
    const hit = await (await d.store.open(TILE_CACHE)).match(tile("tiles-a", 14, 5));
    expect(await hit?.text()).toBe("browsed");
  });

  it("counts what did not arrive rather than calling the route ready", async () => {
    const d = deps(async (url) =>
      url.includes("/14/") ? new Response("", { status: 503 }) : bytes("ok"),
    );
    const result = await downloadOffline(
      [tile("tiles-a", 13, 1), tile("tiles-a", 14, 1)],
      [],
      () => undefined,
      d.deps,
      nav(async () => {
        throw new Error("not allowed");
      }),
    );
    expect(result).toEqual({ stored: 1, failed: 1, persisted: false });
    expect((await d.store.open(TILE_CACHE)).urls()).toEqual([tile("tiles-a", 13, 1)]);
  });
});

describe("the basemap style", () => {
  const URL_ = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("comes from the network when it answers, and is kept for a cold start offline", async () => {
    const d = deps(async () => new Response('{"version":8,"from":"network"}'));
    expect(await cachedStyle<{ from: string }>(URL_, d.deps)).toMatchObject({ from: "network" });
    await vi.runAllTimersAsync();
    const kept = await (await d.store.open(STYLE_CACHE)).match(URL_);
    expect(await kept?.json()).toMatchObject({ from: "network" });
  });

  it("comes from the cache with no network", async () => {
    const d = deps(offline);
    await (await d.store.open(STYLE_CACHE)).put(URL_, new Response('{"from":"cache"}'));
    expect(await cachedStyle<{ from: string }>(URL_, d.deps)).toMatchObject({ from: "cache" });
  });

  it("finds the copy the service worker used to keep with the tiles", async () => {
    const d = deps(offline);
    await (await d.store.open(TILE_CACHE)).put(URL_, new Response('{"from":"old worker"}'));
    expect(await cachedStyle<{ from: string }>(URL_, d.deps)).toMatchObject({ from: "old worker" });
  });

  it("comes from the cache when the network hangs", async () => {
    const d = deps(() => new Promise<Response>(() => undefined));
    await (await d.store.open(STYLE_CACHE)).put(URL_, new Response('{"from":"cache"}'));
    const style = cachedStyle<{ from: string }>(URL_, d.deps);
    await vi.advanceTimersByTimeAsync(STYLE_TIMEOUT_MS);
    expect(await style).toMatchObject({ from: "cache" });
  });

  it("fails, so the caller can retry, when there is neither", async () => {
    const d = deps(offline);
    await expect(cachedStyle(URL_, d.deps)).rejects.toThrow();
  });
});

describe("wiring it into MapLibre", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes Carto's vector tiles, and nothing else, through the cache", async () => {
    const store = new FakeCacheStorage();
    vi.stubGlobal("caches", store.asCacheStorage);
    await (await store.open(TILE_CACHE)).put(tile("tiles-a", 14, 7), bytes("offline"));
    let transform: ((url: string, type?: string) => { url: string } | undefined) | undefined;
    const protocols = new Map<string, (p: { url: string }, a: AbortController) => Promise<{ data: ArrayBuffer }>>();
    installTileCache(
      {
        setTransformRequest: (fn: unknown) => {
          transform = fn as typeof transform;
          return undefined as never;
        },
      },
      (name, fn) => protocols.set(name, fn as never),
    );

    const rewritten = transform?.(tile("tiles-d", 14, 7), "Tile");
    expect(rewritten?.url.startsWith(`${CACHE_PROTOCOL}://`)).toBe(true);
    // styles, glyphs, sprites and our own data keep going where they went
    expect(transform?.("https://basemaps.cartocdn.com/gl/positron-gl-style/style.json", "Style")).toBeUndefined();
    expect(transform?.("fonts/glyphs/Noto Sans Regular/0-255.pbf", "Glyphs")).toBeUndefined();
    expect(transform?.("https://tiles.arcgis.com/tiles/x/14/1/2", "Tile")).toBeUndefined();

    const load = protocols.get(CACHE_PROTOCOL);
    const got = await load?.({ url: rewritten?.url ?? "" }, new AbortController());
    expect(decode(got?.data ?? new ArrayBuffer(0))).toBe("offline");
  });
});
