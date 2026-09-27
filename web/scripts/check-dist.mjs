// Checks the built site (dist/) before anything serves it: part of npm run build.
//
// The service worker's precache list is half written by hand (public/sw.js)
// and half written by the build (vite.config.ts). A first offline load needs
// every file on it to exist, and every file the planner loads to be on it.
// Getting either wrong fails silently, on the road, with no signal. So the
// build fails here instead.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const problems = [];

function precached() {
  const sw = readFileSync(join(DIST, "sw.js"), "utf8");
  const raw = /const ASSETS = \[(?<body>[\s\S]*?)\];/.exec(sw)?.groups?.["body"] ?? "";
  // entries only: the comments between them quote names too ("St. Paul’s")
  const block = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => (c.includes("BUILD_ASSETS") ? c : ""))
    .replace(/\/\/.*$/gm, "");
  if (block.includes("BUILD_ASSETS")) problems.push("sw.js: the build never wrote its assets in");
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function exists(rel) {
  try {
    return statSync(join(DIST, rel)).isFile();
  } catch {
    return false;
  }
}

/** Local files an HTML page loads: scripts, stylesheets, preloads, icons, manifest. */
function pageAssets(html) {
  const tags = html.match(/<(script|link)\b[^>]*>/g) ?? [];
  return tags
    .filter((t) => !/rel="?(canonical|alternate)"?/.test(t))
    .map((t) => /(?:src|href)="([^"]+)"/.exec(t)?.[1])
    .filter((u) => u !== undefined && !/^(https?:|data:|#|mailto:)/.test(u));
}

const assets = precached();

// 1. everything precached is there to fetch (data/ arrives with the snapshot)
for (const a of assets) {
  if (a === "." || a.startsWith("data/")) continue;
  if (!exists(a)) problems.push(`sw.js precaches ${a}, which the build doesn't have`);
}

// 2. everything the planner loads is precached, MapLibre's own chunks included
const plannerHtml = readFileSync(join(DIST, "index.html"), "utf8");
// its tags, and the fonts its inline <style> names
const plannerLoads = [
  ...pageAssets(plannerHtml),
  ...[...plannerHtml.matchAll(/url\(([^)"']+)\)/g)].map((m) => m[1]),
].map((u) => u.replace(/^\.\//, ""));
const maplibre = readFileSync(join(DIST, "maplibre-gl.mjs"), "utf8");
const maplibreLoads = [...maplibre.matchAll(/(maplibre-gl-[\w-]+\.mjs)/g)]
  .map((m) => m[1])
  .filter((f) => !f.includes("-dev"));
if (!maplibreLoads.includes("maplibre-gl-worker.mjs")) {
  problems.push("maplibre-gl.mjs no longer names its worker; update check-dist.mjs");
}
for (const a of new Set([...plannerLoads, "maplibre-gl.mjs", ...maplibreLoads])) {
  if (!assets.includes(a)) problems.push(`index.html loads ${a}, and sw.js doesn't precache it`);
  if (!exists(a)) problems.push(`index.html loads ${a}, which the build doesn't have`);
}

// 3. every page's local scripts and styles exist, relative to the page
function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === "data" ? [] : htmlFiles(p);
    return d.name.endsWith(".html") ? [p] : [];
  });
}
for (const page of htmlFiles(DIST)) {
  const rel = relative(DIST, page);
  for (const u of pageAssets(readFileSync(page, "utf8"))) {
    const target = relative(DIST, join(dirname(page), u.split("?")[0]));
    if (!exists(target)) problems.push(`${rel} loads ${u}, which the build doesn't have`);
  }
}

// 4. the build stamps were filled in
for (const f of readdirSync(DIST).filter((f) => f.endsWith(".js"))) {
  if (/__BUILD_(VERSION|TIME|COMMIT)__/.test(readFileSync(join(DIST, f), "utf8"))) {
    problems.push(`${f} still has a build-stamp placeholder`);
  }
}

if (problems.length > 0) {
  console.error(`dist/ is not fit to serve:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `dist/ checked: ${assets.length} precached, ${plannerLoads.length} planner files, ` +
    `${htmlFiles(DIST).length} pages`,
);
