// On-demand routing-graph tiles. The browser loads only the tiles covering a
// route's corridor (see pipeline/export_web.py export_tiles) instead of the
// whole 23 MB graph, so coverage can grow toward all of MA without an
// unbounded download. Loaded tiles are merged into one GraphData subset that
// the existing Router consumes unchanged — a tile is a self-contained
// sub-graph, and boundary nodes carry a stable GLOBAL id so tiles stitch
// together seamlessly when adjacent ones are loaded.
/** The fixed lon/lat grid shared by the routing and network tile sets. */
class TileGrid {
    constructor(originLon, originLat, tileDeg, tiles) {
        this.originLon = originLon;
        this.originLat = originLat;
        this.tileDeg = tileDeg;
        this.existing = new Set(tiles);
    }
    colRow(lon, lat) {
        return [
            Math.floor((lon - this.originLon) / this.tileDeg),
            Math.floor((lat - this.originLat) / this.tileDeg),
        ];
    }
    /** Existing tile keys covering the bbox, grown by `margin` cells each side. */
    keysForBBox(box, margin) {
        const [c0, r0] = this.colRow(box.west, box.south);
        const [c1, r1] = this.colRow(box.east, box.north);
        const keys = [];
        for (let c = c0 - margin; c <= c1 + margin; c++) {
            for (let r = r0 - margin; r <= r1 + margin; r++) {
                const key = `${c}_${r}`;
                if (this.existing.has(key))
                    keys.push(key);
            }
        }
        return keys;
    }
    /** Existing tile keys within `margin` cells of the straight line through
     * `points`. For a long trip the endpoints' bbox covers most of the map —
     * this walks the corridor instead, which is a small fraction of it. */
    keysForCorridor(points, margin) {
        const keys = new Set();
        const addAround = (lon, lat) => {
            const [c, r] = this.colRow(lon, lat);
            for (let dc = -margin; dc <= margin; dc++) {
                for (let dr = -margin; dr <= margin; dr++) {
                    const key = `${c + dc}_${r + dr}`;
                    if (this.existing.has(key))
                        keys.add(key);
                }
            }
        };
        for (let i = 0; i < points.length; i++) {
            const a = points[i];
            addAround(a[0], a[1]);
            const b = points[i + 1];
            if (!b)
                continue;
            // sample at half a cell so no cell along the line is skipped
            const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / (this.tileDeg / 2)));
            for (let s = 1; s <= steps; s++) {
                addAround(a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps);
            }
        }
        return [...keys];
    }
}
export class TileStore {
    constructor(fetchJson) {
        this.fetchJson = fetchJson;
        this.grid = null;
        this.classList = [];
        /** Every tile fetched this session, never evicted — deliberately, unlike
         * NetworkTiles. The Router is built over this whole set after
         * ensureCorridor returns, and a tile missing from the corridor does not fail
         * loudly: the route goes around the hole, or through worse streets beside it,
         * and is presented as the safest there is. ensureCorridor cannot keep its
         * tiles pinned until the caller assembles (its promise settles first, and
         * a search grades several routes while others load), and app.ts decides to
         * rebuild by comparing loadedCount, which evicting one tile and loading
         * another would leave unchanged. Bounding this needs the caller to hold the
         * pin across the rebuild; until then a long session costs memory, and each
         * rebuild costs time in proportion (a third of a second for 350 tiles in node). */
        this.loaded = new Map();
        this.inflight = new Map();
    }
    async loadManifest() {
        const m = await this.fetchJson("tiles/manifest.json");
        this.grid = new TileGrid(m.originLon, m.originLat, m.tileDeg, m.tiles);
        this.classList = m.classTable ?? m.classes;
    }
    get classes() {
        return this.classList;
    }
    /** Number of tiles held in memory — the Router only needs rebuilding when
     * this grows. */
    get loadedCount() {
        return this.loaded.size;
    }
    /** Existing tile keys covering the bbox, grown by `margin` tiles on each side
     * (safe routes often detour outside the straight A–B box). */
    keysForBBox(box, margin = 1) {
        if (!this.grid)
            throw new Error("tile manifest not loaded");
        return this.grid.keysForBBox(box, margin);
    }
    /** Fetch every not-yet-loaded tile covering the bbox. Returns true when at
     * least one new tile arrived (so the caller should rebuild its Router). */
    async ensure(box, margin = 1) {
        const keys = this.keysForBBox(box, margin);
        const before = this.loaded.size;
        await Promise.all(keys.map((k) => this.fetchTile(k)));
        return this.loaded.size > before;
    }
    /** Tile keys along the corridor through `points` (see TileGrid). */
    keysForCorridor(points, margin = 1) {
        if (!this.grid)
            throw new Error("tile manifest not loaded");
        return this.grid.keysForCorridor(points, margin);
    }
    /** Fetch the tiles along the corridor through `points`, rather than the
     * whole bounding box of them — a cross-metro trip would otherwise pull most
     * of the map. Returns true when at least one new tile arrived. */
    /** Load every tile along a corridor.
     *
     * onProgress reports (done, total) as each lands. The wait here is almost all
     * of what a rider experiences as "the app is thinking": a typical trip pulls
     * about 90 tiles, which is a couple of seconds on a laptop and a good deal
     * longer on a phone in the street. Reporting it is the difference between a
     * progress bar and an app that looks broken.
     */
    async ensureCorridor(points, margin = 1, onProgress) {
        const keys = this.keysForCorridor(points, margin);
        const before = this.loaded.size;
        let done = 0;
        onProgress?.(0, keys.length);
        await Promise.all(keys.map((k) => this.fetchTile(k).finally(() => {
            done++;
            onProgress?.(done, keys.length);
        })));
        return this.loaded.size > before;
    }
    async fetchTile(key) {
        if (this.loaded.has(key))
            return;
        const pending = this.inflight.get(key);
        if (pending)
            return pending;
        const p = this.fetchJson(`tiles/${key}.json`)
            .then((tile) => {
            this.loaded.set(key, tile);
        })
            .finally(() => {
            this.inflight.delete(key);
        });
        this.inflight.set(key, p);
        return p;
    }
    /** Merge every loaded tile into one GraphData the Router can consume.
     * Boundary nodes (shared global id) collapse to one; names and geoms are
     * re-tabled; class indices are already global (shared table). */
    assemble() {
        const classes = this.classes;
        const nodes = [];
        const nodeOf = new Map(); // global node id -> merged index
        const names = [];
        const nameOf = new Map();
        const geoms = [];
        const edges = [];
        const localName = (s) => {
            let i = nameOf.get(s);
            if (i === undefined) {
                i = names.length;
                names.push(s);
                nameOf.set(s, i);
            }
            return i;
        };
        for (const tile of this.loaded.values()) {
            const nodeMap = tile.nodeIds.map((gid, li) => {
                let mi = nodeOf.get(gid);
                if (mi === undefined) {
                    mi = nodes.length;
                    nodes.push(tile.nodes[li]);
                    nodeOf.set(gid, mi);
                }
                return mi;
            });
            for (const e of tile.edges) {
                let geomIdx = -1;
                if (e[5] >= 0) {
                    geomIdx = geoms.length;
                    geoms.push(tile.geoms[e[5]]);
                }
                edges.push([
                    nodeMap[e[0]],
                    nodeMap[e[1]],
                    e[2],
                    e[3],
                    localName(tile.names[e[4]] ?? ""),
                    geomIdx,
                    e[6],
                    e[7],
                    e[8],
                    e[9],
                    // the street's own class, a global index like e[3]; absent in old tiles
                    ...(e[10] === undefined ? [] : [e[10]]),
                ]);
            }
        }
        return { nodes, names, classes, edges, geoms };
    }
}
/** Viewport loader for the display network. Unlike the routing tiles (loaded
 * along a route's corridor), these load for whatever the map is showing, so
 * the coloured safety network only downloads the streets currently on screen.
 * visibleFeatures returns just the tiles the viewport covers, bounding what the
 * GL source has to render.
 *
 * Tiles stay cached, but not forever. This used to keep every tile it had ever
 * fetched, so an afternoon of panning around the metro held hundreds of them —
 * each about 110 KB of JSON before it is parsed — and every one was walked
 * again whenever the search's street list was rebuilt. It now keeps the
 * `maxTiles` most recently shown and lets older ones go. That is safe here in
 * a way it is not for the routing tiles (see TileStore): a caller only ever
 * reads the tiles of the view it just asked for, which are pinned from the
 * request until they are read, and a tile let go is simply fetched again (from
 * the service worker's cache when offline) if the map comes back to it. */
export class NetworkTiles {
    constructor(fetchJson, maxTiles = 512) {
        this.fetchJson = fetchJson;
        this.maxTiles = maxTiles;
        this.grid = null;
        /** In least- to most-recently-shown order: a tile moves to the end each time
         * a view includes it, so eviction takes from the front. */
        this.loaded = new Map();
        this.inflight = new Map();
        /** Tiles a visibleFeatures call has yet to read, counted per tile since
         * overlapping views share tiles. Never evicted. */
        this.pinned = new Map();
        /** Fetch the tiles the bbox covers (± margin) and return their features —
         * only the visible tiles, so the rendered set stays viewport-bounded. */
        /** Every named street among the tiles already fetched.
         *
         * For the destination search: the street names the app has on the device beat
         * asking a geocoder for them — instantly, and offline. Only what is already
         * loaded, so this costs nothing and never fetches; the area you have been
         * looking at is also the area you are searching in, and the geocoder covers
         * anything further out.
         */
        /** Cached, and thrown away whenever a tile arrives. See loadedStreets. */
        this.streetCache = null;
    }
    /** Number of tiles held in memory. */
    get loadedCount() {
        return this.loaded.size;
    }
    async loadManifest() {
        const m = await this.fetchJson("nettiles/manifest.json");
        this.grid = new TileGrid(m.originLon, m.originLat, m.tileDeg, m.tiles);
    }
    async fetchTile(key) {
        if (this.loaded.has(key))
            return;
        const pending = this.inflight.get(key);
        if (pending)
            return pending;
        const p = this.fetchJson(`nettiles/${key}.json`)
            .then((fc) => {
            this.loaded.set(key, fc.features);
            this.streetCache = null; // new streets to offer the search
        })
            .finally(() => {
            this.inflight.delete(key);
        });
        this.inflight.set(key, p);
        return p;
    }
    loadedStreets() {
        // Rebuilt only when the loaded set changes. This is called on every keystroke,
        // and after a few minutes of panning `loaded` holds up to maxTiles tiles, so
        // walking it per keystroke would grow into real work exactly for the reader
        // who has been using the map the longest.
        if (this.streetCache !== null)
            return this.streetCache;
        // One entry per segment, NOT one per name. Grouping by name merged the four
        // Elm Streets in this region into a single candidate holding all their points,
        // so "the nearest Elm Street" could not be offered — the whole point of
        // searching streets locally. Segments of one street are within a few hundred
        // metres of each other and the ranking's own dedupe collapses them; two Elm
        // Streets a mile apart stay two answers.
        const out = [];
        for (const feats of this.loaded.values()) {
            for (const f of feats) {
                const name = f.properties?.["name"];
                if (typeof name !== "string" || name === "")
                    continue;
                out.push({ name, coords: f.geometry.coordinates });
            }
        }
        this.streetCache = out;
        return out;
    }
    async visibleFeatures(box, margin = 1) {
        if (!this.grid)
            throw new Error("network manifest not loaded");
        const keys = this.grid.keysForBBox(box, margin);
        for (const k of keys)
            this.pinned.set(k, (this.pinned.get(k) ?? 0) + 1);
        const out = [];
        try {
            await Promise.all(keys.map((k) => this.fetchTile(k)));
            for (const k of keys) {
                const feats = this.loaded.get(k);
                if (!feats)
                    continue;
                out.push(...feats);
                // shown again, so now the most recent
                this.loaded.delete(k);
                this.loaded.set(k, feats);
            }
        }
        finally {
            for (const k of keys) {
                const n = (this.pinned.get(k) ?? 1) - 1;
                if (n > 0)
                    this.pinned.set(k, n);
                else
                    this.pinned.delete(k);
            }
        }
        this.evict();
        return out;
    }
    /** Let the least recently shown tiles go until at most maxTiles remain,
     * skipping any a pending view has yet to read. */
    evict() {
        if (this.loaded.size <= this.maxTiles)
            return;
        for (const k of [...this.loaded.keys()]) {
            if (this.loaded.size <= this.maxTiles)
                break;
            if (this.pinned.has(k))
                continue;
            this.loaded.delete(k);
            this.streetCache = null; // its streets are no longer on offer
        }
    }
}
/** Bounding box of a set of points, padded by `padM` metres. */
export function bboxOf(points, padM = 0) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const [lon, lat] of points) {
        if (lon < west)
            west = lon;
        if (lon > east)
            east = lon;
        if (lat < south)
            south = lat;
        if (lat > north)
            north = lat;
    }
    const lat = (south + north) / 2;
    const dLat = padM / 110540;
    const dLon = padM / (Math.cos((lat * Math.PI) / 180) * 111320);
    return { west: west - dLon, south: south - dLat, east: east + dLon, north: north + dLat };
}
