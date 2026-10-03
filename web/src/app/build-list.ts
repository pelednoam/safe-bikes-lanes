// The ranked list of projects: loading the pipeline's priorities, the rows, the
// plain-language description of each, and previewing one on the map.

import { BuildList, type BuildListStatus } from "../ui/BuildList.js";
import { map } from "./map.js";
import { el } from "./dom.js";
import { publishedWeightPositions, rankedProjects, repaintProjects, scoreAllProjects } from "./build-score.js";
import { h, render } from "preact";
import { type PriorityMeta, type ProjectProps, WEIGHT_KEYS, build, projectBounds } from "./build-state.js";
import { fmtDistTight } from "../units.js";
import { dataReady } from "./services.js";
import { loadJson } from "../data.js";
import { ensureLayer } from "./sources.js";
import { clearWhatIf } from "./build-whatif.js";

/** Where the project data is: drawn by the list, which nothing else writes. */
let buildListStatus: BuildListStatus = "idle";

/** Preview a project's line on the map while its row is hovered or focused. */
function previewProject(pid: string | null): void {
  if (map.getLayer("build-hover") === undefined) return;
  map.setFilter("build-hover", ["==", ["get", "pid"], pid ?? ""]);
  // only useful once the layer is drawable; focusProject turns it on
  map.setLayoutProperty(
    "build-hover",
    "visibility",
    pid !== null && el<HTMLInputElement>("show-build").checked ? "visible" : "none",
  );
}

export function renderBuildList(): void {
  const ranked = buildListStatus === "ready" ? rankedProjects() : [];
  // scored over every project, not the deduped list: the map draws the
  // alternatives too, and they'd otherwise keep our weighting while the rest
  // switched to the reader's
  if (buildListStatus === "ready") repaintProjects(scoreAllProjects());
  render(
    h(BuildList, {
      status: buildListStatus,
      ranked,
      selected: build.selectedProject,
      measured: build.priorityMeta?.candidates ?? null,
      onPick: focusProject,
      onPreview: previewProject,
    }),
    el<HTMLDivElement>("build-list"),
  );
}

function describeMeta(meta: PriorityMeta): void {
  const pct = meta.access?.stranded_pct;
  const headcount = meta.population?.is_headcount === true;
  const who = headcount ? "residents" : "homes (estimated from street length)";
  el<HTMLParagraphElement>("build-intro").textContent =
    pct === undefined
      ? "Candidate projects, ranked by how much safe network they'd open up."
      : `${pct}% of ${who} in the mapped towns can't reach a school, playground or ` +
        `library within ${fmtDistTight(meta.access?.budget_m ?? 0)} of ` +
        "perceived distance. These are the projects that would change that most.";
  const limits = meta.limits ?? [];
  // A field the build did not record is not a zero. "Measured 0 candidates
  // against 0 schools" reads as a finished analysis that found nothing, which is
  // the opposite of what a missing count means.
  const counted = (n: number | undefined): string => (n === undefined ? "the" : String(n));
  el<HTMLDivElement>("build-method").textContent =
    `Measured ${counted(meta.candidates)} candidates against ${counted(meta.destinations)} ` +
    `schools, playgrounds and libraries it found (data built ` +
    `${meta.built ?? "an unrecorded date"}). Method and limits are in About.`;

  // The same limits, in full, where someone checking a number will look. A
  // ranking a city might quote in public needs its caveats somewhere citable.
  el<HTMLDivElement>("about-build").style.display = limits.length > 0 ? "block" : "none";
  el<HTMLParagraphElement>("about-build-text").textContent =
    `Every street a kid can't use is cut into candidate projects, and each is ` +
    `measured against the network as it stands: what kid-safe network it would ` +
    `join, how much closer it brings people to ${counted(meta.destinations)} schools, ` +
    `playgrounds and libraries, its recorded bike crashes, and how many ` +
    `residents gain a safe route at all. Population is ${
      meta.population?.source ?? "unavailable"
    }. ${meta.access?.budget_note ?? ""}`;
  const list = el<HTMLUListElement>("about-build-limits");
  list.innerHTML = "";
  for (const limit of limits) {
    const li = document.createElement("li");
    li.textContent = limit;
    list.appendChild(li);
  }
}

/** Decide whether this data build has a ranking at all — 2 KB, at boot.
 *
 * The ranking itself is 2.8 MB and is for cities, not riders, so it waits until
 * someone opens the section or turns the layer on. Loading it at boot meant
 * every phone pulled three megabytes of project geometry to render a panel
 * almost nobody opens. Absent metadata hides the section entirely: a published
 * data snapshot can predate this module. */
let buildMetaStarted = false;

export function ensureBuildMeta(): void {
  if (buildMetaStarted) return;
  buildMetaStarted = true;
  void dataReady
    .then(() => loadJson<PriorityMeta>("priorities_meta.json"))
    .then((meta) => {
      build.priorityMeta = meta;
      // the sliders start where the analysis did, so this list and /build open on
      // the same ranking as the exported score
      const published = publishedWeightPositions();
      if (published) {
        for (const key of WEIGHT_KEYS) el<HTMLInputElement>(`wt-${key}`).value = published[key];
      }
      el<HTMLDetailsElement>("build-box").style.display = "block";
      describeMeta(meta);
    })
    .catch(() => {
      el<HTMLDetailsElement>("build-box").style.display = "none";
    });
}

/** Load the projects themselves, on first real use. */
let buildDataStarted = false;

export function ensureBuildData(): void {
  if (buildDataStarted) return;
  buildDataStarted = true;
  buildListStatus = "loading";
  renderBuildList();
  void dataReady
    .then(() => loadJson<GeoJSON.FeatureCollection>("priorities.geojson"))
    .then((fc) => {
      build.projectFC = fc;
      build.projects = fc.features
        .map((f) => f.properties as unknown as ProjectProps)
        .filter((p) => p && typeof p.pid === "string");
      projectBounds.clear();
      for (const f of fc.features) {
        const pid = (f.properties as { pid?: string } | null)?.pid;
        if (pid === undefined) continue;
        const parts: [number, number][] =
          f.geometry.type === "MultiLineString"
            ? (f.geometry.coordinates.flat() as [number, number][])
            : f.geometry.type === "LineString"
              ? (f.geometry.coordinates as [number, number][])
              : [];
        if (parts.length < 2) continue;
        let w = Infinity;
        let sth = Infinity;
        let e = -Infinity;
        let n = -Infinity;
        for (const [lon, lat] of parts) {
          w = Math.min(w, lon);
          e = Math.max(e, lon);
          sth = Math.min(sth, lat);
          n = Math.max(n, lat);
        }
        projectBounds.set(pid, [
          [w, sth],
          [e, n],
        ]);
      }
      const towns = new Set<string>();
      for (const p of build.projects) {
        for (const t of p.towns.split(",")) {
          const name = t.trim();
          if (name && name !== "-") towns.add(name);
        }
      }
      const select = el<HTMLSelectElement>("build-town");
      select.innerHTML = "";
      const all = document.createElement("option");
      all.value = "";
      all.textContent = `all towns (${build.projects.length} mapped projects)`;
      select.appendChild(all);
      for (const town of [...towns].sort()) {
        const opt = document.createElement("option");
        opt.value = town;
        opt.textContent = town;
        select.appendChild(opt);
      }
      buildListStatus = "ready";
      renderBuildList();
    })
    .catch(() => {
      // metadata said there was a ranking and the ranking didn't load: say so
      // rather than leaving "loading projects…" up forever
      buildListStatus = "failed";
      renderBuildList();
      buildDataStarted = false;
    });
}

export function focusProject(pid: string): void {
  build.selectedProject = pid;
  if (!build.projects.some((p) => p.pid === pid)) return;
  // choosing a project shows the projects: it would be odd to highlight
  // something on an invisible layer
  const toggle = el<HTMLInputElement>("show-build");
  if (!toggle.checked) {
    toggle.checked = true;
    ensureLayer("build");
    ensureLayer("crossings");
    map.setLayoutProperty("build", "visibility", "visible");
    map.setLayoutProperty("crossings", "visibility", "visible");
  }
  if (map.getLayer("build-selected")) {
    map.setFilter("build-selected", ["==", ["get", "pid"], pid]);
    map.setLayoutProperty("build-selected", "visibility", "visible");
  }
  const box = projectBounds.get(pid);
  if (box) map.fitBounds(box, { padding: 90, maxZoom: 16.5, duration: 600 });
  el<HTMLDivElement>("whatif").style.display = "block";
  if (build.whatIfPid !== null && build.whatIfPid !== pid) clearWhatIf();
  else el<HTMLDivElement>("whatif-result").textContent = "";
  renderBuildList();
}
