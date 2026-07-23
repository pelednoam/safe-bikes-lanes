// On-demand routing-graph tiles. The browser loads only the tiles covering a
// route's corridor (see pipeline/export_web.py export_tiles) instead of the
// whole 23 MB graph, so coverage can grow toward all of MA without an
// unbounded download. Loaded tiles are merged into one GraphData subset that
// the existing Router consumes unchanged — a tile is a self-contained
// sub-graph, and boundary nodes carry a stable GLOBAL id so tiles stitch
// together seamlessly when adjacent ones are loaded.
export class TileStore {
    constructor(fetchJson) {
        this.fetchJson = fetchJson;
        this.manifest = null;
        this.existing = new Set();
        this.loaded = new Map();
        this.inflight = new Map();
    }
    async loadManifest() {
        const m = await this.fetchJson("tiles/manifest.json");
        this.manifest = m;
        this.existing = new Set(m.tiles);
    }
    get classes() {
        return this.manifest?.classes ?? [];
    }
    /** Number of tiles held in memory — the Router only needs rebuilding when
     * this grows. */
    get loadedCount() {
        return this.loaded.size;
    }
    keyAt(lon, lat) {
        const m = this.manifest;
        if (!m)
            throw new Error("tile manifest not loaded");
        return [
            Math.floor((lon - m.originLon) / m.tileDeg),
            Math.floor((lat - m.originLat) / m.tileDeg),
        ];
    }
    /** Existing tile keys covering the bbox, grown by `margin` tiles on each side
     * (safe routes often detour outside the straight A–B box). */
    keysForBBox(box, margin = 1) {
        if (!this.manifest)
            throw new Error("tile manifest not loaded");
        const [c0, r0] = this.keyAt(box.west, box.south);
        const [c1, r1] = this.keyAt(box.east, box.north);
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
