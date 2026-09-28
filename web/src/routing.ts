// ---------------------------------------------------------------------------
// Routing, as it runs in its Web Worker (routing.worker.ts).
//
// Finding a route is a few hundred milliseconds of Dijkstra on a laptop for a
// trip across town and over a second corner to corner, several times that on a
// phone; loading the tiles under it is JSON parsing on the same scale. On the
// page's own thread that is time the map can't pan, the buttons can't press and
// the progress line can't move. So the tiles, the graph and every search live
// here, and the page asks (rpc.ts).
//
// This module is the worker's whole state and API, kept free of the worker
// itself so tests can call it directly.
// ---------------------------------------------------------------------------

import { type DataSource, loadJsonFrom, SiteTileMissing } from "./data.js";
import { type OptionsRouter, planOptions, type RoutePrefs, withUpgraded } from "./planner.js";
import { Router } from "./router.js";
import { TileStore } from "./tiles.js";
import type { PoiFeature, ProfileId, ProtectionClass, RouteOption, ShedResult } from "./types.js";
import { setUnits, type Units } from "./units.js";

/** RoutePrefs as they cross to the worker: a Set arrives as a Set, but a
 * ReadonlySet type does not say so, and this is the one shape both sides use. */
export type WirePrefs = Omit<RoutePrefs, "avoid"> & { avoid: ProtectionClass[] };

export interface LoopAnswer {
  option: RouteOption;
  poi: PoiFeature | null;
  more: { option: RouteOption; poi: PoiFeature | null }[];
}

export interface RoutingApi {
  /** Where to load data from, and the rider's units (the router's own text,
   * "why this route", is written in them). Call first, and again on change. */
  configure(source: DataSource, units: Units): void;
  loadManifest(): Promise<void>;
  /** Load the tiles along `points`, `marginCells` wide, and rebuild the graph
   * over them if that added any. False when there is nothing to route on here. */
  ensure(
    points: [number, number][],
    marginCells: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ready: boolean; rebuilt: boolean }>;
  /** Route options from `from` to `to`, with every preference the rider has
   * set (the type requires them all; see planOptions); `heading` steers them
   * the rider's way. */
  plan(
    from: [number, number],
    to: [number, number],
    prefs: WirePrefs,
    heading?: number,
  ): RouteOption[];
  /** The same, with a proposed lane built: applied for this one search. */
  planWith(
    upgraded: [number, number][],
    from: [number, number],
    to: [number, number],
    prefs: WirePrefs,
  ): { covered: number; result: RouteOption[] };
  loopRoute(
    start: [number, number],
    targetM: number,
    pois: PoiFeature[] | null,
    profileId: ProfileId,
    preferFlat: boolean,
  ): LoopAnswer;
  safeShed(center: [number, number], budgetM: number, profileId: ProfileId, preferFlat: boolean): ShedResult;
  safeShedWith(
    upgraded: [number, number][],
    center: [number, number],
    budgetM: number,
    profileId: ProfileId,
    preferFlat: boolean,
  ): { covered: number; result: ShedResult };
  nearestReachable(
    from: [number, number],
    targets: [number, number][],
    profileId: ProfileId,
    preferFlat: boolean,
  ): number | null;
  edgeClassAt(lon: number, lat: number): ProtectionClass | null;
  streetNameAt(lon: number, lat: number, maxM: number): string | null;
  /** What routes avoid: the rider's sketchy marks and hazard reports, and
   * construction zones. Kept here and re-applied whenever the graph is rebuilt. */
  setSketchyMarks(points: [number, number][]): void;
  setConstructionPoints(points: [number, number][]): void;
}

export function createRoutingApi(
  load: (source: DataSource, name: string) => Promise<unknown> = loadJsonFrom,
): RoutingApi {
  let source: DataSource = { remoteId: null, bundled: "data/" };
  /** Routing has gone to the bundle's tiles for the rest of this session. */
  let onBundle = false;
  let switching: Promise<void> | null = null;
  const store = (): TileStore => new TileStore(<T>(name: string) => load(source, name) as Promise<T>);
  let tiles = store();
  let router: Router | null = null;
  let builtTileCount = -1;
  let sketchy: [number, number][] = [];
  let construction: [number, number][] = [];

  const need = (): Router => {
    if (router === null) throw new Error("this area isn't mapped for routing yet");
    return router;
  };
  const prefsOf = (p: WirePrefs): RoutePrefs => ({ ...p, avoid: new Set(p.avoid) });
  const options = (
    r: OptionsRouter,
    from: [number, number],
    to: [number, number],
    prefs: WirePrefs,
    bias?: Map<number, number>,
  ): RouteOption[] => planOptions(r, from, to, prefsOf(prefs), bias);

  /** Run `work` on the site's tiles, and if one of them (or their manifest)
   * can't be had, on the bundle's instead. A tile of the site's newer build
   * that can't be had (offline, and not cached yet) can't be filled in from
   * the bundle's: the two builds' tiles don't join. The bundle's whole set
   * does, so routing goes on there, a little older, rather than stopping. */
  const onSite = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof SiteTileMissing) || onBundle) throw err;
      // one switch, however many loads failed together
      switching ??= (async () => {
        onBundle = true;
        source = { ...source, remoteId: null };
        tiles = store();
        router = null;
        builtTileCount = -1;
        await tiles.loadManifest();
      })();
      await switching;
      return work();
    }
  };

  return {
    configure(src, units) {
      // once on the bundle's tiles, staying there: switching back mid-session
      // (the page configures again whenever the units change) would join the
      // site's tiles to the bundle's again
      source = onBundle ? { ...src, remoteId: null } : src;
      setUnits(units);
    },
    loadManifest: () => onSite(() => tiles.loadManifest()),
    async ensure(points, marginCells, onProgress) {
      await onSite(() => tiles.ensureCorridor(points, marginCells, onProgress));
      if (tiles.loadedCount === 0) return { ready: false, rebuilt: false };
      if (router !== null && builtTileCount === tiles.loadedCount) return { ready: true, rebuilt: false };
      router = new Router(tiles.assemble());
      builtTileCount = tiles.loadedCount;
      router.setSketchyMarks(sketchy);
      router.setConstructionPoints(construction);
      return { ready: true, rebuilt: true };
    },
    plan(from, to, prefs, heading) {
      const r = need();
      return options(r, from, to, prefs, heading === undefined ? undefined : r.headingBias(from, heading));
    },
    planWith(upgraded, from, to, prefs) {
      const r = need();
      return withUpgraded(r, upgraded, () => options(r, from, to, prefs));
    },
    loopRoute: (start, targetM, pois, profileId, preferFlat) =>
      need().loopRoute(start, targetM, pois, profileId, preferFlat),
    safeShed: (center, budgetM, profileId, preferFlat) =>
      need().safeShed(center, budgetM, profileId, preferFlat),
    safeShedWith(upgraded, center, budgetM, profileId, preferFlat) {
      const r = need();
      return withUpgraded(r, upgraded, () => r.safeShed(center, budgetM, profileId, preferFlat));
    },
    nearestReachable: (from, targets, profileId, preferFlat) =>
      need().nearestReachable(from, targets, profileId, preferFlat),
    edgeClassAt: (lon, lat) => router?.edgeClassAt(lon, lat) ?? null,
    streetNameAt: (lon, lat, maxM) => router?.streetNameAt(lon, lat, maxM) ?? null,
    setSketchyMarks(points) {
      sketchy = points;
      router?.setSketchyMarks(points);
    },
    setConstructionPoints(points) {
      construction = points;
      router?.setConstructionPoints(points);
    },
  };
}
