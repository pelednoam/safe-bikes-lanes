# Ride audit: what the simulated riders found, and what is still open

Six simulated riders rode the app end to end (see `web/tests-e2e-ride/`) and
reported roughly forty problems. Most are fixed, and each fix has an assertion
in `web/tests-e2e-ride/regression.spec.ts` or `ride.spec.ts` so "fixed" is
checkable rather than claimed. This file is the other half: what they reported
that is **still open**, and why.

## Open, with reasons

| Finding | Why it is still open |
|---|---|
| Basemap labels ride upside-down and drift south of their street when the map is rotated to the heading | The basemap is raster tiles, which rotate as pictures — labels included. Fixing it means a vector basemap (style + glyphs + sprite, self-hosted or keyed), which is a bigger change than the rest of this list combined. |
| Street name is smaller than the distance-to-turn readout | Both riders who mentioned it wanted the opposite hierarchy, but they disagreed with each other about which should dominate, and the banner is already at its height budget. Needs a decision, not a patch. |
| Reporting a hazard is still a form: pick a kind, optionally type a note, submit | Three taps at 12 km/h. The right fix is a one-tap "mark this spot" that files the position immediately and asks what it was afterwards — a change to the reporting model, not the dialog. The dialog is at least reachable, legible and dismissable now (asserted). |
| A second right-click on the map can leave two street cards up | Desktop only, and only with the context menu involved; no effect on riding. |
| The route polyline paints a beat after the summary numbers appear | The numbers come from the router synchronously; the line waits for a map frame. Cosmetic, and chasing it risks the paint-order fixes already in place. |
| Opening a permalink leaves the destination field blank even though a destination is set | The field shows what you typed, and nobody typed anything. Filling it with `-71.0867, 42.3626` was worse in review; it wants reverse geocoding. |
| Voice rounds differently from the screen ("in 300 metres" while the banner reads 280 m) | Deliberate: speech rounds to numbers you can hear and act on, the screen shows the measurement. Left as is, recorded here because two riders flagged it as a bug. |

## Not reproducible / rejected

- "The map fights me when I pan" — the follow camera does resume after
  `REFOLLOW_MS`, which is the intent; the rider expected it never to resume.
- "It rerouted behind my back" — it announced the reroute; the rider had muted
  it. Muting now still speaks safety-class warnings (asserted).

## Corners the sweep does not cover

The regression sweep asserts behaviour, not appearance. Font rendering, colour
contrast in sunlight, and glove-on tap accuracy were rider judgements and are
not automatable here; the sizes and gaps they led to (56 px minimum control,
≥10 px between adjacent controls) are asserted, the judgement behind them is
not.
