// Printing one project as a page: what it is, why it ranks where it does, and the
// evidence.

import { build } from "./build-state.js";
import { fmtDist } from "../units.js";

/** One project, on one page, for a meeting.
 *
 * Deliberately not a screenshot of the panel: it has to stand alone once it is
 * printed, so it carries the numbers, where they came from, and what they do
 * not mean. A page a city might hand round is exactly where a model's caveats
 * are most likely to get lost. */
export function printProject(pid: string): void {
  const p = build.projects.find((x) => x.pid === pid);
  if (!p) return;
  const meta = build.priorityMeta;
  const esc = (t: string): string =>
    t.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
  const headcount = meta?.population?.is_headcount === true;
  const rows: [string, string][] = [
    ["Where", `${esc(p.name)}${p.towns ? ` — ${esc(p.towns)}` : ""}`],
    ["Length", fmtDist(p.length_m)],
    ["Today", esc(p.cls.replace(/_/g, " "))],
    ["Kind", p.kind === "spot_fix" ? "spot fix (one location)" : "corridor"],
    // join_m is the smaller of the two sides — the streets connected in, not the
    // network they connect to. The /build workspace says it this way too; two
    // surfaces describing one field differently is how a city gets two answers.
    ["Kid-safe streets it would connect in", fmtDist(p.join_m)],
  ];
  if (p.dest_unlocked !== null) {
    rows.push([
      "Schools, playgrounds, libraries on the network it opens",
      String(p.dest_unlocked),
    ]);
  }
  if (p.pop_gaining !== null && headcount) {
    rows.push(["Residents gaining a safe route", Math.round(p.pop_gaining).toLocaleString()]);
  }
  if (p.crashes !== null) rows.push(["Bike crashes since 2021", String(p.crashes)]);
  rows.push([
    "Cost, order of magnitude",
    `$${Math.round(p.cost_proxy).toLocaleString()} — a sorting proxy, not an estimate`,
  ]);

  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(
    `<html><head><title>${esc(p.name)} — where to build</title><style>
      body{font-family:sans-serif;font-size:13px;max-width:640px;margin:24px auto;line-height:1.5}
      h1{font-size:20px;margin:0 0 2px} .sub{color:#555;margin:0 0 14px}
      table{border-collapse:collapse;width:100%;margin-bottom:14px}
      th,td{border-bottom:1px solid #ddd;padding:5px 6px;text-align:left;vertical-align:top}
      th{width:44%;font-weight:600;color:#333}
      .limits{font-size:11.5px;color:#555} .limits li{margin-bottom:3px}
      .method{font-size:11.5px;color:#555;border-top:1px solid #ddd;padding-top:8px}
    </style></head><body>
    <h1>${esc(p.name)}</h1>
    <p class="sub">${esc(p.summary)}</p>
    <table>${rows
      .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
      .join("")}</table>
    <p class="method"><b>How this was measured.</b> Streets a child can't use are
    cut into candidate projects and each is scored on four things: the kid-safe
    streets it would connect in, how much closer it brings people to
    ${meta?.destinations === undefined ? "the" : String(meta.destinations)} schools,
    playgrounds and libraries it counted, its recorded
    bike crashes, and how many residents gain a safe route at all. Population:
    ${esc(meta?.population?.source ?? "not available")}.
    ${esc(meta?.access?.budget_note ?? "")}
    Data built ${esc(meta?.built ?? "—")}; ${meta?.candidates ?? 0} candidates
    were measured.</p>
    <p class="limits"><b>What these numbers do not mean:</b></p>
    <ul class="limits">${(meta?.limits ?? [])
      .map((l) => `<li>${esc(l)}</li>`)
      .join("")}</ul>
    </body></html>`,
  );
  win.document.close();
  win.focus();
  win.print();
}
