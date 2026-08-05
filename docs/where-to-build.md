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

## Not built

- **Crossing projects.** The plan included "add a signal here" candidates —
  zero-length projects where two kid-safe islands meet across an unsignalized
  arterial. The `kind: "crossing"` field exists and is never set, and there is
  no `severance.geojson`. These are often the cheapest real interventions, so
  this is the most valuable thing still missing.
- **A "what if we built this" simulator.** Phase 4.
- **Printable per-project one-pagers.** Phase 4; the CSV export works.

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
