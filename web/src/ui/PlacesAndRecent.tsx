// The saved places and the recent routes under the search box. Both lists live
// in localStorage (places.ts), which is their state: the app reads them and
// draws them here, instead of emptying the boxes and building every row again
// by hand. The markup and classes are the ones the page, its styles and its
// tests have always had. Names are text: a place is named by whoever saved it.
import { emojiFor, type RecentRoute, type SavedPlace } from "../places.js";
import { fmtDist } from "../units.js";

export interface SavedPlacesProps {
  places: SavedPlace[];
  onUse(place: SavedPlace, as: "start" | "end"): void;
  onDelete(place: SavedPlace): void;
}

export function SavedPlaces({ places, onUse, onDelete }: SavedPlacesProps) {
  return (
    <>
      {places.map((place) => (
        // the store keeps one place per name: saving a name again replaces it
        <div class="search-row" key={place.name}>
          <span>{`${emojiFor(place.name)} ${place.name}`}</span>
          <button onClick={() => onUse(place, "start")}>start</button>
          <button onClick={() => onUse(place, "end")}>end</button>
          <button title="delete place" onClick={() => onDelete(place)}>
            ✕
          </button>
        </div>
      ))}
    </>
  );
}

/** How many of the remembered routes are offered. */
export const RECENT_SHOWN = 5;

export interface RecentRoutesProps {
  routes: RecentRoute[];
  onPlan(s: [number, number], e: [number, number]): void;
  onClear(): void;
}

export function RecentRoutes({ routes, onPlan, onClear }: RecentRoutesProps) {
  if (routes.length === 0) return null;
  return (
    <>
      {routes.slice(0, RECENT_SHOWN).map((route) => (
        <div class="search-row" key={`${route.t}|${route.label}`}>
          <span
            title="plan this route again"
            style={{ cursor: "pointer" }}
            onClick={() => onPlan(route.s, route.e)}
          >
            {`🕘 ${route.label} · ${fmtDist(route.km * 1000)}`}
          </span>
          <button title="plan the reverse direction" onClick={() => onPlan(route.e, route.s)}>
            ⇄
          </button>
        </div>
      ))}
      <button
        title="clear recent routes"
        style={{ marginTop: "4px", padding: "1px 8px", fontSize: "13px" }}
        onClick={onClear}
      >
        clear history
      </button>
    </>
  );
}
