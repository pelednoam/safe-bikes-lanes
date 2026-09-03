// ---------------------------------------------------------------------------
// Carto's vector basemaps — and why this app stopped using their raster ones.
//
// As of September 2026 the raster tiles at basemaps.cartocdn.com/light_all
// (and dark_all, light_nolabels, dark_nolabels) come back with "API KEY
// REQUIRED / carto.com/basemaps/apikey" stamped diagonally across the image.
// Nothing 404s and nothing throws: the watermark is baked into the PNG, so a
// health check that reads the status code and the content type sees a perfectly
// good tile. The only way to catch this class of breakage is to look at the
// pixels.
//
// Carto's *vector* basemaps are still key-free and unstamped, and positron and
// dark-matter are the very styles those raster tiles were rendered from — so
// the map keeps the look it had rather than being approximated by another
// vendor.
//
// Each theme's layers are injected once and then toggled by visibility, rather
// than swapped with map.setStyle, which would tear down and re-add every layer
// this app puts on top — the route, the network, the overlays — on each flip.
// Label-free mode is the same layers with the symbol ones hidden.
// ---------------------------------------------------------------------------
/**
 * The vector tiles behind every Carto GL style (OpenMapTiles schema), named
 * directly rather than through their TileJSON.
 *
 * Declaring the source with `url` costs a round trip, and worse, makes the
 * whole style — and so map.on("load"), and so every layer a page adds in that
 * handler — wait on Carto answering. A page's own map is not Carto's to hold
 * up: named inline, those layers exist immediately and still exist if Carto
 * never answers at all.
 *
 * Carto serves these from four hosts and MapLibre picks one per tile; the
 * service worker folds them back into a single cache key (see tileKey in
 * sw.js), so an offline route cached against one host is found whichever host
 * is asked for next.
 */
export const CARTO_TILES = [
    "https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt",
    "https://tiles-b.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt",
    "https://tiles-c.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt",
    "https://tiles-d.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt",
];
export const CARTO_ATTRIBUTION = "© OpenStreetMap contributors © CARTO";
/** Vector tiles stop here; MapLibre overzooms them for closer views. Caching
 * for offline use only needs to go this deep — see routeTileUrls. */
export const CARTO_MAXZOOM = 14;
/** Carto's own glyph server, for pages that do not vendor their glyphs. See
 * VENDORED_FONT_STACK for why the planner cannot use it. */
export const CARTO_GLYPHS = "https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf";
const STYLE_URL = {
    light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};
/** The same basemaps with no symbol layers at all, for a page whose subject is
 * its own streets and whose basemap should stay quiet under them. */
export const NOLABEL_STYLE_URL = {
    light: "https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json",
    dark: "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json",
};
/**
 * The one glyph stack this app ships (web/fonts/glyphs, Noto Sans, Latin +
 * Latin-1).
 *
 * A style gets exactly one `glyphs` URL, and this app's has to stay the
 * vendored one: ride-mode street names are drawn from a symbol layer and have
 * to keep working with no network. Carto's own stacks name five fonts each
 * ("Montserrat Medium,Open Sans Bold,Noto Sans Regular,...") and MapLibre asks
 * its glyph server for that entire joined string as a single fontstack, which
 * the vendored directory does not have. Left alone, every basemap label would
 * request a range that 404s and simply not draw — no error, no missing tile,
 * just a map with no names on it.
 *
 * Every one of Carto's stacks already falls back to Noto Sans Regular, so
 * pointing them straight at it is the same typeface they intended, served
 * locally.
 */
export const VENDORED_FONT_STACK = ["Noto Sans Regular"];
/** Layers drawing an icon out of Carto's sprite. They are the low-zoom city
 * dots (z<8), invisible at any zoom this app opens at, and dropping them means
 * the style needs no sprite — one fewer external URL to allow and to cache. */
const SPRITE_LAYERS = /_dot_/;
const layerId = (theme, id) => `bm-${theme}-${id}`;
/** Re-identify, re-font and hide one theme's layers. */
function themeLayers(theme, style, textFont) {
    const out = [];
    for (const src of style.layers) {
        if (SPRITE_LAYERS.test(src.id))
            continue;
        // A LayerSpecification is a union discriminated on `type`; spreading and
        // re-typing keeps that narrowing rather than widening every branch.
        const layer = { ...src, id: layerId(theme, src.id) };
        const layout = { ...layer.layout };
        layout["visibility"] = "none";
        if (textFont !== undefined && layout["text-font"] !== undefined) {
            layout["text-font"] = textFont;
        }
        out.push({ ...layer, layout });
    }
    return out;
}
async function fetchStyle(url) {
    const resp = await fetch(url);
    if (!resp.ok)
        throw new Error(`carto style ${resp.status}`);
    return (await resp.json());
}
export function createBasemap(map, anchor, options = {}) {
    const styleUrl = options.styles ?? STYLE_URL;
    const textFont = options.textFont;
    const fetchJson = options.fetchJson ?? fetchStyle;
    const installed = new Map();
    const inflight = new Map();
    /** The most recent show() request, re-applied when the label layers land. */
    let wanted = null;
    const ensure = (theme) => {
        const pending = inflight.get(theme);
        if (pending)
            return pending;
        const job = (async () => {
            const style = await fetchJson(styleUrl[theme]);
            const group = { all: [], labels: new Set() };
            installed.set(theme, group);
            const beforeId = anchor();
            const add = (layer) => {
                // Adding before a layer that has gone (a style reload mid-flight) would
                // throw and take the caller's chain with it; appending is the safe miss.
                map.addLayer(layer, beforeId !== undefined && map.getLayer(beforeId) ? beforeId : undefined);
                group.all.push(layer.id);
                if (layer.type === "symbol")
                    group.labels.add(layer.id);
            };
            // Every layer in one synchronous pass. MapLibre re-lays-out each loaded
            // tile against the whole layer list whenever that list changes, so
            // splitting this in two — lines first, labels once the map settled —
            // bought nothing and paid for a second full pass over every tile.
            for (const layer of themeLayers(theme, style, textFont))
                add(layer);
            // Visibility has to match whatever was asked for while the style was
            // still on its way, or the basemap arrives stuck hidden — or, worse,
            // shows its labels in the middle of a ride, which is what plain mode
            // exists to prevent.
            if (wanted)
                show(wanted);
        })();
        inflight.set(theme, job);
        // A failed fetch must not be remembered as done, or the basemap never
        // recovers when the network comes back.
        job.catch(() => inflight.delete(theme));
        return job;
    };
    const show = (opts) => {
        wanted = opts;
        for (const [theme, group] of installed) {
            const active = opts.on && theme === opts.theme;
            for (const id of group.all) {
                if (map.getLayer(id) === undefined)
                    continue;
                const visible = active && (opts.labels || !group.labels.has(id));
                map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
            }
        }
    };
    return { ensure, show };
}
