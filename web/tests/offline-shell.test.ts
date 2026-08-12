// The service worker precaches the app shell by an explicit list of files.
//
// A list maintained by hand next to an import graph that changes is a list that
// drifts. It had four of the thirteen modules app.js imports; the other nine were
// being cached opportunistically by the fetch handler, which only works if the
// page finishes loading them before the network goes away. A module added later —
// search.js was, today — is precisely the one a first offline load would be
// missing, and the app would fail to start with no explanation.
//
// So the list is checked against the imports rather than trusted.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

function precachedAssets(): string[] {
  const sw = readFileSync(join(WEB, "sw.js"), "utf8");
  const block = /const ASSETS = \[(?<body>[\s\S]*?)\];/.exec(sw);
  expect(block?.groups?.["body"], "could not find ASSETS in sw.js").toBeTruthy();
  return [...(block?.groups?.["body"] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

/** Every local module reachable from app.ts, as the .js files the browser asks for. */
function importedModules(): string[] {
  const seen = new Set<string>();
  const queue = ["app.ts"];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(join(WEB, "src", file), "utf8");
    } catch {
      continue; // not one of ours
    }
    for (const m of source.matchAll(/from "\.\/([a-z0-9-]+)\.js"/g)) {
      queue.push(`${m[1] as string}.ts`);
    }
  }
  seen.delete("app.ts");
  return [...seen].map((f) => f.replace(/\.ts$/, ".js")).sort();
}

describe("the offline shell", () => {
  it("precaches every module the app imports", () => {
    const assets = precachedAssets();
    const missing = importedModules().filter((m) => !assets.includes(m));
    expect(
      missing,
      "these modules are imported but not precached, so a first offline load " +
        "would fail to start the app with no explanation",
    ).toEqual([]);
  });

  it("precaches app.js itself, and the page that loads it", () => {
    const assets = precachedAssets();
    expect(assets).toContain("app.js");
    expect(assets).toContain("index.html");
    expect(assets).toContain(".");
  });

  it("does not list modules that no longer exist", () => {
    // The other direction: a file removed from src/ but left in ASSETS makes
    // install fail entirely, because cache.addAll rejects if any request 404s —
    // taking offline support down with it rather than degrading.
    const modules = new Set(importedModules());
    const stale = precachedAssets().filter(
      (a) => /^[a-z0-9-]+\.js$/.test(a) && a !== "app.js" && !modules.has(a),
    );
    expect(stale, "listed for precache but not imported by the app").toEqual([]);
  });

  it("keeps the fonts the map needs to label streets mid-ride", () => {
    // Learned the hard way: without the glyph ranges, street names during a ride
    // fail silently — the symbol layer just draws nothing.
    const assets = precachedAssets();
    expect(assets.some((a) => a.includes("glyphs"))).toBe(true);
    expect(assets.some((a) => a.endsWith(".woff2"))).toBe(true);
  });
});
