// The one door to MapLibre.
//
// MapLibre 6 ships only as ES modules: maplibre-gl.mjs, which imports
// maplibre-gl-shared.mjs and starts maplibre-gl-worker.mjs as a module worker
// from its own URL. All three are vendored next to the compiled pages (npm run
// vendor), so this relative import resolves for app.js, build.js and city.js
// alike. Up to MapLibre 4 every page loaded a UMD build with a plain <script>
// that defined a global instead.
//
// Only the page entry points import this. The modules they share must stay
// importable in unit tests, where there is no map and no maplibre-gl.mjs, so
// basemap.ts reads addProtocol from the global this sets rather than importing
// it.
import * as maplibregl from "./maplibre-gl.mjs";

(globalThis as { maplibregl?: typeof maplibregl }).maplibregl = maplibregl;

export { maplibregl };
