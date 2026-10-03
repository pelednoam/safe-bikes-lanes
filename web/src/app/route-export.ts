// Taking a route out of the app: the GPX file, the printable cue sheet, and the
// offline map download.

import { type SaveResult, isNativeApp } from "../native.js";
import { el } from "./dom.js";
import { trip } from "./services.js";
import { buildCues, toGPX } from "../router.js";
import { saveBlob } from "../share.js";
import { fmtClimb, fmtDist } from "../units.js";
import { cautionsHtml, esc } from "../segment.js";
import { downloadOffline, routeTiles } from "../tilecache.js";
import { buildTrack } from "../nav.js";
import { BASEMAP_MAXZOOM, tileDeps } from "../basemap.js";

/** Say on the button what became of a file it saved, for a moment. */
export function toldSaved(btn: HTMLElement, result: SaveResult): void {
  const prev = btn.textContent;
  btn.textContent =
    "saved" in result ? `✓ saved to ${result.where ?? "Downloads"}` : `⚠ not saved: ${result.error}`;
  window.setTimeout(() => {
    btn.textContent = prev;
  }, 3000);
}

export function initRouteExport(): void {
  el<HTMLButtonElement>("gpx").addEventListener("click", () => {
    const sel = trip.selected;
    if (!sel) return;
    const gpx = toGPX(sel.payload, `Family bike route (${sel.label})`);
    const saving = saveBlob(new Blob([gpx], { type: "application/gpx+xml" }), "family-bike-route.gpx");
    // in a browser the download is its own confirmation; in the app it isn't
    if (isNativeApp()) void saving.then((r) => toldSaved(el<HTMLButtonElement>("gpx"), r));
  });

  el<HTMLButtonElement>("print-cues").addEventListener("click", () => {
    const sel = trip.selected;
    if (!sel) return;
    const cues = buildCues(sel.payload);
    const s = sel.payload.summary;
    const rows = cues
      .map((c) => `<tr><td>${fmtDist(c.km * 1000)}</td><td>${esc(c.text)}</td></tr>`)
      .join("");
    const cautionRows = cautionsHtml(s.cautions, fmtDist);
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(
      `<html><head><title>Cue sheet</title><style>
        body{font-family:sans-serif;font-size:13px;max-width:520px;margin:20px auto}
        table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ddd;padding:3px 6px}
        td:first-child{white-space:nowrap;font-variant-numeric:tabular-nums}
      </style></head><body>
      <h2>Family bike route — ${sel.label}</h2>
      <p>${fmtDist(s.meters)} · ~${s.minutes} min · ${s.pct_protected}% protected · climb ${fmtClimb(s.climb_m ?? 0)}</p>
      ${cautionRows ? `<ul>${cautionRows}</ul>` : ""}
      <table>${rows}</table>
      </body></html>`,
    );
    win.document.close();
    win.print();
  });

  el<HTMLButtonElement>("offline-btn").addEventListener("click", () => {
    const sel = trip.selected;
    if (!sel) return;
    const btn = el<HTMLButtonElement>("offline-btn");
    const tiles = routeTiles(buildTrack(sel.payload).coords, [13, BASEMAP_MAXZOOM]);
    btn.disabled = true;
    // Tiles only: the style is built in the page (basemap.ts), so a cold start
    // offline has what it needs to paint them, in either theme.
    void downloadOffline(
      tiles,
      (done, total) => {
        btn.textContent = `⬇ ${done}/${total}…`;
      },
      tileDeps(),
    )
      .then(({ failed }) => {
        // Say so when part of the route did not arrive, rather than "ready" over
        // a map that will have holes in it.
        btn.textContent = failed === 0 ? "✓ offline ready" : `⚠ ${failed} of ${tiles.length} tiles missing`;
      })
      .catch(() => {
        btn.textContent = "offline download failed";
      })
      .finally(() => {
        btn.disabled = false;
        window.setTimeout(() => {
          btn.textContent = "⬇ Offline map";
        }, 4000);
      });
  });
}
