# Ride audit: what the simulated riders found, and how it was answered

Six simulated riders rode the app end to end (see `web/tests-e2e-ride/`) and
reported roughly forty problems. Every one of them now has an assertion in
`web/tests-e2e-ride/regression.spec.ts`, `ride.spec.ts` or
`web/tests-e2e/plan.spec.ts`, so "fixed" is checkable rather than claimed.

The first sweep left seven open. This is what each of them turned out to need.

| Finding | What it took |
|---|---|
| Basemap labels ride upside-down and drift south of their street when the map turns to the heading | Raster tiles rotate as pictures, labels included, so the labels had to stop being part of the picture. Riding now switches to a label-free basemap (CARTO `light_nolabels` / `dark_nolabels`) and draws street names from the safety network as a real symbol layer, which MapLibre keeps upright at any bearing. Needs SDF glyphs, so two Noto Sans ranges are vendored in `web/fonts/glyphs/` and precached by the service worker — labels work on an offline ride. The offline tile pre-cache fetches the label-free tiles too, since those are the ones a ride displays. |
| Street name is smaller than the distance-to-turn readout | A decision, not a patch: the distance keeps the largest type because it is the cue you act on, but 16 px against 34 px made the street name a caption beside a headline. It is now 21 px against 31 px — the second line of one instruction. |
| Reporting a hazard is still a form: pick a kind, optionally type a note, submit | Inverted: one tap files the report where you are, and the app asks what it was afterwards, in one tap each (surface / blocked / traffic). Ignore the question and the report stands as "other hazard"; tapping report twice in one spot amends rather than files a second. The full form is still how you report from the planning map, where you can read and type. |
| A second right-click can leave two street cards up | The spot menu is a single popup now, and opening it closes the hover card describing the same street. |
| The route polyline paints a beat after the summary numbers appear | The line goes through MapLibre's worker while the summary is a synchronous DOM write. The panel now waits for a frame in which the route layer has actually rendered — not merely for the source to report loaded, which is what "the data is set" means and is a frame or two early. A map that isn't rendering at all (hidden tab, no WebGL) releases the panel after 600 ms, and a busy one after 3 s, so the numbers are never held hostage. |
| Opening a permalink leaves the destination field blank | Reverse geocoded through Nominatim, cached per ~11 m, and never blocking the route: a name is a nicety, the route is the product. Anything you typed wins, including after the pin is dragged. |
| Voice rounds differently from the screen ("in 300 metres" while the banner reads 280 m) | The riders were right and the old defence was wrong. One bucketing (10 m under 100, 50 m under 500, 100 m above) now feeds both the banner and the voice, coarse enough to say out loud. |

## Not reproducible / rejected

- "The map fights me when I pan" — the follow camera does resume after
  `REFOLLOW_MS`, which is the intent; the rider expected it never to resume.
- "It rerouted behind my back" — it announced the reroute; the rider had muted
  it. Muting now still speaks safety-class warnings (asserted).

## Known limits of the fixes

- Street labels while riding come from our own network, so they cover the towns
  the pipeline covers and no further. Rides start inside that area by
  construction, but a ride that left it would lose names rather than show
  upside-down ones.
- The end names need the network the first time a spot is seen. Offline, the
  fields fall back to their placeholders.
- The panel waits up to 3 s for the map to draw the line and then shows the
  numbers regardless. On a cold map under heavy load the old ordering can still
  happen — the alternative is a summary that hangs on a map that cannot render.
- The classification question times out after 20 s. A rider who never answers
  leaves an "other hazard" on the map, which still routes around correctly.

## Corners the sweep does not cover

The regression sweep asserts behaviour, not appearance. Font rendering, colour
contrast in sunlight, and glove-on tap accuracy were rider judgements and are
not automatable here; the sizes and gaps they led to (56 px minimum control,
≥10 px between adjacent controls, 21 px street name) are asserted, the
judgement behind them is not.
