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
  await expect(page.locator(".option-card").first()).toBeVisible({ timeout: 30000 });
  await page.locator(".option-card").last().click().catch(() => undefined);

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
  await tap("#whatif-run");
  await page.waitForTimeout(2500);
  await tap("#whatif-clear");

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
  await tap("#nav-toggle");
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
