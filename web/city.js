// One city's page: /somerville, /cambridge, …
//
// The regional map answers "which project first" across 130 towns. This answers
// "what is wrong here", and the answer is a picture rather than a list. Take a
// city's streets, keep only the ones a child can use, and the network becomes
// an archipelago — a quiet grid, a pocket, another pocket, each ending at the
// same few arterials. Colouring the pieces separately says that in one glance.
//
// Deliberately not part of the app bundle: no router, no tiles, no navigation.
// A page a councillor opens should load a map and a paragraph, not a trip
// planner.
import { fillSegmentPhoto, segmentHtml } from "./segment.js";
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
let mapillaryToken = "";
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
function shapeOfTheProblem(s, afterClaim) {
    // "That means…" only follows something. Without the population sentence in
    // front of it the paragraph opened on a pronoun with no antecedent.
    const budget = afterClaim
        ? `That means no route within a ${s.budget_km} km ride that avoids traffic` +
            " a child shouldn't be in."
        : `Measured as a ${s.budget_km} km ride that avoids traffic a child` +
            " shouldn't be in.";
    if (s.safe_km <= 0) {
        // No kid-safe street at all is not "mostly joins up" — the old share
        // calculation fell back to 0 here and produced exactly that sentence.
        //
        // Hedged, and deliberately. safe_km is rounded to one decimal, so it reads 0
        // for anything under ~50 m, and 0 is also what a city with no data in this
        // build looks like. "Almost none" is true in all three cases; "there is
        // none" would be a flat claim resting on a rounded display value.
        return `${budget} Almost no street here is one a child can ride away from.`;
    }
    const strandedShare = s.pocket_km / s.safe_km;
    if (strandedShare >= 0.3) {
        return (`${budget} The streets they can use don't join up: ${s.pocket_km} km of` +
            ` them sit in ${s.pockets} pockets with no safe way out.`);
    }
    return (`${budget} Most of the safe network here does join up — ${s.connected_km} km` +
        ` of it — so the gaps are specific: ${s.pocket_km} km stranded in` +
        ` ${s.pockets} pockets, and the crossings between them.`);
}
/** Are the numbers this page is about to state in public actually numbers?
 *
 * web/data ships separately from the code — it's a release tarball a deploy
 * downloads — so a page can outrun the snapshot it fetches. Casting the JSON to
 * CityData and hoping put "undefined km stranded" and "About NaN residents"
 * one build skew away from being published as findings about a real city.
 * Refusing to draw is the right failure: a page that says nothing is recoverable,
 * a page that says nonsense about a city's children is not. */
function statsAreUsable(city) {
    const s = city.stats;
    if (s === undefined || typeof city.name !== "string" || city.name === "")
        return false;
    const required = [
        "safe_km",
        "connected_km",
        "connected_region_km",
        "pocket_km",
        "pockets",
        "projects",
        "projects_shown",
        "budget_km",
    ];
    // connected_leaves_city is checked separately: it's a boolean the page states
    // as fact either way, so a missing field would quietly render "it doesn't
    // leave the city" — a claim about a real place, made because a field was
    // absent rather than because anyone measured it.
    if (typeof s.connected_leaves_city !== "boolean")
        return false;
    return required.every((k) => Number.isFinite(s[k]));
}
function summarise(city) {
    const s = city.stats;
    el("city-name").textContent = city.name;
    const lede = el("lede");
    lede.innerHTML = "";
    const claimable = Number.isFinite(s.residents) &&
        Number.isFinite(s.stranded) &&
        Number.isFinite(s.stranded_pct) &&
        city.population_is_headcount;
    if (claimable) {
        // the figure the page exists to make unavoidable, with the count as well as
        // the share — 9% sounds small until it's seven thousand people. The count
        // is the pipeline's own, not the percentage multiplied back out: that gave
        // "7,225" from a whole-number 9%, precision nothing had measured.
        const strong = document.createElement("b");
        strong.textContent =
            `About ${N(s.stranded)} of ${city.name}'s ` +
                `${N(s.residents)} residents — ${s.stranded_pct}% — can't reach ` +
                "a school, playground or library on kid-safe streets.";
        lede.appendChild(strong);
        lede.appendChild(document.createTextNode(` ${shapeOfTheProblem(s, true)}`));
    }
    else {
        lede.textContent = shapeOfTheProblem(s, false);
    }
    const figures = [
        [
            `${s.connected_km} km`,
            s.connected_leaves_city
                ? "kid-safe streets on one network that carries on out of town"
                : "the largest connected piece — it doesn't leave the city",
            "good",
        ],
        // "cut off from the main network", not "you can't leave safely": a pocket
        // can run into the next town and still not reach the main network, and the
        // stronger phrasing asserts something this measures nothing about.
        [`${s.pocket_km} km`, `cut off from that network, in ${s.pockets} pockets`, "bad"],
        [String(s.pockets), "separate pockets of safe street", ""],
        [
            String(s.projects),
            s.projects > s.projects_shown
                ? `projects that would join them up (top ${s.projects_shown} shown)`
                : "projects that would join them up",
            "",
        ],
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
        // project-hover too: without it, hovering the list drew magenta lines over
        // a layer the reader had just switched off
        ["show-projects", ["projects", "project-hi", "project-hover"]],
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
        if (!statsAreUsable(city))
            throw new Error("stats missing");
    }
    catch {
        // a city we haven't generated yet is a missing page, not a broken one
        tellUser("No page for that city yet.");
        return;
    }
    // the same Mapillary client token the planner uses; absent is fine, the card
    // simply has no photo in it
    try {
        const keys = (await (await fetch("../data/keys.json")).json());
        mapillaryToken = keys.mapillary ?? "";
    }
    catch {
        mapillaryToken = "";
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
        // The street card, in the route planner's own words (src/segment.ts), plus
        // what this page knows that it doesn't: which piece of the network the
        // street belongs to, and whether you can leave it.
        const popup = new window.maplibregl.Popup({ closeButton: false, closeOnClick: false });
        let photoTimer;
        let openFor = "";
        const cardFor = (props, layer) => {
            const seg = {
                cls: props?.["cls"],
                name: props?.["name"],
                crashes: props?.["crashes"],
                source: props?.["source"],
            };
            const body = segmentHtml(seg, { photo: mapillaryToken !== "" });
            if (layer === "barriers") {
                return `${body}<br><small><b>A barrier.</b> This is what cuts the safe pieces apart.</small>`;
            }
            const isle = Number(props?.["isle"] ?? -1);
            const km = props?.["isle_km"];
            const belongs = isle === 0
                ? city.stats.connected_leaves_city
                    ? `<br><small><b>The main network:</b> ${km} km in ${city.name}, part of` +
                        ` ${N(city.stats.connected_region_km)} km that carries on past the town line.</small>`
                    : `<br><small><b>The main network:</b> ${km} km — the largest connected` +
                        ` piece in ${city.name}, but it doesn't leave the city.</small>`
                : `<br><small><b>A pocket:</b> ${km} km of it in ${city.name}, cut off from` +
                    " the main network — you can't leave it without riding something" +
                    " hostile.</small>";
            return body + belongs;
        };
        const show = (e, layer) => {
            const f = e.features?.[0];
            if (!f)
                return;
            const { lng, lat } = e.lngLat;
            const id = `${layer}:${String(f.properties?.["name"] ?? "")}:${lng.toFixed(4)},${lat.toFixed(4)}`;
            map.getCanvas().style.cursor = "pointer";
            // Reposition freely, but only rewrite the card when it's a different card.
            // setHTML on every mousemove replaced the popup's DOM — including a photo
            // that had already arrived — and the early return below then stopped it
            // ever being fetched again, so settling on a street lost its picture.
            popup.setLngLat(e.lngLat).addTo(map);
            if (id === openFor)
                return;
            openFor = id;
            popup.setHTML(cardFor(f.properties, layer));
            // debounced like the planner's: the photo is for the street you settled
            // on, not every street the pointer crossed getting there
            window.clearTimeout(photoTimer);
            photoTimer = window.setTimeout(() => {
                fillSegmentPhoto(popup.getElement(), lng, lat, mapillaryToken, () => openFor === id);
            }, 300);
        };
        for (const layer of ["islands", "barriers"]) {
            map.on("mousemove", layer, (e) => show(e, layer));
            // a phone has no hover, and these cards are the whole point of the map
            map.on("click", layer, (e) => show(e, layer));
            map.on("mouseleave", layer, () => {
                map.getCanvas().style.cursor = "";
                openFor = "";
                window.clearTimeout(photoTimer);
                popup.remove();
            });
        }
    });
}
void start();
