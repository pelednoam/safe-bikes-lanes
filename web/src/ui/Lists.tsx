// Two lists the rider keeps: the spots they marked to avoid, and the rides
// they recorded. Both live on the device (app.ts loadSketchy, rides.ts), drawn
// here from what is stored, with the markup and ids the page and its tests
// have always had.
import type { RideSummary, RideTotals } from "../rides.js";
import { fmtDist, fmtSpeed, fromMeters, unitShort } from "../units.js";

export interface SketchyListProps {
  marks: [number, number][];
  onFly(mark: [number, number]): void;
  onRemove(index: number): void;
}

/** The marked spots: each one flies the map there, or goes. */
export function SketchyList({ marks, onFly, onRemove }: SketchyListProps) {
  return (
    <>
      {marks.map((mark, i) => (
        // numbered by position, as the rider sees them, so a key by index
        <div class="sketchy-row" key={`${i}|${mark[0]},${mark[1]}`}>
          <span style={{ cursor: "pointer" }} title="fly to" onClick={() => onFly(mark)}>
            {`⚠ marked spot ${i + 1}`}
          </span>
          <button title="remove" onClick={() => onRemove(i)}>
            ✕
          </button>
        </div>
      ))}
    </>
  );
}

/** The line over the rides: how much, and how safely, or how to start. */
export function RideTotalsLine({ totals }: { totals: RideTotals | null }) {
  if (totals === null) {
    return <>No rides yet — rides are saved automatically when you Navigate, or use ● Record.</>;
  }
  return (
    <>
      <b>{totals.count}</b> {totals.count === 1 ? "ride" : "rides"} · <b>{fmtDist(totals.km * 1000)}</b> total · <b>{totals.movingHours} h</b>{" "}
      moving · longest <b>{fmtDist(totals.longestKm * 1000)}</b> · this month{" "}
      <b>{fmtDist(totals.thisMonthKm * 1000)}</b> · avg <b>{totals.avgProtectedPct}%</b> protected
    </>
  );
}

export interface RideListProps {
  rides: RideSummary[];
  onMap(ride: RideSummary): void;
  /** A finger landed on a ride's share button: draw its card now, so it is
   * usually ready by the click. */
  onSharePrepare(ride: RideSummary): void;
  onShare(ride: RideSummary, button: HTMLElement): void;
  onDelete(ride: RideSummary): void;
}

/** The rides, one row each, in the order stored. */
export function RideList({ rides, onMap, onSharePrepare, onShare, onDelete }: RideListProps) {
  if (rides.length === 0) return null;
  return (
    <tbody>
      <tr>
        <th>date</th>
        <th>{unitShort()}</th>
        <th>moving</th>
        <th>avg</th>
        <th>protected</th>
        <th />
      </tr>
      {rides.map((ride) => (
        <tr key={ride.id}>
          <td>{new Date(ride.startedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</td>
          <td>{fromMeters(ride.meters).toFixed(1)}</td>
          <td>{`${Math.round(ride.movingS / 60)} min`}</td>
          <td>{ride.movingS > 0 ? fmtSpeed(ride.meters / ride.movingS) : "–"}</td>
          <td>{`${ride.pctProtected}% + ${ride.pctQuiet}% quiet`}</td>
          <td>
            <button onClick={() => onMap(ride)}>map</button>
            <button
              title="share this ride (stats card + text)"
              onPointerDown={() => onSharePrepare(ride)}
              onClick={(e) => onShare(ride, e.currentTarget)}
            >
              📤
            </button>
            <button onClick={() => onDelete(ride)}>✕</button>
          </td>
        </tr>
      ))}
    </tbody>
  );
}
