// A sweep over the findings the six simulated riders reported, one assertion
// per finding, so "it's fixed" is checkable rather than asserted in a commit
// message. Titles carry the original symptom.
//
// Findings deliberately NOT covered here, because they are not fixed, are
// listed in docs/ride-audit.md with the reason.
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

async function plan(page: Page, hash = DAVIS_KENDALL): Promise<[number, number][]> {
  await installRider(page);
  await page.goto(`/${hash}`);
  // Booting a WebGL map is a resource wait, not a behavioural one: four workers
  // run four of them at once here and the runner is slower still, so whichever
  // test happens to boot last was failing at 45 s while passing in 16 s alone.
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 90_000,
  });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  return page.evaluate(() => {
    const src = window._map?.getSource("route") as { _data?: GeoJSON.FeatureCollection } | undefined;
    return (src?._data?.features ?? []).flatMap((f) =>
      f.geometry.type === "LineString" ? (f.geometry.coordinates as [number, number][]) : [],
    );
  });
}

async function startNav(page: Page, hash = DAVIS_KENDALL): Promise<[number, number][]> {
  const path = await plan(page, hash);
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
  return path;
}

// ── controls: sizes, labels, spacing ──────────────────────────────────────

test("every emoji control carries a word and a label (tooltips don't exist on touch)", async ({
  page,
}) => {
  await startNav(page);
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  const tools = await page.evaluate(() =>
    [...document.querySelectorAll("#nav-tools button")].map((b) => ({
      id: b.id,
      text: (b.textContent ?? "").replace(/[^\p{L}\p{N} ]/gu, "").trim(),
      aria: b.getAttribute("aria-label") ?? "",
    })),
  );
  expect(tools.length).toBeGreaterThan(5);
  for (const t of tools) {
    expect(t.text, `${t.id} needs a visible word`).not.toBe("");
    expect(t.aria, `${t.id} needs an aria-label`).not.toBe("");
  }
});

test("the warning triangle renders as an emoji, not a hairline glyph", async ({ page }) => {
  await startNav(page);
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  // U+FE0F forces the coloured presentation; without it the one control with a
  // persistent side effect was the faintest thing in the row
  const glyph = await page.evaluate(
    () => document.querySelector("#nav-hazard span")?.textContent ?? "",
  );
  expect(glyph).toContain("️");
});

test("adjacent controls are far enough apart to not mis-tap", async ({ page }) => {
  await startNav(page);
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  const gaps = await page.evaluate(() => {
    const rects = [...document.querySelectorAll("#nav-tools button, #nav-buttons button")].map(
      (b) => b.getBoundingClientRect(),
    );
    const out: number[] = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i] as DOMRect;
        const b = rects[j] as DOMRect;
        const dx = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
        const dy = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
        if (dx === 0 || dy === 0) out.push(Math.max(dx, dy));
      }
    }
    return out.filter((g) => g > 0);
  });
  // measured 7-9 px before, where a 30 px slip from mute landed on "end ride"
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(10);
});

// ── banner: stability and what it says ────────────────────────────────────

test("the trip line stays on one line and the banner keeps its height", async ({ page }) => {
  const path = await startNav(page);
  const heights = new Set<number>();
  await ride(page, path, {
    speedKmh: 12,
    timeScale: 30,
    untilM: 700,
    onFix: async () => {
      const h = await page.evaluate(() => {
        const trip = document.getElementById("nav-trip");
        return trip ? Math.round(trip.getBoundingClientRect().height) : 0;
      });
      heights.add(h);
    },
  });
  // "arrive 2:47 PM" wrapped with "PM" alone on line 2, so the banner twitched
  // between 107 and 125 px all ride
  expect([...heights].length).toBeLessThanOrEqual(2);
  expect(Math.max(...heights)).toBeLessThan(30);
});

test("the arrival ETA doesn't jump when you stop at a light", async ({ page }) => {
  const path = await startNav(page);
  // one continuous ride with a stop in it: ride() always starts from the top of
  // the path, so two calls would replay the route and move the ETA honestly
  let rolling = "";
  let stopped = "";
  await ride(page, path, {
    speedKmh: 11,
    timeScale: 20,
    untilM: 460,
    pauseAtM: 400,
    pauseSeconds: 30,
    onFix: async ({ alongM }) => {
      const txt = (await page.locator("#nav-remaining").textContent()) ?? "";
      if (alongM < 400) rolling = txt;
      else if (stopped === "") stopped = txt;
    },
  });
  const mins = (s: string): number => Number(/(\d+) min/.exec(s)?.[1] ?? 0);
  // it used to swing ~6 min at every stop, flipping between measured and
  // profile pace
  expect(Math.abs(mins(stopped) - mins(rolling))).toBeLessThanOrEqual(3);
});

test("the selected route still shows its protected share", async ({ page }) => {
  await plan(page);
  // the safety-first card was the one card with no safety number, because the
  // breakdown that "already says it" is below the fold on a phone
  await expect(page.locator(".option-card.selected .opt-stats")).toContainText(/% protected/);
});

// ── GPS trouble ───────────────────────────────────────────────────────────

test("losing GPS is announced, and blames the signal rather than permissions", async ({ page }) => {
  const path = await startNav(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 200 });
  await page.evaluate(() => window.__rider.failFix(2, "position unavailable"));
  await expect(page.locator("#nav-alert")).toBeVisible();
  await expect(page.locator("#nav-alert")).toContainText(/signal/i);
  await expect(page.locator("#nav-alert")).not.toContainText(/permission/i);
  const spoken = await page.evaluate(() => window.__rider.spoken);
  expect(spoken.join(" | ")).toMatch(/lost g p s|signal/i);
  // and the street name is left alone rather than overwritten and clipped
  await expect(page.locator("#nav-street")).not.toContainText(/unavailable/i);
});

test("a useless fix doesn't garble the distance to the turn", async ({ page }) => {
  const path = await startNav(page);
  await ride(page, path, { speedKmh: 12, timeScale: 20, untilM: 250 });
  const good = (await page.locator("#nav-dist").textContent()) ?? "";
  // 120 m accuracy: the readout used to bounce 40 -> now -> 100 m
  const seen = new Set<string>([good]);
  for (let i = 0; i < 8; i++) {
    await page.evaluate(
      (p) => window.__rider.setFix({ lon: p[0], lat: p[1], accuracy: 120, speed: 3, heading: 90 }),
      [(path[20] as [number, number])[0] + i * 0.0004, (path[20] as [number, number])[1]] as [
        number,
        number,
      ],
    );
    await page.waitForTimeout(80);
    seen.add((await page.locator("#nav-dist").textContent()) ?? "");
  }
  // the reading is held, and the rider is told the signal is poor
  expect(seen.size).toBe(1);
  await expect(page.locator("#nav-alert")).toContainText(/poor/i);
});

// ── recovery ──────────────────────────────────────────────────────────────

test("starting a second ride from the old destination still guides", async ({ page }) => {
  const path = await startNav(page);
  // arrive, end, then set off again while standing at the destination
  await ride(page, path, { speedKmh: 20, timeScale: 90 });
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  await page.locator("#nav-exit").click();
  await page.locator("#nav-ask-yes").click();
  await expect(page.locator("#nav-banner")).not.toBeVisible();

  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-banner")).toBeVisible();
  await ride(page, path, { speedKmh: 14, timeScale: 40, untilM: 400 });
  // it used to latch "arrived!" on the first fix and never update again
  await expect(page.locator("#nav-dist")).not.toContainText(/arrived/i);
  await expect(page.locator("#nav-remaining")).toContainText(/min/);
});

test("a turn you overshoot and come back to is called again", async ({ page }) => {
  const path = await startNav(page);
  await ride(page, path, { speedKmh: 12, timeScale: 20, untilM: 320 });
  const before = await page.evaluate(() => window.__rider.spoken.length);
  // double back past the turn, then approach it again
  await ride(page, path, { speedKmh: 12, timeScale: 20, untilM: 200 });
  await ride(page, path, { speedKmh: 12, timeScale: 20, untilM: 340 });
  const after = await page.evaluate(() => window.__rider.spoken);
  // navNext only ever advanced, so the missed turn was never announced again
  expect(after.length).toBeGreaterThan(before);
});

// ── nothing may cover the guidance ────────────────────────────────────────

test("update banners stay out of the way while navigating", async ({ page }) => {
  await startNav(page);
  const hidden = await page.evaluate(() => {
    const vis = (id: string): string => {
      const el = document.getElementById(id);
      return el ? getComputedStyle(el).display : "missing";
    };
    return { update: vis("update-banner"), data: vis("data-update") };
  });
  // measured 17,040 px² over the banner, and the chevron resolved to the
  // banner's dismiss button
  expect(hidden.update).toBe("none");
  expect(hidden.data).toBe("none");
});

test("the safety network is dimmed so the route is the obvious line", async ({ page }) => {
  await startNav(page);
  const opacity = await page.evaluate(
    () => window._map?.getPaintProperty("network", "line-opacity") as number,
  );
  expect(opacity).toBeLessThan(0.6);
});

// ── dialogs and popups ────────────────────────────────────────────────────

test("the hazard dialog fits the phone and can be dismissed by tapping outside", async ({
  page,
}) => {
  // The full form is the planning-map path now — riding files the report in one
  // tap and asks afterwards (see the one-tap test). It still has to fit a phone,
  // because that's the screen it's filled in on.
  await plan(page);
  // the network has to be painted before a pixel of it can be right-clicked:
  // asking once, straight after boot, is a race this test kept losing under load
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window._map?.queryRenderedFeatures(undefined, { layers: ["network-hit"] }).length ?? 0,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  const pt = await page.evaluate(() => {
    const map = window._map;
    if (!map) return null;
    const hit = map.queryRenderedFeatures(undefined, { layers: ["network-hit"] })[0];
    if (!hit || hit.geometry.type !== "LineString") return null;
    const p = map.project(hit.geometry.coordinates[0] as [number, number]);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  expect(pt).not.toBeNull();
  if (!pt) return;
  await page.mouse.click(pt.x, pt.y, { button: "right" });
  await page.locator(".maplibregl-popup button", { hasText: "report hazard" }).click();
  const box = await page.locator("#hazard").boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  // it was 398 px wide on a 390 px screen, hanging off the side
  expect(box.width).toBeLessThanOrEqual(390);
  // its inputs were 21 px tall — the phone rule only covered input[type=search]
  const shortest = await page.evaluate(() =>
    Math.min(
      ...[...document.querySelectorAll("#hazard input, #hazard select")].map(
        (i) => i.getBoundingClientRect().height,
      ),
    ),
  );
  expect(shortest).toBeGreaterThanOrEqual(36);
  // it says where you are in words, not decimal degrees
  await expect(page.locator("#hazard")).not.toContainText(/-71\.\d{4}/);
  // and tap-outside closes it, like the other two dialogs
  await page.mouse.click(10, 10);
  await expect(page.locator("#hazard")).not.toBeVisible();
});

test("marking a hazard twice in one spot doesn't write it twice", async ({ page }) => {
  const path = await startNav(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 150 });
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  await page.locator("#nav-hazard").click();
  await expect(page.locator("#nav-alert")).toContainText(/marked/i);
  await page.locator("#nav-hazard").click();
  await page.locator("#nav-hazard").click();
  const marks = await page.evaluate(
    () => (JSON.parse(localStorage.getItem("sketchyMarks") ?? "[]") as unknown[]).length,
  );
  expect(marks).toBe(1);
});

test("the street card can be dismissed and doesn't mention right-clicking on touch", async ({
  browser,
}) => {
  // a real touch context: the popup appeared from an ordinary pan or pinch and
  // could not be closed, and told the rider to right-click
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 90_000,
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window._map?.queryRenderedFeatures(undefined, { layers: ["network-hit"] }).length ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const pt = await page.evaluate(() => {
    const map = window._map;
    if (!map) return null;
    const all = map.queryRenderedFeatures(undefined, { layers: ["network-hit"] });
    for (const f of all) {
      if (f.geometry.type !== "LineString") continue;
      const p = map.project(f.geometry.coordinates[0] as [number, number]);
      if (p.x > 40 && p.x < 350 && p.y > 60 && p.y < 380) return { x: Math.round(p.x), y: Math.round(p.y) };
    }
    return null;
  });
  if (pt) {
    await page.mouse.move(pt.x, pt.y, { steps: 3 });
    const popup = page.locator(".maplibregl-popup").first();
    if (await popup.isVisible().catch(() => false)) {
      await expect(popup).not.toContainText(/right-click/i);
      await expect(page.locator(".maplibregl-popup-close-button").first()).toBeVisible();
    }
  }
  await ctx.close();
});

// ── the seven that were open after the first sweep ────────────────────────

test("street names stay upright: the basemap's own labels are off while riding", async ({
  page,
}) => {
  const path = await startNav(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 200 });
  const vis = await page.evaluate(() => {
    const m = window._map;
    const v = (id: string): string =>
      (m?.getLayoutProperty(id, "visibility") as string | undefined) ?? "visible";
    return { osm: v("osm"), plain: v("osm-plain"), labels: v("street-labels") };
  });
  // raster tiles rotate as pictures, so their labels rode upside-down
  expect(vis.osm).toBe("none");
  expect(vis.plain).toBe("visible");
  expect(vis.labels).toBe("visible");
  // and ours are really drawn — the glyphs resolve and text is placed. Another
  // resource wait: a glyph fetch plus symbol placement, on a machine running
  // four of these at once, where a 16 s test stretches past a minute.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window._map?.queryRenderedFeatures(undefined, { layers: ["street-labels"] }).length ??
            0,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  // leaving the ride puts the ordinary basemap back
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  await page.locator("#nav-exit").click();
  await page.locator("#nav-ask-yes").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window._map?.getLayoutProperty("osm", "visibility") as string) ?? "visible",
      ),
    )
    .toBe("visible");
});

test("the street name reads as part of the instruction, not a caption", async ({ page }) => {
  const path = await startNav(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 200 });
  const size = await page.evaluate(() => {
    const px = (id: string): number =>
      parseFloat(getComputedStyle(document.getElementById(id) as HTMLElement).fontSize);
    return { dist: px("nav-dist"), street: px("nav-street") };
  });
  // it was 16 px against 34 px: a caption beside a headline
  expect(size.street).toBeGreaterThanOrEqual(19);
  expect(size.street / size.dist).toBeGreaterThan(0.6);
  // the distance is still the biggest thing, because it's the cue you act on
  expect(size.dist).toBeGreaterThan(size.street);
});

test("reporting a hazard mid-ride is one tap, and the question comes after", async ({ page }) => {
  const path = await startNav(page);
  await ride(page, path, { speedKmh: 12, timeScale: 30, untilM: 200 });
  await page.locator("#nav-banner").click({ position: { x: 40, y: 60 } });
  await page.locator("#nav-report").click();
  // no form at 12 km/h
  await expect(page.locator("#hazard")).not.toHaveAttribute("open", "");
  await expect(page.locator("#nav-alert")).toContainText(/reported/i);
  const count = async (): Promise<number> =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const req = indexedDB.open("bike-hazards", 1);
          req.onsuccess = () => {
            const all = req.result.transaction("hazards", "readonly").objectStore("hazards").getAll();
            all.onsuccess = () => {
              resolve((all.result as unknown[]).length);
            };
          };
          req.onerror = () => {
            resolve(-1);
          };
        }),
    );
  await expect.poll(count, { timeout: 10_000 }).toBe(1);
  // then it asks what it was, in one tap each
  await expect(page.locator("#nav-classify")).toBeVisible();
  const cats = page.locator("#nav-classify button");
  expect(await cats.count()).toBe(3);
  const boxes = [];
  for (const b of await cats.all()) {
    const box = await b.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
    if (box) boxes.push(box);
  }
  // same mis-tap rule as the tool row: these are answered at 12 km/h
  for (let i = 1; i < boxes.length; i++) {
    const prev = boxes[i - 1];
    const cur = boxes[i];
    if (!prev || !cur) continue;
    expect(cur.x - (prev.x + prev.width)).toBeGreaterThanOrEqual(8);
  }
  // tapping again before answering must not file a second report
  await page.locator("#nav-report").click();
  await expect(page.locator("#nav-alert")).toContainText(/already reported/i);
  expect(await count()).toBe(1);

  await page.locator('#nav-classify button[data-cat="surface"]').click();
  await expect(page.locator("#nav-alert")).toContainText(/broken surface/i);
  await expect(page.locator("#nav-classify")).toBeHidden();
});

test("the voice and the banner say the same distance", async ({ page }) => {
  const path = await startNav(page);
  const shown = new Set<string>();
  await ride(page, path, {
    speedKmh: 13,
    timeScale: 25,
    untilM: 1400,
    onFix: async () => {
      const t = (await page.locator("#nav-dist").textContent()) ?? "";
      if (t !== "") shown.add(t.trim());
    },
  });
  const spoken = await page.evaluate(() => window.__rider.spoken);
  // Unit-aware: the app speaks and shows miles and feet by default now, and the
  // point of this test is that the two agree — not which system they agree in.
  const said = spoken.flatMap((p) =>
    [...p.matchAll(/in ([\d.]+) (feet|meters|miles?|kilometers?)/g)].map((m) => ({
      n: m[1] ?? "",
      unit: m[2] ?? "",
    })),
  );
  expect(said.length, `nothing spoken with a distance in it: ${spoken.join(" | ")}`).toBeGreaterThan(
    0,
  );
  const abbrev: Record<string, string> = {
    feet: "ft",
    meters: "m",
    mile: "mi",
    miles: "mi",
    kilometer: "km",
    kilometers: "km",
  };
  // riders heard "in three hundred metres" against a banner reading 280 m
  for (const { n, unit } of said) {
    expect([...shown]).toContain(`${n} ${abbrev[unit] ?? unit}`);
  }
});

test("a phone that can't speak says so instead of just going quiet", async ({ page }) => {
  // Android's WebView has speechSynthesis but no voices: speak() returns
  // without a sound, without an error, and never fires onend. The ride used to
  // continue in silence, which reads exactly like "no turn coming up".
  await installRider(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak: () => undefined,
        cancel: () => undefined,
        getVoices: () => [],
        speaking: false,
      },
    });
  });
  await page.goto(`/${DAVIS_KENDALL}`);
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, {
    timeout: 90_000,
  });
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("#nav-btn").click();
  await expect(page.locator("#nav-alert")).toContainText(/no voice/i, { timeout: 15_000 });
  await expect(page.locator("#nav-alert")).toContainText(/watch the screen/i);
  // and guidance carries on rather than stalling behind a queue that never drains
  await expect(page.locator("#nav-dist")).not.toBeEmpty();
});

test("on a phone the about button survives the sheet hiding the title", async ({ page }) => {
  // the phone layout drops #panel h1 and the hint to save sheet space, which is
  // exactly where the footer button is unreachable — so the header one has to
  // outlive its own row's title
  await plan(page);
  await expect(page.locator("#panel h1")).toBeHidden();
  const info = page.locator("#about-top");
  await expect(info).toBeVisible();
  const box = await info.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  // inside the 390-wide viewport, and a thumb-sized target
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(32);
  await info.click();
  await expect(page.locator("#about")).toBeVisible();
  const dialog = await page.locator("#about").boundingBox();
  expect(dialog?.width ?? 999).toBeLessThanOrEqual(390);
});
