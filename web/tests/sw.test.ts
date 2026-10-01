// The service worker, run for real against an in-memory CacheStorage.
//
// sw.js cannot be imported — it registers listeners on `self` at module scope —
// so it is evaluated with the handful of globals it touches handed in, and its
// install/activate/fetch listeners are driven the way a browser would drive
// them. What is asserted is what a rider would see: which caches survive an
// update, what a request is answered with when the network hangs, what ends up
// stored.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCacheStorage } from "./fakecaches.js";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://app.test";

type Listener = (event: unknown) => void;
type FetchFn = (req: Request) => Promise<Response>;

interface Worker {
  caches: FakeCacheStorage;
  consts: Record<string, unknown>;
  activate(): Promise<void>;
  /** Run the install listener; resolves with what it threw, if anything. */
  install(): Promise<unknown>;
  /** Dispatch a fetch; resolves to what the worker answered with, or null if it
   * let the request through to the network untouched. */
  request(
    url: string,
    opts?: { navigate?: boolean; clientId?: string; resultingClientId?: string },
  ): { answered: boolean; response: Promise<Response> | null; lifetime: Promise<unknown[]> };
}

interface Loaded {
  /** The build's and the data's ids, as vite.config.ts writes them in. */
  ids?: { build?: string; data?: string };
}

function loadWorker(fetchImpl: FetchFn, caches = new FakeCacheStorage(), loaded: Loaded = {}): Worker {
  let src = readFileSync(join(WEB, "public", "sw.js"), "utf8");
  if (loaded.ids?.build !== undefined) src = src.replace('/* BUILD_ID */ "dev"', JSON.stringify(loaded.ids.build));
  if (loaded.ids?.data !== undefined) src = src.replace('/* DATA_ID */ "dev"', JSON.stringify(loaded.ids.data));
  const listeners: Record<string, Listener> = {};
  const self = {
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    skipWaiting: () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
    },
    location: new URL(`${ORIGIN}/sw.js`),
  };
  const names = [
    "CACHE",
    "DATA_CACHE",
    "TILE_CACHE",
    "BROWSE_CACHE",
    "BROWSE_MAX",
    "TRIM_EVERY",
    "NETWORK_TIMEOUT_MS",
  ];
  const exportConsts = `return { ${names
    .map((n) => `${n}: typeof ${n} === "undefined" ? undefined : ${n}`)
    .join(", ")} };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const consts = new Function("self", "caches", "fetch", `${src}\n${exportConsts}`)(
    self,
    caches,
    fetchImpl,
  ) as Record<string, unknown>;

  return {
    caches,
    consts,
    async install() {
      let done: Promise<unknown> = Promise.resolve();
      listeners["install"]?.({
        waitUntil: (p: Promise<unknown>) => {
          done = p;
        },
      });
      return done.then(
        () => undefined,
        (err: unknown) => err,
      );
    },
    async activate() {
      let done: Promise<unknown> = Promise.resolve();
      listeners["activate"]?.({
        waitUntil: (p: Promise<unknown>) => {
          done = p;
        },
      });
      await done;
    },
    request(url, opts = {}) {
      const request = new Request(new URL(url, ORIGIN));
      if (opts.navigate === true) Object.defineProperty(request, "mode", { value: "navigate" });
      let response: Promise<Response> | null = null;
      const waits: Promise<unknown>[] = [];
      listeners["fetch"]?.({
        request,
        clientId: opts.clientId ?? "",
        resultingClientId: opts.resultingClientId ?? "",
        respondWith: (p: Promise<Response>) => {
          response = p;
        },
        waitUntil: (p: Promise<unknown>) => {
          waits.push(p);
        },
      });
      // The event's lifetime, as a browser keeps it: until the response has
      // settled and every waitUntil — including ones added after the response,
      // as the worker does once a fetch comes back — has too.
      const answer: Promise<Response> | null = response;
      const lifetime = (async (): Promise<unknown[]> => {
        await Promise.resolve(answer).catch(() => undefined);
        let seen = -1;
        while (seen !== waits.length) {
          seen = waits.length;
          await Promise.all(waits);
        }
        return waits;
      })();
      return { answered: response !== null, response, lifetime };
    },
  };
}

function body(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
}

/** A fetch that never answers, like a connection with one bar that is not
 * quite dead. */
const hangs: FetchFn = () => new Promise<Response>(() => undefined);

/** Put a response where the worker keeps it: the data cache for the site's data,
 * the shell cache for the rest. */
async function seed(w: Worker, url: string, text: string): Promise<void> {
  const name = String(w.consts[url.includes("data/") ? "DATA_CACHE" : "CACHE"]);
  await (await w.caches.open(name)).put(new URL(url, ORIGIN).toString(), body(text));
}

/** A deploy that installed completely and took over: its caches exist, then it
 * activates (what install's addAll does is tested apart; FakeCache fetches with
 * the global fetch, not the worker's). */
async function deployed(store: FakeCacheStorage, build: string, data: string): Promise<Worker> {
  const w = loadWorker(hangs, store, { ids: { build, data } });
  await store.open(String(w.consts["CACHE"]));
  await store.open(String(w.consts["DATA_CACHE"]));
  await w.activate();
  return w;
}

describe("updating the service worker", () => {
  it("keeps the rider's downloaded maps, the data cache, and the last build's shell", async () => {
    const w = loadWorker(hangs);
    const current = String(w.consts["CACHE"]);
    const data = String(w.consts["DATA_CACHE"]);
    // creation order, oldest first: caches.keys() answers in it
    for (const name of [
      "family-bike-router-v10",
      "family-bike-router-v9",
      "family-bike-data-older",
      "bike-tiles-v1",
      "bike-tiles-browse-v1",
      "bike-styles-v1",
      current,
      data,
    ]) {
      await w.caches.open(name);
    }
    await w.activate();
    // Every update used to delete every cache but the shell's own, including
    // the offline maps a rider had downloaded for tomorrow's ride. Now what goes
    // is the shells two builds back and more, and data built another time.
    expect((await w.caches.keys()).sort()).toEqual(
      [
        current,
        data,
        "family-bike-router-v9",
        "bike-cache-order",
        "bike-styles-v1",
        "bike-tiles-browse-v1",
        "bike-tiles-v1",
      ].sort(),
    );
  });

  it("keeps the build a page is still running after a rollback, not whichever was created last", async () => {
    // A, then B, then A again: A's cache is the oldest by creation, but it is the
    // build before C, and the one a page open now is running
    const store = new FakeCacheStorage();
    const live = (build: string): Promise<Worker> => deployed(store, build, "d1");
    await live("A");
    await live("B");
    await live("A");
    const c = await live("C");
    const names = (await c.caches.keys()).filter((k) => k.startsWith("family-bike-router-"));
    expect(names.sort()).toEqual(["family-bike-router-A", "family-bike-router-C"]);
  });

  it("keeps only the current data: another build's tiles don't join this one's", async () => {
    const store = new FakeCacheStorage();
    for (const [build, data] of [["A", "d1"], ["B", "d2"], ["C", "d3"]] as const) {
      await deployed(store, build, data);
    }
    expect((await store.keys()).filter((k) => k.startsWith("family-bike-data-"))).toEqual([
      "family-bike-data-d3",
    ]);
  });

  it("answers a data request from the current data, never another build's", async () => {
    vi.useFakeTimers();
    const store = new FakeCacheStorage();
    const old = await deployed(store, "A", "d1");
    await seed(old, "data/tiles/5_5.json", "the old build's tile");
    const next = await deployed(store, "B", "d2");
    await seed(next, "data/tiles/5_5.json", "the new build's tile");
    const { response } = next.request("data/tiles/5_5.json");
    const done = response?.then((r) => r.text());
    await vi.advanceTimersByTimeAsync(Number(next.consts["NETWORK_TIMEOUT_MS"] ?? 60_000));
    expect(await done).toBe("the new build's tile");
    vi.useRealTimers();
  });

  it("never answers a data request from a shell cache, which may hold data from another build", async () => {
    vi.useFakeTimers();
    const w = loadWorker(hangs);
    // what the shell cache held before the data had a cache of its own
    const previous = await w.caches.open("family-bike-router-previous");
    await previous.put(`${ORIGIN}/data/tiles/9_9.json`, body("a tile of some earlier data"));
    const { response } = w.request("data/tiles/9_9.json");
    let settled = false;
    void response?.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(Number(w.consts["NETWORK_TIMEOUT_MS"] ?? 60_000) * 3);
    // not answered from the old shell: it waits on the network, which hangs
    expect(settled).toBe(false);
    vi.useRealTimers();
  });

  it("keeps the routing tiles a rider has browsed when only the code changed", async () => {
    // A code deploy renames the shell cache and nothing else: the data cache is
    // named by the data, so the tiles of streets the rider has been over are
    // still there to reroute on, with no signal.
    const store = new FakeCacheStorage();
    const was = await deployed(store, "code-1", "same-data");
    await seed(was, "data/tiles/103_76.json", "browsed tile");
    const next = loadWorker(hangs, store, { ids: { build: "code-2", data: "same-data" } });
    expect(next.consts["CACHE"]).not.toBe(was.consts["CACHE"]);
    expect(next.consts["DATA_CACHE"]).toBe(was.consts["DATA_CACHE"]);
    await next.activate();
    const data = await store.open(String(next.consts["DATA_CACHE"]));
    expect(await (await data.match(`${ORIGIN}/data/tiles/103_76.json`))?.text()).toBe("browsed tile");
  });

  it("deletes what a failed install created, so it can't pass for the last build's or displace real data", async () => {
    const store = new FakeCacheStorage();
    vi.stubGlobal("fetch", async () => Promise.reject(new Error("offline")));
    const failing = loadWorker(hangs, store, { ids: { build: "half", data: "dhalf" } });
    const err = await failing.install();
    vi.unstubAllGlobals();
    expect(err).toBeInstanceOf(Error);
    const keys = await store.keys();
    expect(keys).not.toContain("family-bike-router-half");
    expect(keys).not.toContain("family-bike-data-dhalf");
  });

  it("leaves data it didn't create when an install fails: last week's is what the rider has browsed", async () => {
    const store = new FakeCacheStorage();
    const was = await deployed(store, "A", "same");
    await seed(was, "data/tiles/1_1.json", "browsed");
    vi.stubGlobal("fetch", async () => Promise.reject(new Error("offline")));
    const failing = loadWorker(hangs, store, { ids: { build: "B", data: "same" } });
    await failing.install();
    vi.unstubAllGlobals();
    const data = await store.open("family-bike-data-same");
    expect(data.urls()).toEqual([`${ORIGIN}/data/tiles/1_1.json`]);
  });

  it("answers the current build's page, not the previous one's, when both are kept", async () => {
    vi.useFakeTimers();
    const w = loadWorker(hangs);
    const previous = await w.caches.open("family-bike-router-previous");
    await previous.put(`${ORIGIN}/index.html`, body("last build's page"));
    await previous.put(`${ORIGIN}/app-OLD.js`, body("last build's bundle"));
    await seed(w, "index.html", "this build's page");
    // a page still running the last build can still load its own bundles...
    const old = w.request("app-OLD.js");
    void old.response;
    await vi.advanceTimersByTimeAsync(Number(w.consts["NETWORK_TIMEOUT_MS"] ?? 60_000));
    expect(await (await (old.response as Promise<Response>)).text()).toBe("last build's bundle");
    // ...but a request for the page itself gets this build's first
    const page = w.request("index.html", { navigate: true, resultingClientId: "tab" });
    await vi.advanceTimersByTimeAsync(Number(w.consts["NETWORK_TIMEOUT_MS"] ?? 60_000));
    expect(await (await (page.response as Promise<Response>)).text()).toBe("this build's page");
    vi.useRealTimers();
  });

  it("keeps what it fetches in the cache it belongs to: data apart from the shell", async () => {
    const w = loadWorker(async (req) => body(`from the network: ${new URL(req.url).pathname}`));
    for (const path of ["data/tiles/1_1.json", "data/nettiles/2_2.json", "app.js"]) {
      const { response, lifetime } = w.request(path);
      await response;
      await lifetime;
    }
    const shell = await w.caches.open(String(w.consts["CACHE"]));
    const data = await w.caches.open(String(w.consts["DATA_CACHE"]));
    expect(shell.urls()).toEqual([`${ORIGIN}/app.js`]);
    expect(data.urls().sort()).toEqual([`${ORIGIN}/data/nettiles/2_2.json`, `${ORIGIN}/data/tiles/1_1.json`]);
  });
});

describe("a connection that is barely there", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a routing tile from cache instead of waiting on a hung request", async () => {
    // Mid-ride reroutes fetch data/tiles/*.json through here. With no timeout
    // a request that neither answers nor fails stalled the reroute until the
    // browser gave up on it, with the tile sitting in the cache all along.
    const w = loadWorker(hangs);
    await seed(w, "data/tiles/103_76.json", "cached tile");
    const { response } = w.request("data/tiles/103_76.json");
    let settled: Response | undefined;
    void response?.then((r) => {
      settled = r;
    });
    await vi.advanceTimersByTimeAsync(Number(w.consts["NETWORK_TIMEOUT_MS"] ?? 60_000));
    expect(settled, "still waiting on the network").toBeDefined();
    expect(await settled?.text()).toBe("cached tile");
  });

  it("answers the page itself from cache rather than leaving it blank", async () => {
    const w = loadWorker(hangs);
    await seed(w, "index.html", "cached page");
    const { response } = w.request("index.html", { navigate: true, resultingClientId: "tab" });
    let settled: Response | undefined;
    void response?.then((r) => {
      settled = r;
    });
    await vi.advanceTimersByTimeAsync(Number(w.consts["NETWORK_TIMEOUT_MS"] ?? 60_000));
    expect(await settled?.text()).toBe("cached page");
  });

  it("still prefers a slow network to the cache, and refreshes the cache from it", async () => {
    // Never a stale shell while the network is answering at all: a response
    // that arrives inside the window wins.
    const w = loadWorker(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(body("fresh")), 1500)),
    );
    await seed(w, "app.js", "stale");
    const { response, lifetime } = w.request("app.js");
    await vi.advanceTimersByTimeAsync(1500);
    expect(await (await (response as Promise<Response>)).text()).toBe("fresh");
    await lifetime;
    const shell = await w.caches.open(String(w.consts["CACHE"]));
    expect(await (await shell.match(`${ORIGIN}/app.js`))?.text()).toBe("fresh");
  });

  it("waits for the network when there is nothing cached to fall back on", async () => {
    const w = loadWorker(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(body("late")), 20_000)),
    );
    const { response } = w.request("data/tiles/1_1.json");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await (await (response as Promise<Response>)).text()).toBe("late");
  });

  it("keeps the network's answer for next time even after answering from cache", async () => {
    const w = loadWorker(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(body("new")), 20_000)),
    );
    await seed(w, "data/meta.json", "old");
    const { response, lifetime } = w.request("data/meta.json");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await (await (response as Promise<Response>)).text()).toBe("old");
    await lifetime;
    const data = await w.caches.open(String(w.consts["DATA_CACHE"]));
    expect(await (await data.match(`${ORIGIN}/data/meta.json`))?.text()).toBe("new");
  });

  it("serves a page that fell back to cache the rest of the same build", async () => {
    // Once the page has come from cache, its modules must too: a cached
    // index.html running a newer app.js, or the reverse, is a mismatched pair
    // of builds, which is a broken app rather than a slightly old one.
    let calls = 0;
    const w = loadWorker((req) => {
      calls++;
      return req.url.endsWith("index.html") ? hangs(req) : Promise.resolve(body("new module"));
    });
    await seed(w, "index.html", "old page");
    await seed(w, "app.js", "old module");
    const page = w.request("index.html", { navigate: true, resultingClientId: "tab-1" });
    await vi.advanceTimersByTimeAsync(Number(w.consts["NETWORK_TIMEOUT_MS"] ?? 60_000));
    expect(await (await (page.response as Promise<Response>)).text()).toBe("old page");

    const sameTab = w.request("app.js", { clientId: "tab-1" });
    expect(await (await (sameTab.response as Promise<Response>)).text()).toBe("old module");
    // ...while a tab whose page came off the network gets the network's module
    const otherTab = w.request("app.js", { clientId: "tab-2" });
    expect(await (await (otherTab.response as Promise<Response>)).text()).toBe("new module");
    expect(calls).toBeGreaterThan(0);
  });
});

describe("a page the network answered after all", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not marked as running from the cache", async () => {
    // At the timeout the worker reads the cache, which takes a moment. If the
    // network answers inside that moment, the page runs what the network sent,
    // and marking it stale answered the rest of its session from the cache:
    // a new page running old modules.
    let arrive: (r: Response) => void = () => undefined;
    const w = loadWorker((req) =>
      req.url.endsWith("index.html")
        ? new Promise<Response>((resolve) => {
            arrive = resolve;
          })
        : Promise.resolve(body("new module")),
    );
    await seed(w, "index.html", "old page");
    await seed(w, "app.js", "old module");
    // the cache is slow to answer: the network wins the race by a hair
    const realMatch = w.caches.match.bind(w.caches);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    w.caches.match = async (req: RequestInfo | URL) => {
      await gate;
      return realMatch(req);
    };
    // the worker reads the current build's caches by name first, so they are slow too
    const realOpen = w.caches.open.bind(w.caches);
    w.caches.open = async (name: string) => {
      const cache = await realOpen(name);
      const match = cache.match.bind(cache);
      cache.match = async (req: RequestInfo | URL) => {
        await gate;
        return match(req);
      };
      return cache;
    };
    const page = w.request("index.html", { navigate: true, resultingClientId: "tab-1" });
    await vi.advanceTimersByTimeAsync(Number(w.consts["NETWORK_TIMEOUT_MS"] ?? 60_000));
    arrive(body("new page"));
    expect(await (await (page.response as Promise<Response>)).text()).toBe("new page");
    release();
    await vi.advanceTimersByTimeAsync(10);
    w.caches.match = realMatch;
    w.caches.open = realOpen;
    const module = w.request("app.js", { clientId: "tab-1" });
    expect(await (await (module.response as Promise<Response>)).text()).toBe("new module");
  });
});

describe("the shell cache", () => {
  it("is named by the build, so each deploy replaces the last", () => {
    // A fixed name kept every build's hashed bundles in one cache forever
    const src = readFileSync(join(WEB, "public", "sw.js"), "utf8");
    expect(src).toContain('const CACHE = "family-bike-router-" + /* BUILD_ID */ "dev";');
    const vite = readFileSync(join(WEB, "vite.config.ts"), "utf8");
    expect(vite).toContain('/* BUILD_ID */ "dev"');
  });

  it("and the data cache by the data, written in by the same build", () => {
    const src = readFileSync(join(WEB, "public", "sw.js"), "utf8");
    expect(src).toContain('const DATA_CACHE = "family-bike-data-" + /* DATA_ID */ "dev";');
    const vite = readFileSync(join(WEB, "vite.config.ts"), "utf8");
    expect(vite).toContain('/* DATA_ID */ "dev"');
    // the shell's name is made from the code alone: if it hashed the data too, a
    // data deploy would rename it as well, and a code deploy needs no data
    const plugin = vite.slice(vite.indexOf("function precache"), vite.indexOf("function noMapLibreTags"));
    const hashPart = plugin.slice(plugin.indexOf("const hash = createHash"), plugin.indexOf("const id = hash.digest"));
    expect(hashPart).not.toContain("meta");
  });
});

describe("map resources", () => {
  const BASEMAP = `${ORIGIN}/basemap.pmtiles`;
  const AERIAL = "https://tiles.arcgis.com/tiles/x/arcgis/rest/services/o/MapServer/tile/14/6057/";
  // a downloaded route's tile, keyed as the page keys it (tilecache.ts)
  const ROUTE_TILE = "https://basemap.tile/14/4956/6057.mvt";

  it("leaves the basemap file to the page, which caches its tiles itself", () => {
    // The page reads basemap.pmtiles by byte range and caches the tiles it
    // gets (tilecache.ts), in the web app and in the Android app where there is
    // no worker at all. A cache can't keep a partial response, and a detour
    // through the worker would only slow every tile.
    const w = loadWorker(hangs);
    expect(w.request(BASEMAP).answered).toBe(false);
  });

  it("does not store an opaque response it cannot read back", async () => {
    const opaque = {
      type: "opaque",
      ok: false,
      status: 0,
      headers: new Headers(),
      clone() {
        return this;
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
    const w = loadWorker(async () => opaque);
    const { response, lifetime } = w.request(`${AERIAL}1`);
    await response;
    await lifetime;
    for (const name of await w.caches.keys()) {
      expect((await w.caches.open(name)).urls(), `${name} kept an opaque body`).toEqual([]);
    }
  });

  it("bounds what it caches while browsing, and never touches a downloaded route", async () => {
    const w = loadWorker(async () => body("tile"));
    const max = Number(w.consts["BROWSE_MAX"]);
    expect(max, "no browse cache bound").toBeGreaterThan(0);
    const pinned = await w.caches.open(String(w.consts["TILE_CACHE"]));
    await pinned.put(ROUTE_TILE, body("route"));
    for (let i = 0; i < max + 60; i++) {
      const { response, lifetime } = w.request(`${AERIAL}${i}`);
      await response;
      await lifetime;
    }
    const browse = await w.caches.open(String(w.consts["BROWSE_CACHE"]));
    // Trimmed in batches rather than on every put, so it may overshoot by
    // less than one batch — and no more.
    expect(browse.urls().length).toBeLessThan(max + Number(w.consts["TRIM_EVERY"] ?? 1));
    // oldest out first
    expect(browse.urls()).not.toContain(`${AERIAL}0`);
    expect(browse.urls()).toContain(`${AERIAL}${max + 59}`);
    expect(pinned.urls()).toEqual([ROUTE_TILE]);
  });

  it("answers from a downloaded route before going to the network", async () => {
    let calls = 0;
    const w = loadWorker(async () => {
      calls++;
      return body("network");
    });
    const pinned = await w.caches.open(String(w.consts["TILE_CACHE"]));
    await pinned.put(`${AERIAL}7`, body("downloaded"));
    const { response } = w.request(`${AERIAL}7`);
    expect(await (await (response as Promise<Response>)).text()).toBe("downloaded");
    expect(calls).toBe(0);
  });
});
