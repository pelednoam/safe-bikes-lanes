// The ride history dialog: each recorded ride's row, its share card, drawing it on
// the map, and the totals.

import { type RideSummary, clearRides, deleteRide, loadRides, rideTotals, saveRide, takeInProgress } from "../rides.js";
import { getSource } from "./sources.js";
import { map } from "./map.js";
import { PreparedImage, saveBlob, shareImage } from "../share.js";
import { drawRideCard, drawTotalsCard, rideShareText, totalsShareText } from "../sharecard.js";
import { h, render } from "preact";
import { RideList, RideTotalsLine } from "../ui/Lists.js";
import { el, emptyFC } from "./dom.js";

function showRideOnMap(ride: RideSummary): void {
  getSource("history").setData({
    type: "Feature",
    geometry: { type: "LineString", coordinates: ride.polyline },
    properties: {},
  } as GeoJSON.GeoJSON);
  const lons = ride.polyline.map((p) => p[0]);
  const lats = ride.polyline.map((p) => p[1]);
  if (lons.length > 1) {
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 60, duration: 800 },
    );
  }
}

/** Share a stats card from a tap (see share.ts): the share sheet when the card
 * is ready and the browser has one, otherwise the picture saved and the text
 * copied — with the button saying so, instead of nothing happening. */
function shareCard(text: string, image: PreparedImage, filename: string, btn: HTMLElement): void {
  void shareImage(text, image, filename, {
    canShare: typeof navigator.canShare === "function" ? (d) => navigator.canShare(d) : undefined,
    share: typeof navigator.share === "function" ? (d) => navigator.share(d) : undefined,
    copy: (t) => navigator.clipboard.writeText(t),
    // in the app a save can fail, and shareImage says so
    download: (b, f) => saveBlob(b, f),
    tell: (message, ok) => {
      const prev = btn.textContent;
      // a tick over "Picture not saved" said two opposite things at once
      btn.textContent = `${ok ? "✓" : "⚠"} ${message}`;
      window.setTimeout(() => {
        btn.textContent = prev;
      }, 2500);
    },
  });
}

/** Cards drawn ahead of the tap, so share() can run inside it. */
let totalsCard: PreparedImage | null = null;
const rideCards = new Map<string, PreparedImage>();

function rideCard(ride: RideSummary): PreparedImage {
  let card = rideCards.get(ride.id);
  if (card === undefined) {
    card = new PreparedImage(drawRideCard(ride));
    rideCards.set(ride.id, card);
  }
  return card;
}

export function renderRides(): void {
  const rides = loadRides();
  render(
    h(RideTotalsLine, { totals: rides.length === 0 ? null : rideTotals(rides, new Date()) }),
    el<HTMLDivElement>("ride-totals"),
  );
  el<HTMLButtonElement>("rides-share").style.display = rides.length === 0 ? "none" : "inline-block";
  render(
    h(RideList, {
      rides,
      onMap: (ride) => {
        showRideOnMap(ride);
        el<HTMLDialogElement>("rides").close();
      },
      onSharePrepare: (ride) => {
        rideCard(ride);
      },
      onShare: (ride, button) => {
        shareCard(rideShareText(ride), rideCard(ride), "bike-ride.png", button);
      },
      onDelete: (ride) => {
        deleteRide(ride.id);
        renderRides();
      },
    }),
    el<HTMLTableElement>("ride-list"),
  );
}

export function initRidesDialog(): void {
  el<HTMLButtonElement>("rides-btn").addEventListener("click", () => {
    renderRides();
    // the totals card is drawn while the list is read, not after the tap
    const rides = loadRides();
    rideCards.clear();
    totalsCard = rides.length > 0 ? new PreparedImage(drawTotalsCard(rideTotals(rides, new Date()))) : null;
    el<HTMLDialogElement>("rides").showModal();
  });

  el<HTMLButtonElement>("rides-close").addEventListener("click", () => {
    el<HTMLDialogElement>("rides").close();
  });

  el<HTMLButtonElement>("rides-share").addEventListener("click", () => {
    const totals = rideTotals(loadRides(), new Date());
    totalsCard ??= new PreparedImage(drawTotalsCard(totals));
    shareCard(totalsShareText(totals), totalsCard, "bike-stats.png", el("rides-share"));
  });

  el<HTMLButtonElement>("rides-clear").addEventListener("click", () => {
    clearRides();
    getSource("history").setData(emptyFC());
    renderRides();
  });

  el<HTMLDialogElement>("rides").addEventListener("click", (e: MouseEvent) => {
    if (e.target === el<HTMLDialogElement>("rides")) el<HTMLDialogElement>("rides").close();
  });
}

/** A ride interrupted by Back, a reload or a crash is saved on the next launch rather than
 * silently lost. */
export function recoverInterruptedRide(): void {
  const interrupted = takeInProgress();
  if (interrupted !== null) {
    saveRide(interrupted);
    renderRides();
  }
}
