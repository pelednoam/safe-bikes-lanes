// The service worker precaches the app shell by a list, half written by hand
// (public/sw.js) and half by the build (vite.config.ts writes in everything
// the planner page loads from its bundle). scripts/check-dist.mjs checks the
// built result on every build. This checks the half written by hand.
//
// It used to walk src/'s imports and hold a hand-kept list of modules to them:
// the list had four of thirteen modules, then missed search.js, which is the
// kind of list the build now writes instead.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(WEB, "public");

/** The hand-written entries of public/sw.js's ASSETS, comments left out. */
function listedAssets(): { entries: string[]; body: string } {
  const sw = readFileSync(join(PUBLIC, "sw.js"), "utf8");
  const block = /const ASSETS = \[(?<body>[\s\S]*?)\];/.exec(sw);
  expect(block?.groups?.["body"], "could not find ASSETS in sw.js").toBeTruthy();
  const body = block?.groups?.["body"] ?? "";
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return { entries: [...code.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string), body };
}

describe("the offline shell", () => {
  it("leaves room for the build to write in the planner's own files", () => {
    // without the marker the precache plugin fails the build; this says why sooner
    expect(listedAssets().body).toContain("/* BUILD_ASSETS */");
  });

  it("precaches the page, and the notice that runs when the app can't", () => {
    const { entries } = listedAssets();
    for (const a of [".", "index.html", "compat.js", "manifest.json"]) expect(entries).toContain(a);
  });

  it("lists only files that exist, or arrive with the data or the build", () => {
    // A listed file that 404s makes the whole install fail: cache.addAll
    // rejects, taking offline support down with it rather than degrading.
    const vendoredAtBuild = new Set([
      "maplibre-gl.mjs",
      "maplibre-gl-shared.mjs",
      "maplibre-gl-worker.mjs",
      "maplibre-gl.css",
    ]);
    const missing = listedAssets().entries.filter(
      (a) =>
        a !== "." &&
        a !== "index.html" && // the page itself, at web/, built into dist/
        !a.startsWith("data/") && // the data snapshot, unpacked beside the build
        !vendoredAtBuild.has(a) &&
        !existsSync(join(PUBLIC, a)),
    );
    expect(missing, "listed for precache but not in public/").toEqual([]);
  });

  it("precaches every file MapLibre loads, and vendors each of them", () => {
    // maplibre-gl.mjs imports a shared chunk and starts a worker from its own
    // URL. Read from the installed package, so a MapLibre release that splits
    // its bundle differently fails here rather than on a first offline load.
    const main = readFileSync(join(WEB, "node_modules/maplibre-gl/dist/maplibre-gl.mjs"), "utf8");
    const loaded = [...main.matchAll(/(maplibre-gl-[\w-]+\.mjs)/g)]
      .map((m) => m[1] as string)
      .filter((f) => !f.includes("-dev")); // the development build's, never served
    expect(loaded, "maplibre-gl.mjs no longer names its chunks; update this test").toContain(
      "maplibre-gl-worker.mjs",
    );
    const { entries } = listedAssets();
    const pkg = readFileSync(join(WEB, "package.json"), "utf8");
    for (const f of new Set(["maplibre-gl.mjs", ...loaded])) {
      expect(entries, `MapLibre loads ${f}, and offline it would 404`).toContain(f);
      expect(pkg, `npm run vendor does not copy ${f} into public/`).toContain(f);
    }
  });

  it("vendors a glyph range for every character the map's labels are known to use", () => {
    // MapLibre asks for glyphs in 256-codepoint ranges, and a range that 404s
    // does not degrade to a missing character: the tile's labels fail to lay
    // out. Only 0-255 and 256-511 were vendored, so any name with a typographic
    // apostrophe (St. Paul’s Choir School is one of the POIs), an en dash or an
    // ellipsis asked for 8192-8447 and got a 404. The network names mountain
    // bike trails by their difficulty marks (Sledgehammer (■), Hells Gate
    // (♦♦)), which live two ranges further up. Precached too, because street
    // names during a ride are the labels that most need to work offline.
    const { entries } = listedAssets();
    const stack = "fonts/glyphs/Noto Sans Regular";
    for (const ch of ["é", "ō", "’", "–", "…", "“", "■", "♦"]) {
      const cp = ch.codePointAt(0) ?? 0;
      const start = Math.floor(cp / 256) * 256;
      const file = `${stack}/${start}-${start + 255}.pbf`;
      expect(existsSync(join(PUBLIC, file)), `${ch} needs ${file}, which is not vendored`).toBe(true);
      expect(entries, `${file} is vendored but not precached for offline`).toContain(file);
    }
  });

  it("precaches exactly the glyph ranges that are vendored", () => {
    // The other direction: a listed range that does not exist makes cache.addAll
    // reject, which takes the whole offline install down with it.
    const dir = join(PUBLIC, "fonts/glyphs/Noto Sans Regular");
    const vendored = readdirSync(dir)
      .filter((f) => f.endsWith(".pbf"))
      .map((f) => `fonts/glyphs/Noto Sans Regular/${f}`)
      .sort();
    const listed = listedAssets()
      .entries.filter((a) => a.startsWith("fonts/glyphs/"))
      .sort();
    expect(listed).toEqual(vendored);
  });
});
