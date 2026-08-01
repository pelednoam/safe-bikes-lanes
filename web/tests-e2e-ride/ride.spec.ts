// Whole-ride scenarios: a simulated rider actually riding the route, so the
// navigation path gets exercised the way it is used rather than as a series of
// isolated interactions. See rider.ts for what the simulation does and does not
// reproduce faithfully.
import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

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
  const path = await page.evaluate(() => {
    const src = window._map?.getSource("route") as { _data?: GeoJSON.FeatureCollection } | undefined;
    return (src?._data?.features ?? []).flatMap((f) =>
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
  // the big slot says the word; the line below names where you are, and the
  // stale speed reading is cleared
  await expect(page.locator("#nav-dist")).toContainText(/arrived/i, { timeout: 10_000 });
  await expect(page.locator("#nav-remaining")).toContainText(/km ridden/);
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

test("a bad GPS stretch doesn't trigger a phantom reroute", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  // accuracy goes to 90 m for a stretch — worse than MAX_GPS_ACCURACY_M, so
  // those fixes must not be trusted to declare the rider off-route
  await ride(page, path, {
    speedKmh: 12,
    timeScale: 1,
    fixHz: 2,
    untilM: 300,
    degradeFromM: 80,
    degradeToM: 260,
  });
  const spoken = await page.evaluate(() => window.__rider.spoken);
  expect(spoken.filter((s) => /rerouting/i.test(s))).toHaveLength(0);
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

test("a single teleporting fix can't end the ride", async ({ page }) => {
  test.slow();
  // A phone re-acquiring off a cell tower emits one fix far from the rider. It
  // used to latch "arrived!" — banner frozen and voice dead for the rest of the
  // ride, plus a fabricated distance written to history.
  const path = await startRide(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 300 });
  const end = path[path.length - 1] as [number, number];
  await page.evaluate(
    (p) => window.__rider.setFix({ lon: p[0], lat: p[1], speed: 3, heading: 0, accuracy: 8 }),
    end,
  );
  await page.waitForTimeout(400);
  // ride on from where we actually were
  const log = await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 600 });
  await expect(page.locator("#nav-street")).not.toContainText(/arrived/i);
  expect(log.spoken.join(" | ")).not.toMatch(/you have arrived/i);
  // guidance is still live
  await expect(page.locator("#nav-remaining")).toContainText(/min/);
});

test("Escape doesn't wipe the trip mid-ride", async ({ page }) => {
  const path = await startRide(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 200 });
  const before = await page.evaluate(() => window.location.hash);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  // route, markers and permalink all survive; the ride is still on
  expect(await page.evaluate(() => window.location.hash)).toBe(before);
  const coords = await page.evaluate(() => {
    const src = window._map?.getSource("route") as { _data?: GeoJSON.FeatureCollection } | undefined;
    return (src?._data?.features ?? []).length;
  });
  expect(coords).toBeGreaterThan(0);
  await expect(page.locator("#nav-banner")).toBeVisible();
});

test("tapping the map asks in-page without freezing guidance", async ({ page }) => {
  const path = await startRide(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 150 });
  await page.mouse.click(195, 640);
  await expect(page.locator("#nav-ask")).toBeVisible();
  // the ride keeps running while the question is on screen — window.confirm
  // used to block the page entirely
  const before = await page.locator("#nav-remaining").textContent();
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 260 });
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
  await page.locator("#nav-toggle").click();
  await page.locator("#nav-mute").click();
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 2500 });
  // the ride passes busy crossings on this route; at least one was displayed
  const seen = await page.evaluate(() => window.__navAlertsSeen ?? 0);
  expect(seen).toBeGreaterThan(0);
});

test("a wrong turn says 'rerouting' once, not on every attempt", async ({ page }) => {
  test.slow();
  const path = await startRide(page);
  // stand off-route: the old fixed cooldown re-announced every 10 s forever
  let sawOffRouteAlert = false;
  await ride(page, path, {
    speedKmh: 12,
    timeScale: 1,
    fixHz: 2,
    untilM: 420,
    divertAtM: 200,
    divertM: 220,
    onFix: async () => {
      // sample while we're actually off the line — it correctly clears again
      // once the rider rejoins, which is where this ride ends
      if (!sawOffRouteAlert) {
        sawOffRouteAlert = await page.locator("#nav-alert").isVisible();
      }
    },
  });
  const spoken = await page.evaluate(() => window.__rider.spoken);
  const reroutes = spoken.filter((s) => /rerouting|going your way/i.test(s));
  expect(reroutes.length).toBeLessThanOrEqual(2);
  // the rider was told they were off route rather than left on "adjusting…"
  expect(sawOffRouteAlert).toBe(true);
});

test("joining a route part-way doesn't machine-gun the milestones", async ({ page }) => {
  const path = await startRide(page);
  // first fix lands ~4 km along, as after a car/train leg
  const at = path[Math.floor(path.length * 0.45)] as [number, number];
  await page.evaluate(
    (p) => window.__rider.setFix({ lon: p[0], lat: p[1], speed: 3, heading: 0, accuracy: 8 }),
    at,
  );
  await page.waitForTimeout(600);
  const spoken = await page.evaluate(() => window.__rider.spoken);
  const chimes = spoken.filter((s) => /kilometers? done/i.test(s));
  expect(chimes.length).toBeLessThanOrEqual(1);
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

  // the whole banner opens the controls, not just a 27 px chevron
  await expect(page.locator("#nav-extra")).not.toBeVisible();
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  await expect(page.locator("#nav-extra")).toBeVisible();

  // every control is a thumb-sized target
  const tools = await page.evaluate(() =>
    [...document.querySelectorAll("#nav-tools button, #nav-buttons button")].map((b) => {
      const r = b.getBoundingClientRect();
      return { id: b.id, w: Math.round(r.width), h: Math.round(r.height) };
    }),
  );
  expect(tools.length).toBeGreaterThan(5);
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
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
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

test("a solo rider isn't told to gather up the kids", async ({ page }) => {
  test.slow();
  const path = await startRide(page, "#s=-71.122258,42.396748&e=-71.086705,42.362552&m=solo");
  const log = await ride(page, path, { speedKmh: 16, timeScale: 60, untilM: 4000 });
  expect(log.spoken.filter((s) => /gather up/i.test(s))).toHaveLength(0);
});
