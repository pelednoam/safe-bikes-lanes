// Where this app has anything to show: the area the data pipeline builds for
// (pipeline/config.py BBOX_*), which the routing graph, the safety network and
// the basemap (cut to it with a margin, scripts/publish-basemap.sh) all cover.

export interface Box {
  west: number;
  south: number;
  east: number;
  north: number;
}

export const COVERAGE: Box = { west: -71.6, south: 42.0, east: -70.78, north: 42.63 };

/** Where the map opens, and goes back to from outside the area. */
export const HOME = { center: [-71.105, 42.383] as [number, number], zoom: 13 };

/** True when nothing of `view` is inside the area: a map there has nothing to
 * draw, not even a basemap, since the basemap is this area's too. */
export function outsideCoverage(view: Box, area: Box = COVERAGE): boolean {
  const beside = view.east < area.west || view.west > area.east;
  const aboveOrBelow = view.north < area.south || view.south > area.north;
  return beside || aboveOrBelow;
}
