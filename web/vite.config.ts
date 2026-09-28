// The site's build: every page, bundled and content-hashed into dist/, which
// is what the deploy publishes, what the Android app bundles and what the
// browser tests serve.
//
// Before Vite, tsc compiled src/ into web/*.js, those files were committed,
// and hand-kept lists said what to copy and what the service worker should
// precache. Each list drifted at least once.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { defineConfig, type Plugin } from "vite";

const WEB = import.meta.dirname;
const OUT = "dist";

/** Every page: the planner, /build/, /install/, and each city page
 * (web/<slug>/index.html, written by pipeline/city_pages.py). A city page is
 * one that says so, with its city-slug meta tag: web/ also holds other
 * folders with an index.html in them (the unit-coverage report is one), and a
 * list of folders to skip is a list that misses the next one. */
function pages(): Record<string, string> {
  const input: Record<string, string> = {
    app: resolve(WEB, "index.html"),
    build: resolve(WEB, "build/index.html"),
    install: resolve(WEB, "install/index.html"),
  };
  for (const d of readdirSync(WEB, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const html = join(WEB, d.name, "index.html");
    if (existsSync(html) && readFileSync(html, "utf8").includes('<meta name="city-slug"')) {
      input[`city-${d.name}`] = html;
    }
  }
  return input;
}

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: WEB }).toString().trim();
  } catch {
    return "unknown";
  }
}

interface ManifestChunk {
  file: string;
  css?: string[];
  assets?: string[];
  imports?: string[];
}

/** Write what the planner page loads into the service worker's precache list.
 *
 * Read from Vite's own manifest: the entry's file, the chunks it imports, and
 * their CSS and assets (fonts). Written in where public/sw.js says
 * BUILD_ASSETS, so the list is complete by construction. */
function precache(): Plugin {
  return {
    name: "precache-planner",
    apply: "build",
    closeBundle() {
      const out = resolve(WEB, OUT);
      const manifestPath = join(out, ".vite", "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestChunk>;
      const files = new Set<string>();
      const walk = (key: string): void => {
        const chunk = manifest[key];
        if (chunk === undefined) throw new Error(`precache: ${key} is not in Vite's manifest`);
        if (files.has(chunk.file)) return;
        files.add(chunk.file);
        for (const f of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(f);
        for (const i of chunk.imports ?? []) walk(i);
      };
      walk("index.html");
      const swPath = join(out, "sw.js");
      const sw = readFileSync(swPath, "utf8");
      const marker = "/* BUILD_ASSETS */";
      if (!sw.includes(marker)) throw new Error("precache: public/sw.js has no BUILD_ASSETS marker");
      const sorted = [...files].sort();
      const list = sorted.map((f) => JSON.stringify(f)).join(",\n  ");
      // The shell cache is named for exactly what it holds: a new build is a
      // new cache, and the old one is deleted when it activates (public/sw.js).
      const idMarker = '/* BUILD_ID */ "dev"';
      if (!sw.includes(idMarker)) throw new Error("precache: public/sw.js has no BUILD_ID marker");
      // By content, not only by name: index.html and compat.js keep their names
      // from build to build, and a change to either is a new build too.
      const hash = createHash("sha256");
      for (const f of [...sorted, "index.html", "compat.js"]) {
        const path = join(out, f);
        hash.update(f).update(existsSync(path) ? readFileSync(path) : "");
      }
      const id = hash.digest("hex").slice(0, 12);
      writeFileSync(swPath, sw.replace(marker, `${list},`).replace(idMarker, JSON.stringify(id)));
      // the manifest was for this; it isn't part of the site
      rmSync(join(out, ".vite"), { recursive: true, force: true });
    },
  };
}

/** Keep pages from loading MapLibre themselves. Their bundles import it, from
 * the root, which is where it is. But Vite lists an entry's imports as tags
 * on its page too, and for pages that share one entry module (the city pages,
 * all src/city.ts) that included the external, as ./maplibre-gl.mjs relative
 * to /somerville/: a 404 on every city page. */
function noMapLibreTags(): Plugin {
  return {
    name: "no-maplibre-tags",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) =>
        html.replace(/[ \t]*<(script|link)\b[^>]*maplibre-gl\.mjs[^>]*>(<\/script>)?\n?/g, ""),
    },
  };
}

export default defineConfig({
  // relative everywhere: the site lives under /safe-bikes-lanes/ and the app
  // at https://localhost/, and the same build serves both
  base: "./",
  define: {
    __BUILD_VERSION__: JSON.stringify(process.env["APP_VERSION"] ?? "dev"),
    __BUILD_TIME__: JSON.stringify(
      process.env["BUILD_TIME"] ?? `${new Date().toISOString().slice(0, 19)}Z`,
    ),
    __BUILD_COMMIT__: JSON.stringify(process.env["BUILD_COMMIT"] ?? gitCommit()),
  },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    // Everything at the root, not under assets/: the bundles import MapLibre
    // as ./maplibre-gl.mjs (below), which has to be beside them.
    assetsDir: "",
    // the app's own floor; compat.js tells browsers below it so (public/compat.js)
    target: "es2020",
    manifest: true,
    rollupOptions: {
      input: pages(),
      // MapLibre stays outside the bundle, vendored whole into public/: it
      // starts its worker from a URL it computes at runtime from its own
      // location, which no bundler can follow. Exactly the package name: its
      // stylesheet (maplibre-gl/dist/maplibre-gl.css) is bundled like any other.
      external: ["maplibre-gl"],
      output: {
        // every bundle is at the root (assetsDir ""), beside the vendored file
        paths: { "maplibre-gl": "./maplibre-gl.mjs" },
      },
    },
  },
  plugins: [noMapLibreTags(), precache()],
});
