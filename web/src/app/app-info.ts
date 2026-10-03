// The about dialog: how routes are rated, how fresh the data is, and which build
// this is.

import { el } from "./dom.js";
import { PROFILES } from "../router.js";
import { type ProtectionClass } from "../types.js";
import { classSwatch } from "./classes.js";
import { CLASS_LABELS } from "../segment.js";
import { dataReady } from "./services.js";
import { loadJson, usingRemoteData } from "../data.js";
import { store } from "./store.js";

interface DataMeta {
  built: string;
  sources: { name: string; retrieved: string; features: number }[];
}

function fillAbout(): void {
  const multTable = el<HTMLTableElement>("mult-table");
  if (multTable.rows.length > 0) return; // already filled
  const yk = PROFILES.young_kids;
  const rows = (Object.entries(yk.mult) as [ProtectionClass, number][])
    .sort((a, b) => a[1] - b[1])
    .map(
      ([cls, m]) =>
        `<tr><td>${classSwatch(cls, 28, 12)} ${CLASS_LABELS[cls]}</td>` +
        `<td>×${m}</td></tr>`,
    );
  rows.push(
    `<tr><td>painted lane on a busy road</td><td>×${yk.busyLane}</td></tr>`,
    `<tr><td>buffered lane on a busy road</td><td>×${yk.busyBuffered}</td></tr>`,
  );
  multTable.innerHTML = `<tr><th>street type</th><th>cost</th></tr>${rows.join("")}`;
  void dataReady
    .then(() => loadJson<DataMeta>("meta.json"))
    .then((meta: DataMeta | null) => {
      if (!meta) return;
      const remote = usingRemoteData();
      el<HTMLElement>("built-date").textContent =
        meta.built + (remote !== null ? " (live from the website)" : "");
      const table = el<HTMLTableElement>("freshness-table");
      for (const s of meta.sources) {
        const tr = table.insertRow();
        tr.insertCell().textContent = s.name.replace(/_/g, " ");
        tr.insertCell().textContent = s.retrieved;
        tr.insertCell().textContent = String(s.features);
      }
    })
    .catch(() => undefined);
}

function openAbout(): void {
  el<HTMLInputElement>("mapillary-token").value = store.mapillaryToken;
  fillAbout();
  el<HTMLDialogElement>("about").showModal();
}

/** What build this page actually is.
 *
 * Substituted at assembly (scripts/assemble.sh) and at deploy (pages.yml). Baked
 * into the code rather than fetched, because the question it answers is "is the
 * page in front of me the current one?" — and a fetched answer describes the
 * server while the page could be a cached older build, which is precisely the
 * case where a wrong answer costs the most.
 */
// Three plain tokens, not one JSON blob. The first version substituted JSON into
// a double-quoted literal, and sed reads `\"` in a replacement as an escape for
// `"` — so the backslashes vanished and app.js became a syntax error that broke
// the entire app. Values with no quotes in them cannot be mangled that way.
// Filled in by the build (vite.config.ts), not by sed on the output: a
// substitution in the shell once turned app.js into a syntax error.
const BUILD_VERSION = __BUILD_VERSION__;
const BUILD_TIME = __BUILD_TIME__;
const BUILD_COMMIT = __BUILD_COMMIT__;

interface BuildInfo {
  version?: string;
  built?: string;
  commit?: string;
}

/** This build, or null when the placeholders were never substituted — which
 * means the source is being served directly rather than from an assembled
 * bundle or a deploy. */
function thisBuild(): BuildInfo | null {
  if (BUILD_COMMIT.startsWith("__BUILD")) return null;
  return { version: BUILD_VERSION, built: BUILD_TIME, commit: BUILD_COMMIT };
}

function whenBuilt(iso: string | undefined): string {
  if (iso === undefined || iso === "") return "an unrecorded time";
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** Say which build this is, and whether the site has a newer one.
 *
 * The second half matters more than the first: a hard refresh that appears to
 * change nothing is indistinguishable from a deploy that never happened, and
 * without this there is no way to tell them apart from inside the app.
 */
async function showBuildStamp(): Promise<void> {
  const line = el<HTMLParagraphElement>("build-stamp");
  const mine = thisBuild();
  if (!mine) {
    line.textContent = "Development build — served straight from source.";
    return;
  }
  const named = mine.version !== undefined && mine.version !== "" && mine.version !== "web";
  const commit = mine.commit === undefined ? "" : ` · ${mine.commit}`;
  line.textContent = named
    ? `You're running ${mine.version}, built ${whenBuilt(mine.built)}${commit}.`
    : `You're running the build from ${whenBuilt(mine.built)}${commit}.`;

  // What the site is serving now, uncached — so a stale page can say so.
  try {
    const resp = await fetch("build.json", { cache: "no-store" });
    if (!resp.ok) return;
    const live = (await resp.json()) as BuildInfo;
    if (live.commit === undefined || live.commit === mine.commit) return;
    const note = document.createElement("span");
    note.className = "stale-build";
    note.textContent =
      ` The site has a newer build (${whenBuilt(live.built)} · ${live.commit}) — ` +
      "this page is a cached copy. Reload to pick it up.";
    line.appendChild(note);
  } catch {
    // offline, or the file isn't there: what this build is remains true
  }
}

export function initAppInfo(): void {
  // two ways in: the labelled button in the footer, which says what's inside, and
  // the ℹ in the header, which is reachable without scrolling the panel
  for (const id of ["about-btn", "about-top"]) {
    el<HTMLButtonElement>(id).addEventListener("click", () => {
      openAbout();
      // re-checked on every open: a page left sitting for a day is exactly the one
      // whose reader wants to know whether it is still the current build
      void showBuildStamp();
    });
  }

  el<HTMLButtonElement>("about-close").addEventListener("click", () => {
    el<HTMLDialogElement>("about").close();
  });

  el<HTMLDialogElement>("about").addEventListener("click", (e: MouseEvent) => {
    if (e.target === el<HTMLDialogElement>("about")) el<HTMLDialogElement>("about").close();
  });
}
