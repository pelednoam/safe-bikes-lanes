// The resolver decides whether the app shows fresh data or the copy baked into
// the APK. Getting it wrong is silent in both directions: stale maps that look
// current, or a phone with no signal that renders nothing. It had almost no
// coverage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dataUrl, initDataSource, isNewerBuild, loadJson, usingRemoteData } from "../src/data.js";

const SITE = "https://pelednoam.github.io/safe-bikes-lanes/data/";

interface FakeCache {
  match: (url: string) => Promise<Response | undefined>;
  put: (url: string, resp: Response) => Promise<void>;
}

/** A caches API that keeps responses in a Map, so cache hits are observable. */
function installCaches(): { stores: Map<string, Map<string, string>>; deleted: string[] } {
  const stores = new Map<string, Map<string, string>>();
  const deleted: string[] = [];
  (globalThis as unknown as { caches: unknown }).caches = {
    open: async (name: string): Promise<FakeCache> => {
      const store = stores.get(name) ?? new Map<string, string>();
      stores.set(name, store);
      return {
        match: async (url: string) => {
          const body = store.get(url);
          return body === undefined ? undefined : new Response(body);
        },
        put: async (url: string, resp: Response) => {
          store.set(url, await resp.text());
        },
      };
    },
    keys: async (): Promise<string[]> => [...stores.keys()],
    delete: async (name: string): Promise<boolean> => {
      deleted.push(name);
      return stores.delete(name);
    },
  };
  return { stores, deleted };
}

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 404 });
}

describe("isNewerBuild", () => {
  it("compares build dates and rejects anything that isn't one", () => {
    expect(isNewerBuild("2026-08-01", "2026-08-05")).toBe(true);
    expect(isNewerBuild("2026-08-05", "2026-08-05")).toBe(false);
    expect(isNewerBuild("2026-08-05", "2026-08-01")).toBe(false);
    // a malformed date must never be read as "newer" — that would swap the
    // whole map out for whatever answered the request
    expect(isNewerBuild("2026-08-01", "tomorrow")).toBe(false);
    expect(isNewerBuild("", "2026-08-05")).toBe(false);
    expect(isNewerBuild("2026-8-1", "2026-08-05")).toBe(false);
  });
});

describe("choosing a source", () => {
  beforeEach(() => {
    vi.resetModules();
    installCaches();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays on the bundle in a browser, whatever the site says", async () => {
    // the website serving itself must never fetch its own data cross-origin.
    // A window with no Capacitor on it is what a browser looks like, so this
    // runs the real isNativeApp rather than mocking the decision away.
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async () => jsonResponse({ built: "2099-01-01" }));
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../src/data.js");
    await mod.initDataSource();
    expect(mod.usingRemoteData()).toBeNull();
    expect(mod.dataUrl("x.json")).toBe("data/x.json");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers the site when its build is newer, and says so", async () => {
    vi.doMock("../src/native.js", () => ({ isNativeApp: () => true }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        jsonResponse({ built: url.startsWith("http") ? "2026-08-05" : "2026-07-01" }),
      ),
    );
    const mod = await import("../src/data.js");
    await mod.initDataSource();
    expect(mod.usingRemoteData()).toBe("2026-08-05");
    expect(mod.dataUrl("priorities.csv")).toBe(`${SITE}priorities.csv`);
  });

  it("stays on the bundle when the site is older or unreachable", async () => {
    vi.doMock("../src/native.js", () => ({ isNativeApp: () => true }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        jsonResponse({ built: url.startsWith("http") ? "2026-01-01" : "2026-07-01" }),
      ),
    );
    const older = await import("../src/data.js");
    await older.initDataSource();
    expect(older.usingRemoteData()).toBeNull();

    vi.resetModules();
    vi.doMock("../src/native.js", () => ({ isNativeApp: () => true }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const offline = await import("../src/data.js");
    await offline.initDataSource(); // must not throw: a ride starts anyway
    expect(offline.usingRemoteData()).toBeNull();
  });

  it("drops caches from older builds so a phone doesn't hoard them", async () => {
    const { stores, deleted } = installCaches();
    stores.set("remote-data-2026-01-01", new Map());
    stores.set("unrelated-cache", new Map());
    vi.doMock("../src/native.js", () => ({ isNativeApp: () => true }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        jsonResponse({ built: url.startsWith("http") ? "2026-08-05" : "2026-07-01" }),
      ),
    );
    const mod = await import("../src/data.js");
    await mod.initDataSource();
    expect(deleted).toContain("remote-data-2026-01-01");
    expect(deleted).not.toContain("unrelated-cache");
  });
});

describe("loading a layer", () => {
  beforeEach(() => {
    vi.resetModules();
    installCaches();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the bundle when there's no newer site build", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ hello: "bundle" }));
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../src/data.js");
    expect(await mod.loadJson<{ hello: string }>("thing.json")).toEqual({ hello: "bundle" });
    expect(fetchMock).toHaveBeenCalledWith("data/thing.json");
  });

  it("fetches from the site once, then serves the cache", async () => {
    vi.doMock("../src/native.js", () => ({ isNativeApp: () => true }));
    let layerFetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("meta.json") && url.startsWith("http")) {
          return jsonResponse({ built: "2026-08-05" });
        }
        if (url === "data/meta.json") return jsonResponse({ built: "2026-07-01" });
        layerFetches++;
        return jsonResponse({ from: "site" });
      }),
    );
    const mod = await import("../src/data.js");
    await mod.initDataSource();
    expect(await mod.loadJson("layer.json")).toEqual({ from: "site" });
    expect(await mod.loadJson("layer.json")).toEqual({ from: "site" });
    // the weekly refresh downloads once, not once per launch
    expect(layerFetches).toBe(1);
  });

  it("falls back to the bundled copy when the site 404s that layer", async () => {
    // exactly what happens to an optional layer a published snapshot predates
    vi.doMock("../src/native.js", () => ({ isNativeApp: () => true }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("meta.json")) {
          return jsonResponse({ built: url.startsWith("http") ? "2026-08-05" : "2026-07-01" });
        }
        return url.startsWith("http")
          ? jsonResponse({}, false)
          : jsonResponse({ from: "bundle" });
      }),
    );
    const mod = await import("../src/data.js");
    await mod.initDataSource();
    expect(await mod.loadJson("newish.json")).toEqual({ from: "bundle" });
  });
});

describe("the module's own defaults", () => {
  it("starts on the bundle before anything is resolved", () => {
    expect(usingRemoteData()).toBeNull();
    expect(dataUrl("a.json")).toBe("data/a.json");
    expect(typeof loadJson).toBe("function");
    expect(typeof initDataSource).toBe("function");
  });
});
