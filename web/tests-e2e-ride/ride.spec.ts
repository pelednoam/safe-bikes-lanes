// Whole-ride scenarios: a simulated rider actually riding the route, so the
// navigation path gets exercised the way it is used rather than as a series of
// isolated interactions. See rider.ts for what the simulation does and does not
// reproduce faithfully.
//
// What guidance a ride gives — turn calls, reroutes, milestones, arrival, what
// a bad fix is allowed to change — is decided by the ride engine and tested
// there, fix by fix and much faster (tests/ride.test.ts). These are for what
// only a browser shows: that the page, the map and the recorder follow it.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

import { plainSpot } from "../tests-e2e/mapspot.js";
import { installRider, ride } from "./rider.js";

declare global {
  interface Window {
    _map?: MLMap;
    __navAlertsSeen?: number;
    __rider: {
      spoken: string[];
      fixCount: number;
      setFix: (f: {
        lon: number;
        lat: number;
        accuracy?: number;
        speed?: number | null;
        heading?: number | null;
      }) => void;
      failFix: (code: number, message: string) => void;
    };
  }
}

type Page = import("@playwright/test").Page;

const DAVIS_KENDALL = "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids";

async function startRide(page: Page, hash = DAVIS_KENDALL): Promise<[number, number][]> {
  await installRider(page);
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 90_000,
  });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  const path = await page.evaluate(async () => {
    const src = window._map?.getSource("route") as { getData(): Promise<GeoJSON.FeatureCollection> } | undefined;
    return ((await src?.getData())?.features ?? []).flatMap((f) =>
      f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
    );
  });
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
  return path;
}

test("a whole ride: guidance, progress and arrival", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  const log = await ride(page, path, { speedKmh: 9, jitterM: 7, timeScale: 60 });

  // it kept its mouth shut about nothing and actually guided the ride
  expect(log.fixes).toBeGreaterThan(20);
  const turns = log.spoken.filter((s) => /turn|continue|left|right/i.test(s));
  expect(turns.length).toBeGreaterThan(0);
  // no instruction repeated back-to-back (the old fixed-distance staging did)
  for (let i = 1; i < log.spoken.length; i++) {
    expect(log.spoken[i]).not.toBe(log.spoken[i - 1]);
  }
  // arrival is announced and the ride is recorded
  expect(log.spoken.join(" | ")).toMatch(/arrived/i);
  // in the unit the rider reads — miles by default. Everything on screen said
  // miles while the voice said "you have arrived. 4.1 kilometers", "1 kilometer
  // done", "entering a busy street for 100 meters".
  const arrival = log.spoken.find((s) => /nicely done/i.test(s)) ?? "";
  expect(arrival).toMatch(/\b(miles?|feet)\b/);
  for (const line of log.spoken) expect(line).not.toMatch(/kilomet|\bmeters?\b/i);
  // the big slot says the word; the line below names where you are, and the
  // stale speed reading is cleared
  await expect(page.locator("#nav-dist")).toContainText(/arrived/i, { timeout: 10_000 });
  await expect(page.locator("#nav-remaining")).toContainText(/\d (mi|ft) ridden/);
  await expect(page.locator("#nav-speed")).toHaveText("");
});

test("a wrong turn is noticed and rerouted, not ignored", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  // ride a stretch, then head off down a cross street. Real time: the reroute
  // cooldown is a wall-clock timer and won't compress.
  await ride(page, path, {
    speedKmh: 12,
    timeScale: 1,
    fixHz: 2,
    untilM: 260,
    divertAtM: 200,
    divertM: 90,
  });
  const spoken = await page.evaluate(() => window.__rider.spoken);
  expect(spoken.join(" | ")).toMatch(/rerouting|going your way/i);
  // and it recovers: still navigating, not stuck on "off route"
  await expect(page.locator("#nav-banner")).toBeVisible();
});

test("stopped at a light: the view stays put and the ETA holds", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  await ride(page, path, { speedKmh: 10, timeScale: 20, untilM: 200 });
  const before = await page.evaluate(() => ({
    bearing: window._map?.getBearing() ?? 0,
    trip: document.getElementById("nav-remaining")?.textContent ?? "",
  }));
  // sit still for 30 simulated seconds
  await ride(page, path, {
    speedKmh: 10,
    timeScale: 20,
    untilM: 205,
    pauseAtM: 200,
    pauseSeconds: 30,
  });
  const after = await page.evaluate(() => ({
    bearing: window._map?.getBearing() ?? 0,
    trip: document.getElementById("nav-remaining")?.textContent ?? "",
  }));
  // the map must not spin in place while stationary
  const spin = Math.abs(((after.bearing - before.bearing + 540) % 360) - 180);
  expect(spin).toBeLessThan(25);
  expect(after.trip).toMatch(/min/);
});

test("Escape doesn't wipe the trip mid-ride", async ({ page }) => {
  const path = await startRide(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 200 });
  const before = await page.evaluate(() => window.location.hash);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  // route, markers and permalink all survive; the ride is still on
  expect(await page.evaluate(() => window.location.hash)).toBe(before);
  const coords = await page.evaluate(async () => {
    const src = window._map?.getSource("route") as { getData(): Promise<GeoJSON.FeatureCollection> } | undefined;
    return ((await src?.getData())?.features ?? []).length;
  });
  expect(coords).toBeGreaterThan(0);
  await expect(page.locator("#nav-banner")).toBeVisible();
});

test("tapping the map asks in-page without freezing guidance", async ({ page }) => {
  const path = await startRide(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 150 });
  const spot = await plainSpot(page, 195, 640);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator("#nav-ask")).toBeVisible();
  // the ride keeps running while the question is on screen — window.confirm
  // used to block the page entirely
  const before = await page.locator("#nav-remaining").textContent();
  // far enough to move the figure in either unit: miles show in tenths, so
  // 260 m of progress (0.16 mi) can leave the same digits on screen
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 600 });
  expect(await page.locator("#nav-remaining").textContent()).not.toBe(before);
  // declining leaves the ride alone
  await page.locator("#nav-ask-no").click();
  await expect(page.locator("#nav-ask")).toBeHidden();
  await expect(page.locator("#nav-banner")).toBeVisible();
});

test("a ride interrupted by a reload is saved, not lost", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  await ride(page, path, { speedKmh: 14, timeScale: 40, untilM: 900 });
  // simulate the hardware Back / a crash: the page just goes away
  await page.reload();
  await page.waitForFunction(() => window._map !== undefined, null, { timeout: 90_000 });
  const rides = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("rideHistory") ?? "[]") as { meters: number }[],
  );
  expect(rides.length).toBeGreaterThan(0);
  expect(rides[0]?.meters ?? 0).toBeGreaterThan(200);
});

test("safety warnings are shown, not just spoken, and survive muting", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  // mute first: a muted phone used to get no crossing warning at all
  await page.locator("#nav-mute").click();
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 2500 });
  // the ride passes busy crossings on this route; at least one was displayed
  const seen = await page.evaluate(() => window.__navAlertsSeen ?? 0);
  expect(seen).toBeGreaterThan(0);
});

test("the saved ride distance matches the route, not GPS wander", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  // ride 3 km at a kid's pace with realistic wander; the recorded distance used
  // to come out 18-60% long and contradict the spoken arrival total
  await ride(page, path, { speedKmh: 8, jitterM: 8, timeScale: 60, untilM: 3000 });
  const ridden = await page.evaluate(() => {
    const raw = localStorage.getItem("rideInProgress");
    return raw ? (JSON.parse(raw) as { meters: number }).meters : 0;
  });
  expect(ridden).toBeGreaterThan(3000 * 0.85);
  expect(ridden).toBeLessThan(3000 * 1.15);
});

test("the ride controls are reachable and safe to press one-handed", async ({ page }) => {
  const path = await startRide(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 150 });

  // mute lives low on the right, in the easy thumb zone, at a real size
  const mute = await page.locator("#nav-mute").boundingBox();
  expect(mute?.width ?? 0).toBeGreaterThanOrEqual(48);
  expect(mute?.height ?? 0).toBeGreaterThanOrEqual(48);
  expect(mute?.y ?? 0).toBeGreaterThan(500);

  // nothing to open: the controls are the dock, and the drawer is gone
  expect(await page.locator("#nav-extra").count()).toBe(0);
  expect(await page.locator("#nav-toggle").count()).toBe(0);

  // every control is a thumb-sized target
  const tools = await page.evaluate(() =>
    [...document.querySelectorAll("#ride-dock .dock-btn")].map((b) => {
      const r = b.getBoundingClientRect();
      return { id: b.id, w: Math.round(r.width), h: Math.round(r.height) };
    }),
  );
  expect(tools.length).toBe(5);
  for (const t of tools) {
    expect(t.w, `${t.id} width`).toBeGreaterThanOrEqual(44);
    expect(t.h, `${t.id} height`).toBeGreaterThanOrEqual(44);
  }

  // MapLibre's own controls are out of the way (dead or harmful mid-ride)
  expect(
    await page.evaluate(() => {
      const g = document.querySelector(".maplibregl-ctrl-group");
      return g ? getComputedStyle(g).display : "none";
    }),
  ).toBe("none");

  // ending the ride asks first — it used to be one tap next to mute
  await page.locator("#nav-exit").click();
  await expect(page.locator("#nav-ask")).toBeVisible();
  await expect(page.locator("#nav-banner")).toBeVisible();
});

test("a mis-tapped detour can be abandoned immediately", async ({ page }) => {
  const path = await startRide(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 150 });
  // one tap to the stops menu, one to the fountain
  await page.locator("#nav-stops").click();
  await page.locator("#nav-water").click();
  // the way back is offered at once, not only on arrival at the fountain
  await expect(page.locator("#nav-resume")).toBeVisible();
  await page.locator("#nav-resume").click();
  await expect(page.locator("#nav-resume")).toBeHidden();
  await expect(page.locator("#nav-banner")).toBeVisible();
});

test("the view looks ahead, not at where you've been", async ({ page }) => {
  const path = await startRide(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 250 });
  const dot = await page.evaluate(() => {
    const el = document.querySelector(".nav-dot") as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { y: r.top + r.height / 2, h: window.innerHeight };
  });
  expect(dot).not.toBeNull();
  if (!dot) return;
  // the rider should sit well below the middle, so the screen is mostly the
  // road ahead — dead-centre left ~60% of it showing ground already covered
  expect(dot.y / dot.h).toBeGreaterThan(0.55);
});

test("guidance names what an unnamed way actually is", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  const log = await ride(page, path, { speedKmh: 14, timeScale: 60 });
  // "the path" was said 72 times on one long ride and can't be acted on
  const vague = log.spoken.filter((s) => /onto the path\b/.test(s));
  expect(vague).toHaveLength(0);
  // and nothing tells you to turn onto the way you're already on
  for (const s of log.spoken) {
    const m = /(?:turn|continue|slight|sharp) \w* ?(?:left|right)? ?onto (.+?)(?:,|$)/.exec(s);
    if (m) expect(s).not.toMatch(new RegExp(`onto ${m[1]}, then \\\\w+ \\\\w+ onto ${m[1]}$`));
  }
  // no three-part chains
  expect(log.spoken.filter((s) => (s.match(/, then /g) ?? []).length > 1)).toHaveLength(0);
});

