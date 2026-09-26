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
  /** Dispatch a fetch; resolves to what the worker answered with, or null if it
   * let the request through to the network untouched. */
  request(
    url: string,
    opts?: { navigate?: boolean; clientId?: string; resultingClientId?: string },
  ): { answered: boolean; response: Promise<Response> | null; lifetime: Promise<unknown[]> };
}

function loadWorker(fetchImpl: FetchFn, caches = new FakeCacheStorage()): Worker {
  const src = readFileSync(join(WEB, "sw.js"), "utf8");
  const listeners: Record<string, Listener> = {};
  const self = {
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
    location: new URL(`${ORIGIN}/sw.js`),
  };
  const names = ["CACHE", "TILE_CACHE", "BROWSE_CACHE", "BROWSE_MAX", "NETWORK_TIMEOUT_MS"];
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
      return { answered: response !== null, response, lifetime: Promise.all(waits) };
    },
  };
}

function body(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
}

/** A fetch that never answers, like a connection with one bar that is not
 * quite dead. */
const hangs: FetchFn = () => new Promise<Response>(() => undefined);

async function seed(w: Worker, url: string, text: string): Promise<void> {
  const shell = String(w.consts["CACHE"]);
  await (await w.caches.open(shell)).put(new URL(url, ORIGIN).toString(), body(text));
}

describe("updating the service worker", () => {
  it("keeps the rider's downloaded maps and drops only old copies of the app", async () => {
    const w = loadWorker(hangs);
    const current = String(w.consts["CACHE"]);
    for (const name of [
      "family-bike-router-v10",
      "family-bike-router-v9",
      current,
      "bike-tiles-v1",
      "bike-tiles-browse-v1",
      "bike-styles-v1",
    ]) {
      await w.caches.open(name);
    }
    await w.activate();
    // Every update used to delete every cache but the shell's own — including
    // the offline maps a rider had downloaded for tomorrow's ride.
    expect((await w.caches.keys()).sort()).toEqual(
      [current, "bike-styles-v1", "bike-tiles-browse-v1", "bike-tiles-v1"].sort(),
    );
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
    const shell = await w.caches.open(String(w.consts["CACHE"]));
    expect(await (await shell.match(`${ORIGIN}/data/meta.json`))?.text()).toBe("new");
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
