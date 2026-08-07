/** One hue per pocket. Rank 0 is the network that leaves the city, so it gets
 * the safety green everything else in the app uses for "you can ride this";
 * the rest are distinguishable rather than ranked — a pocket isn't better for
 * being bigger, it's just a different island. */
const ISLAND_COLORS = [
    "#1a9850", // 0: connected to the wider network
    "#8e44ad",
    "#2980b9",
    "#d35400",
    "#16a085",
    "#c0392b",
    "#7f8c8d",
    "#b7950b",
    "#9aa5ab", // 8: the long tail of small pockets
];
const N = (n) => n.toLocaleString();
function el(id) {
    const node = document.getElementById(id);
    if (node === null)
        throw new Error(`missing #${id}`);
    return node;
}
/** The world with the city cut out of it, for dimming everywhere else. */
function maskOf(boundary) {
    const world = [
        [-180, -85],
        [180, -85],
        [180, 85],
        [-180, 85],
        [-180, -85],
    ];
    const holes = boundary.coordinates.map((poly) => poly[0]);
    return {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [world, ...holes] },
    };
}
/** What this city's numbers actually say, rather than what we expected.
 *
 * The module was written around severance, and a screenshot of Somerville said
 * otherwise: 179 of its 212 kid-safe kilometres are one connected piece. Calling
 * that an archipelago would be a thesis overriding its own evidence. A city
 * where the split really is bad gets the stronger sentence; Somerville gets the
 * true one.
 */
function shapeOfTheProblem(s) {
    const budget = "That means no route within a 2.5 km ride that avoids traffic a child shouldn't be in.";
    const strandedShare = s.safe_km > 0 ? s.pocket_km / s.safe_km : 0;
    if (strandedShare >= 0.3) {
        return (`${budget} The streets they can use don't join up: ${s.pocket_km} km of` +
            ` them sit in ${s.pockets} pockets with no safe way out.`);
    }
    return (`${budget} Most of the safe network here does join up — ${s.connected_km} km` +
        ` of it — so the gaps are specific: ${s.pocket_km} km stranded in` +
        ` ${s.pockets} pockets, and the crossings between them.`);
}
function summarise(city) {
    const s = city.stats;
    el("city-name").textContent = city.name;
    const lede = el("lede");
    lede.innerHTML = "";
    if (s.residents !== null && s.stranded_pct !== null && city.population_is_headcount) {
        // the figure the page exists to make unavoidable, with the count as well as
        // the share — 9% sounds small until it's seven thousand people
        const stranded = Math.round((s.residents * s.stranded_pct) / 100);
        const strong = document.createElement("b");
        strong.textContent = `About ${N(stranded)} of ${city.name}'s ${N(s.residents)} residents — ${s.stranded_pct}% — can't reach a school, playground or library on kid-safe streets.`;
        lede.appendChild(strong);
        lede.appendChild(document.createTextNode(` ${shapeOfTheProblem(s)}`));
    }
    else {
        lede.textContent = shapeOfTheProblem(s);
    }
    const figures = [
        [`${s.connected_km} km`, "kid-safe streets that reach the wider network", "good"],
        [`${s.pocket_km} km`, `stranded in ${s.pockets} pockets you can't leave safely`, "bad"],
        [String(s.pockets), "separate pockets of safe street", ""],
        [String(s.projects), "projects that would join them up", ""],
    ];
    const box = el("figures");
    box.innerHTML = "";
    for (const [n, label, kind] of figures) {
        const fig = document.createElement("div");
        fig.className = `figure ${kind}`.trim();
        const num = document.createElement("div");
        num.className = "n";
        num.textContent = n;
        const lab = document.createElement("div");
        lab.className = "l";
        lab.textContent = label;
        fig.append(num, lab);
        box.appendChild(fig);
    }
    const limits = el("limits-list");
    limits.innerHTML = "";
    for (const limit of city.limits) {
        const li = document.createElement("li");
        li.textContent = limit;
        limits.appendChild(li);
    }
    el("built").textContent = city.built ?? "—";
}
function renderProjects(city, map) {
    const list = el("projects");
    list.innerHTML = "";
    const feats = city.projects.features;
    if (feats.length === 0) {
        list.textContent = "No candidate projects here — this city's safe streets already join up.";
        return;
    }
    feats.forEach((f, i) => {
        const p = (f.properties ?? {});
        const row = document.createElement("div");
        row.className = "project";
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.dataset["pid"] = String(p["pid"] ?? "");
        const rank = document.createElement("div");
        rank.className = "rank";
        rank.textContent = `${i + 1}`;
        const body = document.createElement("div");
        const head = document.createElement("div");
        head.textContent = `${Math.round(Number(p["length_m"] ?? 0))} m of ${String(p["name"] ?? "")}`;
        if (p["kind"] === "spot_fix") {
            const badge = document.createElement("span");
            badge.className = "badge";
            badge.textContent = "spot fix";
            head.appendChild(badge);
        }
        const why = document.createElement("div");
        why.className = "why";
        // the pipeline's own sentence, minus the opener the heading already carries
        why.textContent = String(p["summary"] ?? "").split("; ").slice(1).join("; ");
        body.append(head, why);
        row.append(rank, body);
        const focus = () => {
            for (const other of list.querySelectorAll(".project"))
                other.classList.remove("on");
            row.classList.add("on");
            map.setFilter("project-hi", ["==", ["get", "pid"], String(p["pid"] ?? "")]);
            const coords = f.geometry.type === "MultiLineString"
                ? f.geometry.coordinates.flat()
                : f.geometry.type === "LineString"
                    ? f.geometry.coordinates
                    : [];
            if (coords.length < 2)
                return;
            let w = Infinity;
            let s = Infinity;
            let e = -Infinity;
            let n = -Infinity;
            for (const [lon, lat] of coords) {
                w = Math.min(w, lon);
                e = Math.max(e, lon);
                s = Math.min(s, lat);
                n = Math.max(n, lat);
            }
            map.fitBounds([
                [w, s],
                [e, n],
            ], { padding: framePadding(), maxZoom: 16.5, duration: 600 });
        };
        const preview = (on) => {
            map.setFilter("project-hover", ["==", ["get", "pid"], on ? String(p["pid"] ?? "") : ""]);
        };
        row.addEventListener("mouseenter", () => preview(true));
        row.addEventListener("mouseleave", () => preview(false));
        // keyboard parity: tabbing through the list previews the same way hovering
        // does, or the map is only legible to people using a mouse
        row.addEventListener("focus", () => preview(true));
        row.addEventListener("blur", () => preview(false));
        row.addEventListener("click", focus);
        row.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                focus();
            }
        });
        list.appendChild(row);
    });
}
function addLayers(map, city) {
    map.addSource("mask", { type: "geojson", data: maskOf(city.boundary) });
    map.addLayer({
        id: "mask",
        type: "fill",
        source: "mask",
        paint: { "fill-color": "#0d1b1e", "fill-opacity": 0.42 },
    });
    map.addSource("boundary", { type: "geojson", data: city.boundary });
    map.addLayer({
        id: "boundary",
        type: "line",
        source: "boundary",
        paint: { "line-color": "#0d1b1e", "line-width": 1.6, "line-opacity": 0.5 },
    });
    map.addSource("access", { type: "geojson", data: city.access });
    map.addLayer({
        id: "access",
        type: "fill",
        source: "access",
        layout: { visibility: "none" },
        paint: {
            "fill-color": [
                "match",
                ["get", "band"],
                "good", "#1a9850",
                "partial", "#fee08b",
                "#d73027",
            ],
            "fill-opacity": 0.4,
            "fill-outline-color": "rgba(0,0,0,0)",
        },
    });
    map.addSource("barriers", { type: "geojson", data: city.barriers });
    map.addLayer({
        id: "barriers",
        type: "line",
        source: "barriers",
        paint: { "line-color": "#d73027", "line-width": 1.6, "line-opacity": 0.5 },
    });
    map.addSource("islands", { type: "geojson", data: city.islands });
    map.addLayer({
        id: "islands",
        type: "line",
        source: "islands",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
            // spread into a match expression: TS can't infer the shape of a built
            // array here, and the alternative is nine hand-written pairs
            "line-color": [
                "match",
                ["get", "isle"],
                ...ISLAND_COLORS.flatMap((c, i) => [i, c]),
                "#9aa5ab",
            ],
            "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.6, 16, 4.5],
            "line-opacity": 0.95,
        },
    });
    map.addSource("projects", { type: "geojson", data: city.projects });
    map.addLayer({
        id: "project-hi",
        type: "line",
        source: "projects",
        filter: ["==", ["get", "pid"], ""],
        paint: { "line-color": "#1440a0", "line-width": 12, "line-opacity": 0.4 },
    });
    // Separate from the selection halo: running the mouse down the list should
    // show you where each one is without losing the one you picked, and without
    // moving the camera — a map that jumps under the cursor can't be scanned.
    map.addLayer({
        id: "project-hover",
        type: "line",
        source: "projects",
        filter: ["==", ["get", "pid"], ""],
        // Magenta on purpose: it appears nowhere else here. The first try was amber,
        // which sat next to the orange pocket colour and read as another category
        // rather than as "the one you're pointing at".
        paint: { "line-color": "#e6007e", "line-width": 10, "line-opacity": 0.9 },
    });
    map.addLayer({
        id: "projects",
        type: "line",
        source: "projects",
        layout: { "line-cap": "round" },
        paint: {
            "line-color": "#111619",
            "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 16, 6],
            "line-dasharray": [1.4, 1.1],
        },
    });
}
function wireLayerToggles(map) {
    const pairs = [
        ["show-islands", ["islands"]],
        ["show-barriers", ["barriers"]],
        ["show-projects", ["projects", "project-hi"]],
        ["show-access", ["access"]],
    ];
    for (const [box, layers] of pairs) {
        const input = el(box);
        input.addEventListener("change", () => {
            for (const layer of layers) {
                map.setLayoutProperty(layer, "visibility", input.checked ? "visible" : "none");
            }
        });
    }
}
function onPhone() {
    return window.matchMedia("(max-width: 760px)").matches;
}
function framePadding() {
    return onPhone()
        ? { top: 24, bottom: Math.round(window.innerHeight * 0.5), left: 18, right: 18 }
        : { top: 40, bottom: 40, left: 400, right: 40 };
}
function tellUser(message) {
    document.body.innerHTML =
        `<div style="font-family:system-ui;max-width:36rem;margin:18vh auto;padding:0 1rem">` +
            `<h1 style="font-size:1.4rem">${message}</h1>` +
            `<p><a href="../">Back to the route planner</a></p></div>`;
}
async function start() {
    const slug = window.__CITY__ ?? window.location.pathname.replace(/\/+$/, "").split("/").pop();
    if (slug === undefined || slug === "") {
        tellUser("No city in this address.");
        return;
    }
    let city;
    try {
        const resp = await fetch(`../data/cities/${slug}.json`);
        if (!resp.ok)
            throw new Error(String(resp.status));
        city = (await resp.json());
    }
    catch {
        // a city we haven't generated yet is a missing page, not a broken one
        tellUser("No page for that city yet.");
        return;
    }
    document.title = `${city.name} — where to build for family biking`;
    summarise(city);
    const map = new window.maplibregl.Map({
        container: "map",
        style: {
            version: 8,
            sources: {
                base: {
                    type: "raster",
                    // label-free: the city's own streets are the subject, and the
                    // basemap's labels compete with them
                    tiles: ["https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png"],
                    tileSize: 256,
                    attribution: "© OpenStreetMap contributors © CARTO",
                },
            },
            layers: [{ id: "base", type: "raster", source: "base" }],
        },
        bounds: [
            [city.bbox[0], city.bbox[1]],
            [city.bbox[2], city.bbox[3]],
        ],
        // Leave room for the panel — beside the map on a desktop, over the bottom
        // of it on a phone. A fixed 400 px left pad is wider than a 390 px phone,
        // and MapLibre answered that by showing the whole planet.
        fitBoundsOptions: { padding: framePadding() },
    });
    window._map = map;
    map.addControl(new window.maplibregl.NavigationControl({}), "top-right");
    map.on("load", () => {
        addLayers(map, city);
        wireLayerToggles(map);
        renderProjects(city, map);
        const popup = new window.maplibregl.Popup({ closeButton: false, closeOnClick: false });
        map.on("mousemove", "islands", (e) => {
            const p = e.features?.[0]?.properties;
            if (!p)
                return;
            map.getCanvas().style.cursor = "pointer";
            popup
                .setLngLat(e.lngLat)
                .setHTML(p.isle === 0
                ? `<b>Connected</b><br>${p.isle_km} km in ${city.name}, and it reaches the rest of the region`
                : `<b>A pocket</b><br>${p.isle_km} km of safe street you can't leave without riding something hostile`)
                .addTo(map);
        });
        map.on("mouseleave", "islands", () => {
            map.getCanvas().style.cursor = "";
            popup.remove();
        });
        // a phone has no hover, and the pockets are the whole point of the map
        map.on("click", "islands", (e) => {
            const p = e.features?.[0]?.properties;
            if (!p)
                return;
            popup
                .setLngLat(e.lngLat)
                .setHTML(p.isle === 0
                ? `<b>Connected</b><br>${p.isle_km} km in ${city.name}, and it reaches the rest of the region`
                : `<b>A pocket</b><br>${p.isle_km} km of safe street you can't leave without riding something hostile`)
                .addTo(map);
        });
    });
}
void start();
export {};
