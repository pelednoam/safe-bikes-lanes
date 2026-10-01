// Routing as the page gets it: through the worker's message channel (rpc.ts),
// on the pinned test data (npm run test-data). The worker itself is a
// three-line shell around createRoutingApi, so a MessageChannel stands in for it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { type DataSource, SiteTileMissing } from "../src/data.js";
import { createRoutingApi, type RoutingApi, type WirePrefs } from "../src/routing.js";
import {
  type Endpoint,
  expose,
  type FallibleEndpoint,
  type Remote,
  WORKER_FAILED,
  wrap,
} from "../src/rpc.js";
import { getUnits, setUnits } from "../src/units.js";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "test-data", "data");
const haveData = existsSync(join(DATA, "tiles", "manifest.json"));
// Skipped only on a machine that hasn't fetched the pinned data (npm run
// test-data). CI fetches it before the unit tests, so there a missing dataset
// is a failure, not a quiet skip of the only tests that route through the worker.
const skipRouting = !haveData && process.env["CI"] === undefined;

/** A worker, minus the thread: both ends of a channel in this one. */
function channel<T extends object>(api: T): Remote<T> {
  const { port1, port2 } = new MessageChannel();
  const ep = (port: MessagePort): Endpoint => ({
    postMessage: (m) => port.postMessage(m),
    addEventListener: (type, l) => port.addEventListener(type, l),
  });
  expose(api, ep(port1));
  const remote = wrap<T>(ep(port2));
  port1.start();
  port2.start();
  return remote;
}

describe("calling across the channel", () => {
  const api = {
    add: (a: number, b: number) => a + b,
    later: async (x: string) => `${x}!`,
    fail: () => {
      throw new Error("start and end snap to the same intersection");
    },
    count: (n: number, onEach: (i: number) => void) => {
      for (let i = 0; i < n; i++) onEach(i);
      return n;
    },
    shapes: () => ({ m: new Map([[1, 2]]), s: new Set(["a"]), a: new Float64Array([1.5]) }),
  };
  const remote = channel(api);

  it("returns what the method returns, awaited", async () => {
    expect(await remote.add(2, 3)).toBe(5);
    expect(await remote.later("go")).toBe("go!");
  });

  it("rejects with the method's own words, which the page shows", async () => {
    await expect(remote.fail()).rejects.toThrow("start and end snap to the same intersection");
  });

  it("calls a function argument back here, before the answer", async () => {
    const seen: number[] = [];
    expect(await remote.count(3, (i) => seen.push(i))).toBe(3);
    expect(seen).toEqual([0, 1, 2]);
  });

  it("carries Maps, Sets and typed arrays whole", async () => {
    const got = await remote.shapes();
    expect(got.m.get(1)).toBe(2);
    expect(got.s.has("a")).toBe(true);
    expect(got.a[0]).toBe(1.5);
  });

  it("answers calls in the order they were made", async () => {
    const all = await Promise.all([remote.later("a"), remote.add(1, 1), remote.later("b")]);
    expect(all).toEqual(["a!", 2, "b!"]);
  });

  it("tells every caller when the worker fails, instead of leaving them waiting", async () => {
    // a worker whose script didn't load, or that ran out of memory: it answers
    // nothing, and a plan or a mid-ride reroute used to wait on it forever
    class DeadWorker extends EventTarget {
      postMessage(): void {}
    }
    const worker = new DeadWorker();
    const dead = wrap<{ plan(): number }>(worker as unknown as FallibleEndpoint);
    const waiting = dead.plan();
    worker.dispatchEvent(new Event("error"));
    await expect(waiting).rejects.toThrow(WORKER_FAILED);
    await expect(dead.plan()).rejects.toThrow(WORKER_FAILED);
  });

  it("lives on after an error once it has started, failing only what was in flight", async () => {
    class LiveWorker extends EventTarget {
      postMessage(): void {}
      say(data: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }
    const worker = new LiveWorker();
    const live = wrap<{ plan(): number }>(worker as unknown as FallibleEndpoint);
    worker.say({ kind: "ready" });
    const inFlight = live.plan(); // id 0
    worker.dispatchEvent(new Event("error"));
    await expect(inFlight).rejects.toThrow(/lost that request/);
    const next = live.plan(); // id 1, answered
    worker.say({ kind: "reply", id: 1, ok: true, value: 7 });
    expect(await next).toBe(7);
  });

  it("gives up on a worker that goes silent, but not on one that is busy", async () => {
    // a worker that dies after starting fires nothing: what waited on it
    // waited for ever. One that is loading tiles says so tile by tile.
    let fire: (() => void) | null = null;
    const timers = {
      setTimeout: (fn: () => void): unknown => {
        fire = fn;
        return 1;
      },
      clearTimeout: (): void => {
        fire = null;
      },
    };
    class Worker extends EventTarget {
      postMessage(): void {}
      say(data: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }
    const worker = new Worker();
    const r = wrap<{ ensure(onProgress: (n: number) => void): boolean }>(
      worker as unknown as FallibleEndpoint,
      timers,
    );
    worker.say({ kind: "ready" });
    const busy = r.ensure(() => undefined);
    worker.say({ kind: "callback", id: 0, fn: 0, args: [1] }); // progress: alive
    worker.say({ kind: "reply", id: 0, ok: true, value: true });
    expect(await busy).toBe(true);
    const lost = r.ensure(() => undefined);
    expect(fire).not.toBeNull();
    (fire as unknown as () => void)(); // ninety seconds of nothing
    await expect(lost).rejects.toThrow(/didn't answer/);
  });

  it("isn't mistaken for a promise", async () => {
    // `await remote` would hang forever if the proxy offered a then()
    expect(await Promise.resolve(remote)).toBe(remote);
  });
});

describe.skipIf(skipRouting)("routing in the worker, on the pinned data", () => {
  const DAVIS: [number, number] = [-71.122258, 42.396748];
  const KENDALL: [number, number] = [-71.086705, 42.362552];
  const prefs: WirePrefs = { profileId: "young_kids", preferFlat: false, avoid: [], walkMaxM: 800 };
  const source: DataSource = { remoteId: null, bundled: `${DATA}/` };
  const load = async (src: DataSource, name: string): Promise<unknown> =>
    JSON.parse(readFileSync(`${src.bundled}${name}`, "utf8")) as unknown;
  let routing: Remote<RoutingApi>;
  const progress: [number, number][] = [];

  beforeAll(async () => {
    routing = channel(createRoutingApi(load));
    await routing.configure(source, "imperial");
    await routing.loadManifest();
    const first = await routing.ensure([DAVIS, KENDALL], 1, (done, total) => progress.push([done, total]));
    expect(first).toEqual({ ready: true, rebuilt: true });
  }, 60_000);

  it("reports tile loading as it goes, to the last one", () => {
    const [, total] = progress[0] ?? [0, 0];
    expect(total).toBeGreaterThan(4);
    expect(progress[progress.length - 1]).toEqual([total, total]);
  });

  it("rebuilds the graph only when the loaded tiles grew", async () => {
    expect(await routing.ensure([DAVIS, KENDALL], 1)).toEqual({ ready: true, rebuilt: false });
  });

  it("plans the ground-truth trip: the Community Path, mostly protected", async () => {
    const options = await routing.plan(DAVIS, KENDALL, prefs);
    const safest = options.find((o) => o.id === "safest");
    expect(safest?.payload.summary.pct_protected).toBeGreaterThan(70);
    expect(JSON.stringify(safest?.payload.geojson)).toContain("Community Path");
  });

  it("writes its reasons in the rider's units, not the page's default", async () => {
    try {
      await routing.configure(source, "metric");
      const why = async (): Promise<string> =>
        JSON.stringify((await routing.plan(DAVIS, KENDALL, prefs)).map((o) => o.payload.summary.explanation));
      const metric = await why();
      await routing.configure(source, "imperial");
      const imperial = await why();
      expect(metric).toMatch(/\d (m|km)\b/);
      expect(metric).not.toMatch(/\d (mi|ft)\b/);
      expect(imperial).toMatch(/\d (mi|ft)\b/);
      expect(imperial).not.toMatch(/\d (m|km)\b/);
    } finally {
      setUnits("imperial");
    }
    expect(getUnits()).toBe("imperial");
  });

  it("keeps a proposed lane to the one search that asked about it", async () => {
    const plain = await routing.plan(DAVIS, KENDALL, prefs);
    // a proposed lane down Mass Ave, the direct line
    const lane: [number, number][] = [
      [-71.1195, 42.3965],
      [-71.105, 42.38],
      [-71.095, 42.37],
    ];
    const what = await routing.planWith(lane, DAVIS, KENDALL, prefs);
    expect(what.covered).toBeGreaterThanOrEqual(0);
    // the next search is planned on the streets as they are
    expect(JSON.stringify(await routing.plan(DAVIS, KENDALL, prefs))).toBe(JSON.stringify(plain));
  });

  it("keeps what routes avoid across a rebuild of the graph", async () => {
    const before = await routing.plan(DAVIS, KENDALL, prefs);
    const safest = before.find((o) => o.id === "safest");
    const features = safest?.payload.geojson.features ?? [];
    const coords = features.flatMap((f) => f.geometry.coordinates as [number, number][]);
    // the whole middle of it marked: there has to be another way
    const marks = coords.slice(Math.floor(coords.length / 4), Math.floor((coords.length * 3) / 4));
    await routing.setSketchyMarks(marks.filter((_c, i) => i % 3 === 0));
    expect(JSON.stringify(await routing.plan(DAVIS, KENDALL, prefs))).not.toBe(JSON.stringify(before));
    // more tiles: the graph is rebuilt, and must still avoid the mark
    const grown = await routing.ensure([DAVIS, [-71.2, 42.42]], 1);
    expect(grown.rebuilt).toBe(true);
    const after = await routing.plan(DAVIS, KENDALL, prefs);
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
    await routing.setSketchyMarks([]);
  });

  it("routes on the bundle's whole set when the site's newer tiles can't be had", async () => {
    // offline, with the site's newer build chosen at launch and a tile of it
    // not yet cached: its tiles can't be mixed with the bundle's, but the
    // bundle's whole set routes, a little older, instead of not at all
    const served: { name: string; from: string | null }[] = [];
    const offlineSite = async (src: DataSource, name: string): Promise<unknown> => {
      if (src.remoteId !== null && name.startsWith("tiles/") && name !== "tiles/manifest.json") {
        throw new SiteTileMissing(name);
      }
      served.push({ name, from: src.remoteId });
      return load(src, name);
    };
    const phone = channel(createRoutingApi(offlineSite));
    await phone.configure({ remoteId: "2026-09-27", bundled: `${DATA}/` }, "imperial");
    await phone.loadManifest();
    expect(await phone.ensure([DAVIS, KENDALL], 1)).toEqual({ ready: true, rebuilt: true });
    expect((await phone.plan(DAVIS, KENDALL, prefs)).length).toBeGreaterThan(0);
    // and every tile it routed on came from the bundle, none from the site
    const tiles = served.filter((l) => l.name !== "tiles/manifest.json");
    expect(tiles.length).toBeGreaterThan(4);
    expect(tiles.every((l) => l.from === null)).toBe(true);
    // ...and stays there when the page configures again (a change of units)
    await phone.configure({ remoteId: "2026-09-27", bundled: `${DATA}/` }, "metric");
    await phone.ensure([DAVIS, [-71.2, 42.42]], 1);
    expect(served.filter((l) => l.name !== "tiles/manifest.json").every((l) => l.from === null)).toBe(true);
  });

  it("moves every request that was waiting on the site's tiles to the bundle, not only the first", async () => {
    // Grading the search results and planning the route ask for the same tiles
    // at once; offline, both fail together. The first to notice switched to the
    // bundle and set the flag, and the second, finding it set, took it to mean
    // that the bundle itself had failed, and gave up: the very case the
    // fallback is for, failing for whoever came second.
    const served: { name: string; from: string | null }[] = [];
    const offlineSite = async (src: DataSource, name: string): Promise<unknown> => {
      if (src.remoteId !== null && name.startsWith("tiles/") && name !== "tiles/manifest.json") {
        await new Promise((r) => setTimeout(r, 5));
        throw new SiteTileMissing(name);
      }
      served.push({ name, from: src.remoteId });
      return load(src, name);
    };
    const phone = channel(createRoutingApi(offlineSite));
    await phone.configure({ remoteId: "2026-09-27", bundled: `${DATA}/` }, "imperial");
    await phone.loadManifest();
    const both = await Promise.all([
      phone.ensure([DAVIS, KENDALL], 1),
      phone.ensure([DAVIS, KENDALL], 1),
      phone.ensure([DAVIS, [-71.2, 42.42]], 1),
    ]);
    expect(both.map((r) => r.ready)).toEqual([true, true, true]);
    expect((await phone.plan(DAVIS, KENDALL, prefs)).length).toBeGreaterThan(0);
  });

  it("still fails, when the bundle itself can't give a tile, rather than looping", async () => {
    const broken = async (src: DataSource, name: string): Promise<unknown> => {
      if (name.startsWith("tiles/") && name !== "tiles/manifest.json") {
        throw src.remoteId !== null ? new SiteTileMissing(name) : new Error(`bundle lost ${name}`);
      }
      return load(src, name);
    };
    const phone = channel(createRoutingApi(broken));
    await phone.configure({ remoteId: "2026-09-27", bundled: `${DATA}/` }, "imperial");
    await phone.loadManifest();
    await expect(phone.ensure([DAVIS, KENDALL], 1)).rejects.toThrow(/bundle lost/);
  });

  it("falls back to the bundle when the site's tile manifest itself can't be had", async () => {
    const noManifest = async (src: DataSource, name: string): Promise<unknown> => {
      if (src.remoteId !== null && name.startsWith("tiles/")) throw new SiteTileMissing(name);
      return load(src, name);
    };
    const phone = channel(createRoutingApi(noManifest));
    await phone.configure({ remoteId: "2026-09-27", bundled: `${DATA}/` }, "imperial");
    await phone.loadManifest();
    expect((await phone.ensure([DAVIS, KENDALL], 1)).ready).toBe(true);
  });

  it("says why it can't, in words, when there is nothing to route on", async () => {
    const empty = channel(createRoutingApi(load));
    await empty.configure(source, "imperial");
    await expect(empty.plan(DAVIS, KENDALL, prefs)).rejects.toThrow(/isn't mapped/);
    expect(await empty.streetNameAt(DAVIS[0], DAVIS[1], 20)).toBeNull();
  });

  it("names the street under a point, and what kind of way it is", async () => {
    expect(await routing.streetNameAt(-71.1223, 42.3967, 40)).not.toBeNull();
    expect(await routing.edgeClassAt(-71.1223, 42.3967)).not.toBeNull();
  });
});
