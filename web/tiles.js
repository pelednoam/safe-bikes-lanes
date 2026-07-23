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
}
export class TileStore {
    constructor(fetchJson) {
        this.fetchJson = fetchJson;
        this.grid = null;
        this.classList = [];
        this.loaded = new Map();
        this.inflight = new Map();
    }
    async loadManifest() {
        const m = await this.fetchJson("tiles/manifest.json");
        this.grid = new TileGrid(m.originLon, m.originLat, m.tileDeg, m.tiles);
        this.classList = m.classes;
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
                ]);
            }
        }
        return { nodes, names, classes, edges, geoms };
    }
}
/** Viewport loader for the display network. Unlike the routing tiles (loaded
 * along a route's corridor), these load for whatever the map is showing, so
 * the coloured safety network only downloads the streets currently on screen.
 * Tiles fetched once stay cached; visibleFeatures returns just the tiles the
 * viewport covers, bounding what the GL source has to render. */
export class NetworkTiles {
    constructor(fetchJson) {
        this.fetchJson = fetchJson;
        this.grid = null;
        this.loaded = new Map();
        this.inflight = new Map();
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
        })
            .finally(() => {
            this.inflight.delete(key);
        });
        this.inflight.set(key, p);
        return p;
    }
    /** Fetch the tiles the bbox covers (± margin) and return their features —
     * only the visible tiles, so the rendered set stays viewport-bounded. */
    async visibleFeatures(box, margin = 1) {
        if (!this.grid)
            throw new Error("network manifest not loaded");
        const keys = this.grid.keysForBBox(box, margin);
        await Promise.all(keys.map((k) => this.fetchTile(k)));
        const out = [];
        for (const k of keys) {
            const feats = this.loaded.get(k);
            if (feats)
                out.push(...feats);
        }
        return out;
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
