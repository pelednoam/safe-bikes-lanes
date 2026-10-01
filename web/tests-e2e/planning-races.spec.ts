// Planning is a chain of waits — the rider's location, the map tiles along the
// corridor, the router — and a rider does not stand still through them. They
// press Reset, pick a second destination, close the reach map. Every one of
// these tests interrupts a wait at the point where the old code resumed as if
// nothing had happened.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { budget } from "./budget.js";

declare global {
  interface Window {
    _map?: MLMap;
    /** Hands the held location request its answer (see holdLocation). */
    __releaseFix?: (lon: number, lat: number) => void;
  }
}

type Page = import("@playwright/test").Page;

// page.route cannot see a request the service worker answers, and every test
// here works by holding requests back
test.use({ serviceWorkers: "block" });
// every test here waits out a deliberately slow request on top of the usual map
// load, which is more than the suite's default allows on a loaded machine
test.describe.configure({ timeout: 240_000 });

const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";
const START_TITLE = '.maplibregl-marker[title="start (drag to move)"]';

async function openReachMap(page: Page): Promise<void> {
  await page.locator('summary:has-text("Other trip types")').click();
  await page.locator("#shed-btn").click();
}

async function boot(page: Page, hash: string): Promise<void> {
  await page.goto(`/${hash}`);
  // the map object, not map.loaded(): with tiles held back on purpose the map
  // can take its time to settle, and nothing here needs it settled
  await page.waitForFunction(() => window._map !== undefined, null, {
    timeout: budget(45_000),
  });
}

/** Routing tiles are held back until the test lets them go — the phone on a
 * slow street, but with the street's slowness in the test's hands. They used to
 * answer after a set time, and a test then had only a counter of how many it
 * had ever delayed to say its race had run: once the time had passed, that
 * counter still said so, and a slow runner could take the test's second action
 * after the first plan had finished, passing without a race in it. Now a tile
 * is held until release(), `held()` is how many are held at this moment, and a
 * test asserts it is positive when its second action happens.
 *
 * Routing tiles are fetched by the routing worker, so a hold that never
 * applied to them would leave these tests passing without a race in them:
 * hence `held()`, which stays zero if it didn't. */
async function holdTiles(page: Page): Promise<{ held: () => number; release: () => void }> {
  let held = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  await page.route(/\/data\/tiles\/[^/]+\.json$/, async (route) => {
    if (route.request().url().endsWith("manifest.json")) return route.continue();
    held++;
    await gate;
    held--;
    return route.continue();
  });
  return { held: () => held, release: open };
}

/** A location request that is held until the test releases it, like a cold GPS.
 * `granted` decides what the permissions API reports, which is what decides
 * whether the app locates the rider at load on its own. */
async function holdLocation(page: Page, granted: boolean): Promise<void> {
  await page.addInitScript((isGranted: boolean) => {
    const waiting: PositionCallback[] = [];
    const pos = (lon: number, lat: number): GeolocationPosition =>
      ({
        coords: {
          latitude: lat,
          longitude: lon,
          accuracy: 8,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      }) as unknown as GeolocationPosition;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition(cb: PositionCallback): void {
          waiting.push(cb);
        },
        watchPosition(): number {
          return 1;
        },
        clearWatch(): void {
          /* nothing to clear */
        },
      },
    });
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: async () => ({ state: isGranted ? "granted" : "prompt" }),
      },
    });
    window.__releaseFix = (lon: number, lat: number): void => {
      for (const cb of waiting.splice(0)) cb(pos(lon, lat));
    };
  }, granted);
}

/** The coordinates of the route currently drawn. */
async function drawnRoute(page: Page): Promise<[number, number][]> {
  return page.evaluate(async () => {
    const src = window._map?.getSource("route") as
      | { getData(): Promise<GeoJSON.FeatureCollection> }
      | undefined;
    return ((await src?.getData())?.features ?? []).flatMap((f) =>
      f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
    );
  });
}

/** Every held request answered and the page idle again. The round trip through
 * the page waits out a router build, which holds the main thread for a long
 * while on a loaded machine — a test that only waits on the clock checks its
 * assertions before the abandoned work has even run. */
async function settled(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  await page.waitForTimeout(1000);
}

/** Move the reach slider the way a finger does: value, then an input event. */
async function setBudget(page: Page, km: number): Promise<void> {
  await page.evaluate((v) => {
    const input = document.getElementById("shed-budget") as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, km);
}

function metres(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180);
  const dy = (b[1] - a[1]) * 110_540;
  return Math.hypot(dx, dy);
}

test("the loading line goes away after a route, and stays away", async ({ page }) => {
  // The route's progress callback was a module global that only an error
  // cleared. Anything that loaded tiles afterwards — the reach map, search
  // grading — called it, and "Loading the map around your route… 40 of 40" sat
  // over the map for good with nothing loading.
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(120_000) });
  await expect(page.locator("#loading")).toBeHidden();

  await openReachMap(page);
  // the far end of the reach slider pulls a good many tiles the route never needed
  await setBudget(page, 8);
  const pt = await page.evaluate(() => {
    const p = window._map?.project([-71.105, 42.39]);
    return { x: Math.round(p?.x ?? 0), y: Math.round(p?.y ?? 0) };
  });
  await page.mouse.click(pt.x, pt.y);
  await expect(page.locator("#shed-info")).toContainText("reachable", { timeout: budget(120_000) });
  await page.waitForTimeout(500);
  await expect(page.locator("#loading"), "a finished route's spinner came back").toBeHidden();
});

test("Reset while the map is loading means reset", async ({ page }) => {
  const slow = await holdTiles(page);
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator("#loading")).toContainText(/Loading the map/, {
    timeout: budget(20_000),
  });
  // the plan really is waiting on held tiles: this is the race, not a guess at it
  await expect.poll(slow.held, { timeout: budget(20_000) }).toBeGreaterThan(0);
  await page.locator("#reset").click();
  // still held at the Reset, which the abandoned request then gets to finish
  expect(slow.held(), "the plan wasn't waiting when Reset was pressed").toBeGreaterThan(0);
  slow.release();
  await settled(page);
  await expect(page.locator(".option-card"), "the cleared trip came back").toHaveCount(0);
  await expect(page.locator("#summary")).toBeHidden();
  await expect(page.locator("#loading")).toBeHidden();
  expect(await drawnRoute(page)).toHaveLength(0);
});

test("Reset just as a plan lands leaves nothing of it behind", async ({ page }) => {
  // A finished plan paints its panel once its line is drawn, up to 3 s later
  // (paintPanelWithRoute). Reset withdrew plans still computing but not that
  // pending paint, so a Reset in the gap cleared the trip and then the paint put
  // its summary back: no route, no cards, and a summary of the trip just
  // cleared. It needs a slow machine to happen by accident (it failed the deploy
  // gate once, and a loaded dev box once), so here it happens on purpose: Reset
  // the moment the route's line has data, before its panel has been painted.
  await boot(page, DAVIS_KENDALL);
  await page.evaluate(async () => {
    const src = window._map?.getSource("route") as
      | { getData(): Promise<{ features?: unknown[] }> }
      | undefined;
    for (;;) {
      if (((await src?.getData())?.features ?? []).length > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    document.getElementById("reset")?.click();
  });
  await settled(page);
  // past the paint's own 3 s deadline
  await page.waitForTimeout(3500);
  await expect(page.locator(".option-card")).toHaveCount(0);
  await expect(page.locator("#summary"), "a cleared trip's summary came back").toBeHidden();
});

test("Reset while waiting for a location is not an error", async ({ page }) => {
  await holdLocation(page, false);
  // a destination only: the start is "Your location", which is still coming
  await boot(page, "#e=-71.086705,42.362552&m=young_kids");
  await expect(page.locator("#loading")).toContainText(/Finding your location/, {
    timeout: budget(20_000),
  });
  await page.locator("#reset").click();
  await page.evaluate(() => window.__releaseFix?.(-71.1195, 42.3967));
  await page.waitForTimeout(2000);
  await expect(page.locator("#error")).not.toContainText(/Cannot read|null/);
  await expect(page.locator(".option-card")).toHaveCount(0);
  await expect(page.locator(START_TITLE), "a start appeared on a reset map").toHaveCount(0);
});

test("a cold GPS answering two askers puts down one start, not two", async ({ page }) => {
  // With permission already granted the app locates the rider at load, and a
  // link's destination asks for the same position at the same moment. Both
  // waited on one slow fix, and each put its own pin down.
  await holdLocation(page, true);
  await boot(page, "#e=-71.086705,42.362552&m=young_kids");
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__releaseFix?.(-71.1195, 42.3967));
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(120_000) });
  await expect(page.locator(START_TITLE)).toHaveCount(1);
});

test("the last destination asked for is the one that gets drawn", async ({ page }) => {
  // A far destination waits on tiles; a near one picked straight afterwards
  // does not. The far one used to finish last and overwrite the near one's
  // route, selection and framing, with the end pin sitting on the near one.
  await boot(page, DAVIS_KENDALL);
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: budget(120_000) });
  const slow = await holdTiles(page);
  const far: [number, number] = [-71.1829, 42.3651];
  const near: [number, number] = [-71.1043, 42.3818];
  await page.evaluate(() => window._map?.jumpTo({ center: [-71.16, 42.375], zoom: 12 }));
  await page.waitForTimeout(300);
  const click = async (p: [number, number]): Promise<void> => {
    const xy = await page.evaluate((q) => {
      const s = window._map?.project(q);
      return { x: Math.round(s?.x ?? 0), y: Math.round(s?.y ?? 0) };
    }, p);
    await page.mouse.click(xy.x, xy.y);
  };
  await click(far);
  // the far plan is held on its tiles: without this the near one could finish
  // first because the far one never waited at all, and the test passes anyway
  await expect.poll(slow.held, { timeout: budget(20_000) }).toBeGreaterThan(0);
  await click(near);
  // Routing runs in a worker, so the page is free while a route is found:
  // reading the route once the network went quiet read the old trip on a slow
  // runner, before either plan had landed. Wait for the near one to be drawn...
  const drawnTo = async (): Promise<number> => {
    const route = await drawnRoute(page);
    const last = route[route.length - 1];
    return last === undefined ? Infinity : metres(last, near);
  };
  await expect.poll(drawnTo, { timeout: budget(90_000), message: "the near trip was never drawn" }).toBeLessThan(400);
  // ...while the far plan is still held: that is the order the bug needed
  expect(slow.held(), "the far plan had already finished").toBeGreaterThan(0);
  // ...then until every held tile has been answered, so the far plan has had
  // every chance to land, and it still must not have replaced the near one
  slow.release();
  await expect.poll(slow.held, { timeout: budget(60_000) }).toBe(0);
  await settled(page);
  expect(await drawnTo(), "the route drawn goes to an older destination").toBeLessThan(400);
  await expect(page.locator("#loading")).toBeHidden();
});

test("closing the reach map while it loads is not a crash", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // a rejected promise nobody awaited reaches the console, not pageerror
  page.on("console", (m) => {
    if (m.type() === "error" && /Uncaught|TypeError/.test(m.text())) errors.push(m.text());
  });
  await boot(page, "#c=-71.105,42.383,13");
  const slow = await holdTiles(page);
  await openReachMap(page);
  const pt = await page.evaluate(() => {
    const p = window._map?.project([-71.105, 42.39]);
    return { x: Math.round(p?.x ?? 0), y: Math.round(p?.y ?? 0) };
  });
  await page.mouse.click(pt.x, pt.y);
  // closed while it really is loading, not before it began or after it ended
  await expect.poll(slow.held, { timeout: budget(20_000) }).toBeGreaterThan(0);
  await page.locator("#shed-btn").click(); // close it mid-load
  expect(slow.held(), "the reach map had finished loading when it was closed").toBeGreaterThan(0);
  slow.release();
  // until the held tiles have all landed and the abandoned flood has had its
  // turn. The round trip through the page waits out the router build, which
  // holds the main thread for a long while on a loaded machine.
  await settled(page);
  expect(errors).toEqual([]);
  // and nothing was painted for a reach map that is no longer open
  const shed = await page.evaluate(async () => {
    const src = window._map?.getSource("shed") as
      | { getData(): Promise<GeoJSON.FeatureCollection> }
      | undefined;
    return (await src?.getData())?.features.length ?? 0;
  });
  expect(shed).toBe(0);
});

test("a smaller reach asked for last is the one shown", async ({ page }) => {
  await boot(page, "#c=-71.105,42.383,13");
  await openReachMap(page);
  const pt = await page.evaluate(() => {
    const p = window._map?.project([-71.105, 42.39]);
    return { x: Math.round(p?.x ?? 0), y: Math.round(p?.y ?? 0) };
  });
  await setBudget(page, 1);
  await page.mouse.click(pt.x, pt.y);
  await expect(page.locator("#shed-info")).toContainText("reachable", { timeout: budget(120_000) });
  // the big budget waits on tiles; the small one it is replaced by does not
  const slow = await holdTiles(page);
  await setBudget(page, 8);
  // the big reach is held on tiles it needs, so the small one really overtakes it
  await expect.poll(slow.held, { timeout: budget(20_000) }).toBeGreaterThan(0);
  await setBudget(page, 1);
  await expect(page.locator("#shed-info")).toContainText(/within a perceived (0\.6 mi|1 km)/);
  // and the big one is still held as the small one lands, which is what made it
  // a race: let go, it finishes last, and must not paint over the small
  expect(slow.held(), "the big reach had finished before the small one").toBeGreaterThan(0);
  slow.release();
  await expect.poll(slow.held, { timeout: budget(60_000) }).toBe(0);
  await settled(page);
  await expect(page.locator("#shed-info")).toContainText(/within a perceived (0\.6 mi|1 km)/);
});
