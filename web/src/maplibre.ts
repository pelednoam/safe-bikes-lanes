// The one door to MapLibre.
//
// MapLibre 6 ships only as ES modules: maplibre-gl.mjs, which imports
// maplibre-gl-shared.mjs and starts maplibre-gl-worker.mjs as a module worker
// from its own URL. All three are vendored into public/ (npm run vendor) and so
// sit at the root of the built site, next to every page's bundle, where this
// relative import resolves. Vite leaves the import alone (external in
// vite.config.ts): a bundler can't follow the worker URL MapLibre builds at
// runtime. Up to MapLibre 4 every page loaded a UMD build with a plain <script>
// that defined a global instead.
//
// Only the page entry points import this. The modules they share must stay
// importable in unit tests, where there is no map and no maplibre-gl.mjs, so
// basemap.ts reads addProtocol from the global this sets rather than importing
// it.
// The package name, kept external and written out as ./maplibre-gl.mjs
// (vite.config.ts): every bundle sits at the site root, beside it.
import * as maplibregl from "maplibre-gl";

(globalThis as { maplibregl?: typeof maplibregl }).maplibregl = maplibregl;

export { maplibregl };
