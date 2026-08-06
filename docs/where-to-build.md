# Where to build next — what's built, and what isn't

`pipeline/priorities.py` ranks candidate bike-infrastructure projects for a
city; the app shows them under **🏗 Where to build**. This file records the
edges of what it does, so nobody reads more into the output than is there.

## What it measures

Four things per candidate corridor, all exported raw so the weighting can be
argued with (the panel's sliders re-sort without re-running anything):

| Component | What it is |
|---|---|
| severance | metres of kid-safe network the project would join, counting the **smaller** of the two sides |
| access | resident-metres saved reaching the nearest school, playground or library |
| crash | recorded bike crashes per km (MassDOT IMPACT 2021–26) |
| coverage | residents crossing from "nothing in reach" to "in reach" |

`web/data/priorities_meta.json` carries the provenance and the five stated
limits; the About dialog prints them.

## Spot fixes

A short hostile link between two kid-safe islands is not a corridor project. It's
one location — a signal, a beacon, a protected crossing, a few metres of
separation — and often the cheapest thing a city can actually do this year.

**They are deliberately not called crossings.** That would assert a treatment the
geometry can't support: a 39 m segment carrying the arterial's own name means
riding 39 m *along* the arterial, not across it, and nothing here distinguishes
those two cases. What the data supports is that the link is short, hostile and
load-bearing. Which treatment fits is a designer's call.

They are not a separate search. A spot fix *is* a candidate corridor that happens
to be short (≤ `SPOT_FIX_MAX_M`, 60 m), on a hostile street, joining two islands,
and not already signalized — classified after severance scoring rather than found
separately. The 60 m bound is calibrated, not guessed: island-joining candidates
run 6 at ≤15 m, 9 at 16–30, 9 at 31–45, then 12 more at 46–60 before thinning
out, so an earlier 45 m cut straight through the cluster. Consequences:

- The length floor that drops kerb cuts and driveway stubs (`CANDIDATE_MIN_M`,
  25 m) is applied **after** severance, not during the search. Applying it during
  the search silently threw away every 12 m connector between two islands —
  the best projects on the list — before anything measured them.
- Cost is per location, at signal scale, not per metre. A 14 m spot fix costed by
  length reads as a rounding error and would top any benefit-per-dollar sort.
- Already-signalized links stay classified as corridors: a spot fix at a
  signalized junction is a different and probably bigger job.
- They are exported twice on purpose: in `priorities.geojson` (one list, one
  ranking) and as points in `severance.geojson`, because 14 m of line cannot be
  seen or tapped at the zoom a city looks at.

## Checking the ranking against your own trip

The list asserts a project is worth building; **What if it were protected?**
lets a reader test that. It re-costs the project's edges in the in-browser
router as `separated` — the target class's multiplier on the real length,
without the crash factor or the crossing penalty, which is exactly what the
offline ranking assumes — and re-plans the trip on screen.

- With a trip planned it reports the change in protected share and distance,
  and says plainly when a project isn't on your way rather than implying a
  benefit.
- With no trip it answers with reach instead: how much more kid-safe street
  comes within a 2.5 km perceived-distance ride of your start.
- It always states how many segments it actually matched, so the phrasing can't
  imply more was modelled than was.
- It's a question, not a setting: **undo** restores the real route, and
  selecting a different project clears the previous answer.

One subtlety worth keeping: the first version changed only the *cost*, so the
router happily rode the rebuilt street and then reported the trip as 0%
protected. Everything that describes a route now reads the presented class, so
the route, the percentage, the ribbon and the grade agree.

## The one-pager

**🖨 One-pager** prints a single project: what it is, what it would join, who
gains, its crash history, and an order-of-magnitude cost — followed by how it
was all measured and the same limits the About dialog lists. It deliberately
isn't a screenshot of the panel: a page that gets handed round a meeting is
exactly where a model's caveats go missing, so they're printed on it.

## Not built

- Nothing from the original plan. The remaining ideas are new ones: a
  benefit-per-dollar sort, project bundling (several corridors as one scheme),
  and comparing two data builds to show what a year of construction changed.

## Known limits of what is built

- The unit is a corridor of one street at one class. A project spanning two
  classes appears as two candidates, and a city that would build them together
  sees two rows.
- Unnamed streets (paths, service roads, ramps) rank on the same footing as
  named ones and read as "unnamed street" in the list. They're real, but harder
  to act on from a list without looking at the map.
- Population is spread evenly over the street nodes inside each census block
  group. That's better than a centroid — which can land across the very
  arterial being measured — but it isn't a dwelling-level allocation.
- The access budget is 2,500 m of *perceived* distance, which is roughly
  1.8–2.5 km of real distance depending on street type. Unsafe streets are
  priced at up to 25x rather than excluded, so "can't reach" means "not within
  the budget", not "physically impossible".
- Cost is `length x a unit rate`: an order-of-magnitude proxy for sorting, not
  an estimate. Real costs move by an order of magnitude with drainage, parking
  removal and signals.
- Crash data reflects reported crashes on streets people already ride. A street
  nobody dares ride has no crashes on it, which is the opposite of safe.
