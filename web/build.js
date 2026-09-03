import { fmtDist } from "./units.js";
const CLASS_WORDS = {
    path: "off-street path",
    separated: "separated lane",
    buffered: "buffered lane",
    lane: "painted lane",
    sharrow: "shared-lane markings",
    quiet_street: "quiet street",
    moderate_street: "moderate street",
    busy_street: "busy street",
    service: "alley or service road",
};
const N = (n) => n.toLocaleString("en-US");
/** How many rows the panel draws. The ranking is not truncated — this is only
 * what goes into the DOM, because the list is rebuilt on every slider tick. */
const ROWS_SHOWN = 250;
const el = (id) => {
    const found = document.getElementById(id);
    if (!found)
        throw new Error(`missing #${id}`);
    return found;
};
let projects = [];
let meta = {};
let picked = null;
let pin = null;
/** The four sliders as shares that sum to 1 — the form the pipeline's own
 * weights take, so "score with these weights" is comparable to the exported
 * `score` field rather than to a scale invented here. */
function weights() {
    const raw = {
        sev: Number(el("w-sev").value),
        acc: Number(el("w-acc").value),
        crash: Number(el("w-crash").value),
        cov: Number(el("w-cov").value),
    };
    const total = raw.sev + raw.acc + raw.crash + raw.cov;
    if (total <= 0) {
        // Everything at zero is not a ranking. Fall back to gap-closing alone rather
        // than to an arbitrary order that would still look ranked.
        return { sev: 1, acc: 0, crash: 0, cov: 0 };
    }
    return {
        sev: raw.sev / total,
        acc: raw.acc / total,
        crash: raw.crash / total,
        cov: raw.cov / total,
    };
}
const PCT = (v) => `${Math.round(v * 100).toString()}%`;
/** The weighting the pipeline ranked with, as shares — or null if this build did
 * not record a usable one. Never partially: three of four weights would produce
 * a ranking that looks published and is not. */
function publishedWeights() {
    const w = meta.model?.weights;
    if (w === undefined)
        return null;
    const parts = [w.severance, w.access, w.crash, w.coverage];
    if (!parts.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0))
        return null;
    const total = parts.reduce((a, b) => a + b, 0);
    if (total <= 0)
        return null;
    return {
        sev: w.severance / total,
        acc: w.access / total,
        crash: w.crash / total,
        cov: w.coverage / total,
    };
}
/** Show each slider as the share it actually contributes. */
function showWeights() {
    const w = weights();
    el("v-sev").textContent = PCT(w.sev);
    el("v-acc").textContent = PCT(w.acc);
    el("v-crash").textContent = PCT(w.crash);
    el("v-cov").textContent = PCT(w.cov);
}
function score(p, w) {
    return w.sev * p.c_severance + w.acc * p.c_access + w.crash * p.c_crash + w.cov * p.c_coverage;
}
function scoreOf(p) {
    return score(p, weights());
}
/** The ranking a reader sees: filtered to a town, one row per gap.
 *
 * Memoised on the weights and the town, and it reads the four sliders once
 * rather than once per comparison — a sort of 1,500 candidates was doing ~15,000
 * comparisons with four DOM reads each, on every tick of a drag. */
let rankCache = null;
function ranked() {
    const w = weights();
    const town = el("town").value;
    const key = `${w.sev}|${w.acc}|${w.crash}|${w.cov}|${town}`;
    if (rankCache?.key === key)
        return rankCache.rows;
    const inTown = town === ""
        ? projects.slice()
        : projects.filter((p) => 
        // exact, per name: a substring test put North Reading under Reading
        p.towns
            .split(",")
            .map((t) => t.trim())
            .includes(town));
    const by = new Map();
    for (const p of inTown)
        by.set(p.pid, score(p, w));
    inTown.sort((a, b) => (by.get(b.pid) ?? 0) - (by.get(a.pid) ?? 0));
    const seen = new Set();
    const rows = inTown.filter((p) => {
        // alternatives across the same barrier are one candidate, not three
        if (seen.has(p.group))
            return false;
        seen.add(p.group);
        return true;
    });
    rankCache = { key, rows };
    return rows;
}
/** The clause of the generated sentence that says what this project achieves. */
function why(p) {
    const parts = p.summary.split("; ").slice(1);
    return parts.length > 0 ? parts.join("; ") : p.summary;
}
function renderList() {
    const rows = ranked();
    const list = el("list");
    list.textContent = "";
    el("empty").hidden = rows.length > 0;
    // A bound on the DOM, not on the analysis. Every slider tick re-renders this
    // list, and 1,500 buttons each carrying their own listener made a drag stutter
    // on a phone. What is dropped is said out loud below, and the CSV still carries
    // every ranked candidate — a silent cap would read as "that is all there is".
    const shown = rows.slice(0, ROWS_SHOWN);
    shown.forEach((p, i) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "row" + (p.pid === picked ? " on" : "");
        row.dataset["pid"] = p.pid;
        const rank = document.createElement("span");
        rank.className = "rank";
        rank.textContent = String(i + 1);
        const body = document.createElement("span");
        const what = document.createElement("span");
        what.className = "what";
        what.textContent = `${fmtDist(p.length_m)} of ${p.name}`;
        if (p.kind === "spot_fix") {
            const badge = document.createElement("span");
            badge.className = "badge";
            badge.textContent = "spot fix";
            what.appendChild(badge);
        }
        const reason = document.createElement("span");
        reason.className = "why";
        reason.textContent = why(p);
        body.appendChild(what);
        body.appendChild(reason);
        row.appendChild(rank);
        row.appendChild(body);
        list.appendChild(row);
    });
    const more = el("more");
    if (rows.length > shown.length) {
        more.hidden = false;
        more.textContent =
            `Showing the top ${N(shown.length)} of ${N(rows.length)} ranked here. ` +
                `The CSV has all of them, in this order.`;
    }
    else {
        more.hidden = true;
    }
    paint();
}
/** The map's ranking, so what is thick on screen matches what is high in the
 * list — including after the weights change. */
function paint() {
    const map = window._map;
    if (!map || map.getLayer("projects") === undefined)
        return;
    const rows = ranked();
    const w = weights();
    // A `match` needs at least one label/output pair, so an empty ranking gets a
    // constant instead: with no candidates the layer must go quiet, not keep the
    // last town's widths under a filter that no longer includes them.
    let expr = 0;
    if (rows.length > 0) {
        const best = score(rows[0], w) || 1;
        const match = ["match", ["get", "pid"]];
        for (const p of rows.slice(0, 400)) {
            match.push(p.pid, Math.max(0.15, score(p, w) / best));
        }
        match.push(0.12);
        expr = match;
    }
    map.setPaintProperty("projects", "line-opacity", expr);
    map.setPaintProperty("projects", "line-width", [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        ["*", 2.5, expr],
        15,
        ["*", 9, expr],
    ]);
    map.setFilter("project-hi", ["==", ["get", "pid"], picked ?? ""]);
}
function pick(pid) {
    picked = pid;
    document.body.classList.add("picked");
    el("detail-panel").classList.add("on");
    renderDetail();
    frame(pid);
    renderList();
}
/** The open project's panel. Separate from pick() because the weights change
 * what it says — its rank, and its score under the new weights — and re-running
 * pick() would fly the camera back every time a slider moved. */
function renderDetail() {
    const pid = picked;
    if (pid === null)
        return;
    const p = projects.find((x) => x.pid === pid);
    if (!p)
        return;
    const rows = ranked();
    const at = rows.findIndex((x) => x.pid === pid);
    const town = el("town").value;
    const inTown = town === "" ||
        p.towns
            .split(",")
            .map((t) => t.trim())
            .includes(town);
    // Off the list for two different reasons, and saying the wrong one is a claim
    // about the data: an alternative shares a gap with the row that is listed, but
    // a project in another town is simply not being ranked right now.
    el("d-rank").textContent =
        at >= 0
            ? `Rank ${N(at + 1)} of ${N(rows.length)}`
            : inTown
                ? "Alternative for the same gap"
                : `Not in ${town} — showing it anyway`;
    el("d-name").textContent = p.name;
    el("d-where").textContent =
        `${p.towns} · today ${CLASS_WORDS[p.cls] ?? p.cls.replace(/_/g, " ")}`;
    // Figures the pipeline measured. pop_gaining is only a headcount when the
    // census fetch worked; the meta says which, and an estimate is not labelled
    // as people.
    const headcount = meta.population?.is_headcount === true;
    const figs = [
        [fmtDist(p.length_m), "to build", ""],
        // join_m is the smaller of the two sides — the streets that would be
        // connected in, not the network they connect to. Labelling it "the network
        // it would join" credited the project with the size of the wrong side.
        [fmtDist(p.join_m), "kid-safe streets it would connect in", ""],
    ];
    if (p.pop_gaining !== null && p.pop_gaining > 0 && headcount) {
        figs.push([N(Math.round(p.pop_gaining)), "residents gaining a safe route", ""]);
    }
    if (p.dest_unlocked !== null && p.dest_unlocked > 0) {
        figs.push([
            String(p.dest_unlocked),
            // On the network this opens, not on this street: the pipeline counts
            // destinations the joined side can then reach.
            "schools, playgrounds or libraries on the network it opens",
            "",
        ]);
    }
    if (p.crashes !== null && p.crashes > 0) {
        // The period is the pipeline's to state. Hardcoding "since 2021" was right
        // for this build and would quietly misdate the figure the year the crash
        // years change.
        const years = meta.model?.crash_years;
        const period = Array.isArray(years) && years.length > 0
            ? ` since ${String(Math.min(...years))}`
            : " on record";
        figs.push([String(p.crashes), `bike crashes here${period}`, "warn"]);
    }
    const box = el("d-figures");
    box.textContent = "";
    for (const [n, l, kind] of figs) {
        const f = document.createElement("div");
        f.className = "figure" + (kind === "" ? "" : ` ${kind}`);
        const num = document.createElement("div");
        num.className = "n";
        num.textContent = n;
        const lab = document.createElement("div");
        lab.className = "l";
        lab.textContent = l;
        f.appendChild(num);
        f.appendChild(lab);
        box.appendChild(f);
    }
    // The components, raw. A reader who disagrees with the weighting can see what
    // it was applied to.
    // A printed sheet has no sliders, so it says which weighting produced this rank
    // — and whether that is the analysis's own weighting or the reader's.
    const w = weights();
    // Normalised the same way the sliders are, and only when every field is a
    // finite number: the sliders are shares of their own total, so comparing them
    // against a raw dict assumed the pipeline's weights sum to 1 — true today, and
    // a partial or non-summing dict would have printed "NaN%" as the published
    // weighting on a sheet a city takes to a meeting.
    const pw = publishedWeights();
    const asPublished = pw !== null &&
        Math.abs(w.sev - pw.sev) < 0.005 &&
        Math.abs(w.acc - pw.acc) < 0.005 &&
        Math.abs(w.crash - pw.crash) < 0.005 &&
        Math.abs(w.cov - pw.cov) < 0.005;
    const residents = headcount ? "residents" : "residents (estimated)";
    const shares = `gap-closing ${PCT(w.sev)}, reach ${PCT(w.acc)}, crash history ${PCT(w.crash)}, ` +
        `${residents} ${PCT(w.cov)}`;
    el("method").textContent =
        (asPublished
            ? `Ranked with the weighting the analysis itself used (${shares}). `
            : `Re-weighted by the reader (${shares}); the published ranking uses ` +
                (pw
                    ? `gap-closing ${PCT(pw.sev)}, reach ${PCT(pw.acc)}, ` +
                        `crash history ${PCT(pw.crash)}, ${residents} ${PCT(pw.cov)}. `
                    : "a weighting this build did not record. ")) +
            (meta.built === undefined
                ? "Components are model output from the network as mapped, not field measurements. " +
                    "This build did not record when."
                : `Components are model output from the network as mapped on ${meta.built}, not field ` +
                    `measurements.`);
    const tbody = el("d-rows");
    tbody.textContent = "";
    const comp = [
        ["Gap-closing", p.c_severance.toFixed(2)],
        ["Reach to schools & parks", p.c_access.toFixed(2)],
        [
            // With no per-street counts in this build the component still carries the
            // router's crash factor, which is crash-derived but not a count. Labelling
            // it plain "Crash history" beside a figure that is absent invites the
            // reader to assume the count was zero.
            // Three states, not two: no counts in this build, counted and none here,
            // counted and some. Zero fell between the first two, showing no figure
            // under a plain label — which reads as "we measured nothing" and
            // "we measured none" at the same time.
            p.crashes === null
                ? "Crash history (no counts in this build)"
                : p.crashes === 0
                    ? "Crash history (none recorded here)"
                    : "Crash history",
            p.c_crash.toFixed(2),
        ],
        [headcount ? "Residents gaining access" : "Residents gaining access (estimated)",
            p.c_coverage.toFixed(2)],
        ["Score with these weights", scoreOf(p).toFixed(2)],
        ["Order-of-magnitude cost", `$${N(Math.round(p.cost_proxy))}`],
    ];
    if (p.group_size > 1) {
        comp.push(["Alternatives across this gap", String(p.group_size)]);
    }
    for (const [k, v] of comp) {
        const tr = document.createElement("tr");
        const a = document.createElement("td");
        a.textContent = k;
        const b = document.createElement("td");
        b.textContent = v;
        tr.appendChild(a);
        tr.appendChild(b);
        tbody.appendChild(tr);
    }
    // The what-if, from what was measured rather than from a live simulation. The
    // design sketched a "what if it were protected?" button; the honest version of
    // that is already in the data, and a button implying a fresh computation would
    // claim more than the page can support.
    //
    // Which network the other side is matters and is not ours to guess: join_m is
    // the smaller of the two sides a build would link, and that says nothing about
    // whether the larger side is the region's main network or another local
    // pocket. The pipeline knows — joins_region — so the sentence is only as
    // specific as that field, and stays general when it is absent (the data
    // snapshot predates it).
    const whatIf = p.join_m > 0
        ? `If this were protected, ${fmtDist(p.join_m)} of streets a child can already ride ` +
            `would be connected to ` +
            (p.joins_region === true
                ? "the region-wide kid-safe network"
                : p.joins_region === false
                    ? "the larger network on the other side of this gap"
                    : "the network on the other side of this gap") +
            `. Modelled on the streets as mapped today; that figure is the side that ` +
            `gains, not the two sides added together.`
        : "";
    el("d-whatif").textContent = whatIf;
    el("d-summary").textContent = p.summary;
}
/** Frame the project and mark where it is — a line 40 m long is hard to find. */
function frame(pid) {
    const map = window._map;
    const feat = featureFor(pid);
    if (map && feat) {
        const coords = feat.geometry.coordinates.flat();
        const lons = coords.map((c) => c[0]);
        const lats = coords.map((c) => c[1]);
        // The detail panel sits on the right on a wide screen, so the project is
        // framed clear of it — but on a 390 px phone the panel is along the bottom
        // and 420 px of right padding exceeded the canvas, leaving fitBounds a
        // negative width to fit into.
        const box = map.getCanvas().getBoundingClientRect();
        // > 900, not >= : the stylesheet's `max-width: 900px` matches at exactly 900,
        // so a 900 px window has the bottom sheet while this said it was wide.
        const wide = box.width > 900;
        const pad = wide
            ? { top: 60, bottom: 60, left: 60, right: 420 }
            : { top: 40, bottom: Math.round(box.height * 0.62) + 20, left: 30, right: 30 };
        map.fitBounds([
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
        ], { padding: pad, maxZoom: 16, duration: 600 });
        pin?.remove();
        pin = new window.maplibregl.Marker({ color: "#12833f" })
            .setLngLat(coords[Math.floor(coords.length / 2)])
            .addTo(map);
    }
}
let features = [];
function featureFor(pid) {
    return features.find((f) => f.properties?.["pid"] === pid);
}
function csv() {
    const cols = [
        "pid",
        "name",
        "towns",
        "kind",
        "cls",
        "length_m",
        "join_m",
        "crashes",
        "dest_unlocked",
        "pop_gaining",
        "cost_proxy",
        // the pipeline's own composite, so a city can check this download against
        // the published ranking rather than only against the weights they chose
        "score",
        // the ranking shows one row per gap; without this the reader cannot tell
        // that two other ways of crossing the same barrier were folded into it
        "group",
        "group_size",
        "c_severance",
        "c_access",
        "c_crash",
        "c_coverage",
    ];
    const rows = ranked();
    // Names come from OpenStreetMap, and a city opens this in Excel. A field
    // starting =, +, -, @ or a control character is a formula there, so it is
    // prefixed with a tab and quoted: the cell still reads as the street's name
    // and nothing evaluates.
    const esc = (v) => {
        const raw = v === null || v === undefined ? "" : String(v);
        // A leading "-" is a formula character in a spreadsheet and also how every
        // negative number starts. Tab-prefixing both made climbs and deltas arrive
        // as text, so a plain number is left alone and everything else is neutered.
        const numeric = raw !== "" && Number.isFinite(Number(raw));
        const s = !numeric && /^[=+\-@\t\r\n]/.test(raw) ? `\t${raw}` : raw;
        return /[",\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = [
        ["rank", "score_with_current_weights", ...cols].join(","),
        ...rows.map((p, i) => [i + 1, scoreOf(p).toFixed(4), ...cols.map((c) => esc(p[c]))].join(",")),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "where-to-build.csv";
    a.click();
    URL.revokeObjectURL(url);
}
/** Load the two files the page is made of, or say plainly that it could not. */
async function load() {
    const get = async (url) => {
        const r = await fetch(url);
        if (!r.ok)
            throw new Error(`${url} — ${String(r.status)}`);
        return (await r.json());
    };
    try {
        // The candidates are the page; the meta only annotates it, and every field it
        // supplies already has a fallback. Losing the annotations should cost the
        // provenance line and the published weighting, not the ranking itself.
        const [fc, m] = await Promise.all([
            get("../data/priorities.geojson"),
            get("../data/priorities_meta.json").catch(() => ({})),
        ]);
        if (!Array.isArray(fc.features) || fc.features.length === 0) {
            throw new Error("priorities.geojson has no candidates");
        }
        // Parseable is not the same as usable. Every render reads these fields, so a
        // file missing them threw *after* load() had returned — past the failure path
        // — and left the blank page this guard exists to prevent.
        const first = fc.features[0]?.properties;
        const needed = ["pid", "name", "towns", "cls", "summary", "group"];
        const missing = needed.filter((k) => typeof first?.[k] !== "string");
        const numbers = ["length_m", "join_m", "c_severance", "c_access", "c_crash", "c_coverage"];
        missing.push(...numbers.filter((k) => typeof first?.[k] !== "number"));
        if (missing.length > 0) {
            throw new Error(`priorities.geojson is missing ${missing.join(", ")}`);
        }
        return [fc, m];
    }
    catch (err) {
        // A working tool that silently shows nothing is worse than one that says the
        // data is missing: a planner would read an empty ranking as "no projects".
        const empty = el("empty");
        empty.hidden = false;
        empty.textContent =
            "The ranking data could not be loaded, so nothing is shown rather than a " +
                "blank list that would read as \u201cno projects\u201d. " +
                `(${err instanceof Error ? err.message : String(err)})`;
        el("counts").textContent = "";
        return null;
    }
}
async function start() {
    const loaded = await load();
    if (!loaded)
        return;
    const [fc, m] = loaded;
    features = fc.features;
    projects = fc.features.map((f) => f.properties);
    meta = m;
    // Only claim what the pipeline reported. Falling back to the number of drawn
    // features would have said "1,500 were examined; the 1,500 strongest are drawn"
    // — a provenance claim invented from the file we just read.
    // "the strongest" was wrong: the pipeline reserves a quota of the map slice for
    // the top of *each* criterion, precisely so that re-weighting cannot hide the
    // leaders of a list. Saying "strongest" described a simpler selection than the
    // one that was made, and would have made the sliders look broken.
    el("counts").textContent =
        meta.candidates !== undefined
            ? `${N(meta.candidates)} were examined; ${N(meta.mapped ?? projects.length)} are drawn ` +
                `here, including the leaders on each criterion — so turning one criterion up ` +
                `on its own cannot hide its own top projects. A weighting of your own can ` +
                `still favour something outside this slice; the CSV names what was measured.`
            : `${N(projects.length)} are drawn here.`;
    el("built").textContent = meta.built ?? "—";
    const limits = el("limits");
    for (const line of meta.limits ?? []) {
        const li = document.createElement("li");
        li.textContent = line;
        limits.appendChild(li);
    }
    // If the census fetch failed, the criterion is a density estimate rather than
    // people. The figure is withheld elsewhere; the control that weights it has to
    // say the same thing, or the slider is the one place the page still calls it a
    // headcount.
    if (meta.population?.is_headcount !== true) {
        const label = document.querySelector('label[for="w-cov"]');
        if (label)
            label.textContent = "Residents gaining access (estimated)";
    }
    const towns = [...new Set(projects.flatMap((p) => p.towns.split(",").map((t) => t.trim())))]
        .filter((t) => t !== "")
        .sort();
    const sel = el("town");
    for (const t of towns) {
        const o = document.createElement("option");
        o.value = t;
        o.textContent = t;
        sel.appendChild(o);
    }
    // ?town=Somerville, so a city page can hand a planner their own ranking rather
    // than the whole region and a filter to find.
    //
    // A town this build has no candidates for falls back to the whole region and
    // says so. Assigning an unknown value to a <select> already yields "", so the
    // fallback is free — but silently showing the region under a link that named
    // one town reads as "these are Atlantis's projects", and the reader did not
    // choose the filter, a link did.
    const asked = new URLSearchParams(location.search).get("town");
    if (asked !== null && asked !== "") {
        if (towns.includes(asked)) {
            sel.value = asked;
        }
        else {
            const note = document.createElement("p");
            note.className = "note stale-link";
            // Quoted and clipped. It is textContent so nothing can execute, but the
            // value comes from whoever wrote the link, and an unbounded echo would let
            // them put a paragraph of their own words on a page cities read as ours.
            const shown = asked.length > 40 ? `${asked.slice(0, 40)}\u2026` : asked;
            note.textContent =
                `The link asked for \u201c${shown}\u201d, which has no candidates in this ` +
                    `build — showing the whole region instead.`;
            sel.parentElement?.after(note);
            // and it goes when it stops being true, rather than contradicting the
            // filter the reader has since chosen
            sel.addEventListener("change", () => {
                note.remove();
            });
        }
    }
    const map = new window.maplibregl.Map({
        container: "map",
        // Carto's vector positron rather than their raster light_all, which now
        // comes back with "API KEY REQUIRED" stamped across the image (see
        // basemap.ts). This page's own layers are added on load and still land
        // above it.
        style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
        center: [-71.1, 42.38],
        zoom: 11,
    });
    window._map = map;
    map.addControl(new window.maplibregl.NavigationControl({}), "top-right");
    map.on("load", () => {
        map.addSource("projects", { type: "geojson", data: fc });
        map.addLayer({
            id: "project-hi",
            type: "line",
            source: "projects",
            filter: ["==", ["get", "pid"], ""],
            paint: { "line-color": "#12833f", "line-width": 13, "line-opacity": 0.35 },
        });
        map.addLayer({
            id: "projects",
            type: "line",
            source: "projects",
            layout: { "line-cap": "round" },
            paint: { "line-color": "#111619", "line-width": 3, "line-opacity": 0.8 },
        });
        map.on("click", "projects", (e) => {
            const pid = e.features?.[0]?.properties?.["pid"];
            if (typeof pid === "string")
                pick(pid);
        });
        map.on("mouseenter", "projects", () => {
            map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "projects", () => {
            map.getCanvas().style.cursor = "";
        });
        renderList();
    });
    // Start from the weighting the pipeline used, read from the data rather than
    // repeated here: the first ranking a reader sees is then the exported one.
    const dflt = publishedWeights();
    if (dflt !== null) {
        // Out of 100 — not rescaled so the largest hits the top of the track, which
        // would leave the most important criterion the only one a reader could not
        // turn up.
        const at = (v) => String(Math.round(v * 100));
        el("w-sev").value = at(dflt.sev);
        el("w-acc").value = at(dflt.acc);
        el("w-crash").value = at(dflt.crash);
        el("w-cov").value = at(dflt.cov);
    }
    const startedAt = {
        sev: el("w-sev").value,
        acc: el("w-acc").value,
        crash: el("w-crash").value,
        cov: el("w-cov").value,
    };
    showWeights();
    for (const slider of ["w-sev", "w-acc", "w-crash", "w-cov"]) {
        el(slider).addEventListener("input", () => {
            showWeights();
            renderList();
            renderDetail();
        });
    }
    el("w-reset").addEventListener("click", () => {
        el("w-sev").value = startedAt.sev;
        el("w-acc").value = startedAt.acc;
        el("w-crash").value = startedAt.crash;
        el("w-cov").value = startedAt.cov;
        showWeights();
        renderList();
        renderDetail();
    });
    // Delegated: one listener for the list rather than one per row, so a re-render
    // is only DOM churn and not 250 listener registrations as well.
    el("list").addEventListener("click", (e) => {
        const row = e.target?.closest(".row");
        const pid = row?.dataset["pid"];
        if (pid !== undefined && pid !== "")
            pick(pid);
    });
    el("town").addEventListener("change", () => {
        // Keep the URL saying what the screen says. A planner who filters to their
        // town and sends the link was sending the whole region.
        const value = el("town").value;
        const url = new URL(location.href);
        if (value === "")
            url.searchParams.delete("town");
        else
            url.searchParams.set("town", value);
        history.replaceState(null, "", url);
        renderList();
        renderDetail();
    });
    el("csv").addEventListener("click", csv);
    // The caveats live in a <details> to keep the panel short, and CSS cannot
    // reliably reveal a closed one — so it is opened before printing, whether the
    // sheet was asked for from the button or from the browser's own print command.
    const openLimits = () => {
        document.querySelector("details.limits")?.setAttribute("open", "");
    };
    window.addEventListener("beforeprint", openLimits);
    el("print").addEventListener("click", () => {
        openLimits();
        window.print();
    });
    el("back-to-list").addEventListener("click", () => {
        document.body.classList.remove("picked");
        el("detail-panel").classList.remove("on");
        picked = null;
        // the pin goes with the card: a marker left standing points at a project the
        // reader has closed, on a map that is now showing the whole list again
        pin?.remove();
        pin = null;
        renderList();
    });
    renderList();
}
void start();
