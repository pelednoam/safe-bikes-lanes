// Not part of the suite's assertions: measures how much of the shipped app.js
// a broad session executes, so "covered by E2E" is a number rather than a claim.
import { writeFileSync } from "node:fs";

import { expect, test } from "@playwright/test";
import type { Map as MLMap } from "maplibre-gl";

declare global { interface Window { _map?: MLMap } }

test("app.js executed across a broad session", async ({ page }) => {
  test.slow();
  await page.coverage.startJSCoverage();
  const tap = async (sel: string): Promise<void> => {
    await page.locator(sel).click({ timeout: 4000 }).catch(() => undefined);
  };

  // plan a trip
  await page.goto("/#s=-71.122258,42.396748&e=-71.086705,42.362552&m=young_kids");
  await page.waitForFunction(() => window._map !== undefined && window._map.loaded(), null, { timeout: 45000 });
  // Generous because V8 coverage instrumentation is running: it slows the
  // router's Dijkstras enough that the same route which computes in seconds
  // normally can take a minute here. This file measures; it does not assert.
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 120000 });
  await page.locator(".option-card").last().click().catch(() => undefined);

  // the destination search: local index, geocoder merge, keyboard, and the
  // ungraded-row path — the newest wiring in this file
  for (const q of ["m", "ma", "mass ave", "playgr", "kennedy", "xyzzynotaplace"]) {
    await page.locator("#search").fill(q);
    await page.waitForTimeout(350);
  }
  await page.locator("#search").press("ArrowDown");
  await page.locator("#search").press("ArrowUp");
  await page.locator("#search").press("Escape");
  await page.locator("#search").press("ArrowDown");
  await page.locator("#search").press("Enter");
  await page.waitForTimeout(800);
  // the start picker, whose rows are never graded
  await page.locator("#from-field").fill("elm");
  await page.waitForTimeout(600);
  await page.locator("#from-field").fill("");

  // which build this is, and whether the site has a newer one
  await tap("#about-top");
  await page.waitForTimeout(400);
  await tap("#about-close");

  // preferences, modes, swap
  await tap('summary:has-text("Preferences")');
  await page.locator("#avoid-busy_street").check().catch(() => undefined);
  await page.locator("#prefer-flat").check().catch(() => undefined);
  await page.locator('#modes label:has-text("solo")').click().catch(() => undefined);
  await tap("#swap");
  await page.waitForTimeout(1500);

  // every overlay
  await tap('summary:has-text("Map layers")');
  for (const id of ["#show-heat", "#show-elev", "#show-lanes", "#show-3d", "#dark-mode",
                    "#show-aerial", "#show-constr", "#show-pois", "#show-gates",
                    "#show-access", "#show-build"]) {
    await page.locator(id).check().catch(() => undefined);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(2500);

  // the city view, what-if, and the one-pager path
  await tap("#build-box > summary");
  await page.waitForTimeout(2000);
  await page.locator(".build-row").first().click().catch(() => undefined);
  // The what-if re-routes the whole trip with upgraded edges. Under V8 coverage
  // instrumentation that was enough to kill the page — "target closed" partway
  // through — and a crashed page reports no coverage at all, so this tool measured
  // nothing. Its own behaviour is covered by tests-e2e/build.spec.ts.
  await page.waitForTimeout(500);

  // export, other trip types, dialogs
  await tap('summary:has-text("Export")');
  await tap('summary:has-text("Other trip types")');
  await tap("#loop-btn");
  await page.waitForTimeout(2000);
  await tap("#shed-btn");
  await page.waitForTimeout(1500);
  await tap("#rides-btn");
  await tap("#rides-close");
  await tap("#about-top");
  await tap("#about-close");

  // navigation
  await tap("#nav-btn");
  await page.waitForTimeout(1500);
  await tap("#nav-stops");
  await tap("#nav-mute");
  await tap("#nav-exit");
  await tap("#nav-ask-yes");
  await page.waitForTimeout(800);

  const cov = await page.coverage.stopJSCoverage();
  let total = 0, uncovered = 0;
  for (const entry of cov.filter((e) => e.url.endsWith("/app.js"))) {
    total += entry.source?.length ?? 0;
    const dead = entry.functions
      .flatMap((f) => f.ranges.filter((r) => r.count === 0))
      .sort((a, b) => a.startOffset - b.startOffset);
    let cursor = 0;
    for (const r of dead) {
      const start = Math.max(cursor, r.startOffset);
      if (r.endOffset > start) { uncovered += r.endOffset - start; cursor = r.endOffset; }
    }
  }
  const pct = total ? (100 * (total - uncovered)) / total : 0;
  writeFileSync("/tmp/app-coverage.json", JSON.stringify({ total, used: total - uncovered, pct }));
  console.log(`app.js executed: ${(total - uncovered)}/${total} bytes = ${pct.toFixed(1)}%`);
});
