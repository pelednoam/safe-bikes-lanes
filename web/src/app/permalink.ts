// The link to this trip: writing the start, end, profile and chosen option into the
// address as the plan changes, reading it back on load and on hashchange, and the
// share button.

import { links } from "./links.js";
import { type Marker } from "maplibre-gl";
import { decodePlan, encodePlan } from "../permalink.js";
import { AVOIDABLE, store } from "./store.js";
import { trip } from "./services.js";
import { el } from "./dom.js";
import { type ProtectionClass } from "../types.js";
import { syncAvoidSummary } from "./avoid.js";
import { fromMeters } from "../units.js";
import { makeMarker, setPoint, syncOD } from "./markers.js";
import { requestLoop } from "./plan-loop.js";

/** The hash this page last wrote or read, so a hashchange can tell a link
 * pasted in from the page's own bookkeeping. */
let lastHash = "";

function lngLatOf(m: Marker): [number, number] {
  const p = m.getLngLat();
  return [p.lng, p.lat];
}

/** Forget the link: the plan it described is gone, so the address goes back to a bare
 * "#" and the next change is not mistaken for one this page made. */
export function forgetLink(): void {
  lastHash = "";
  history.replaceState(history.state, "", "#");
}

export function updateHash(): void {
  const hash = encodePlan({
    // "from where you are" stays that, for whoever opens the link
    start: store.start === null ? null : store.fromCurrent ? "here" : lngLatOf(store.start),
    end: store.loopParams === null && store.end !== null ? lngLatOf(store.end) : null,
    loop: store.loopParams,
    profile: store.profileId,
    flat: store.preferFlat,
    walkM: store.walkMaxM,
    avoid: [...store.avoidTypes],
    option:
      trip.selectedId === "safest" || trip.selectedId === "balanced" || trip.selectedId === "direct"
        ? trip.selectedId
        : null,
  });
  if (hash === null) return;
  lastHash = hash;
  // history.state kept: mid-ride this entry is the one the ride pushed
  history.replaceState(history.state, "", `#${hash}`);
}

export function parseHash(): void {
  lastHash = window.location.hash.replace(/^#/, "");
  const link = decodePlan(window.location.hash);
  if (link.profile !== null) {
    store.profileId = link.profile;
    const radio = document.querySelector<HTMLInputElement>(
      `input[name=profile][value=${link.profile}]`,
    );
    if (radio) radio.checked = true;
  }
  if (link.flat) {
    store.preferFlat = true;
    el<HTMLInputElement>("prefer-flat").checked = true;
  }
  if (link.walkM !== null) {
    store.walkMaxM = link.walkM;
    el<HTMLSelectElement>("walk-max").value = String(store.walkMaxM);
  }
  if (link.avoid !== null) {
    const valid = new Set(AVOIDABLE.map(([c]) => c as string));
    store.avoidTypes = new Set(link.avoid.filter((t) => valid.has(t)) as ProtectionClass[]);
    for (const [cls] of AVOIDABLE) {
      el<HTMLInputElement>(`avoid-${cls}`).checked = store.avoidTypes.has(cls);
    }
    syncAvoidSummary();
  }
  // a link that names no option clears one an earlier link left behind
  store.pendingSelect = link.option;
  const s = link.start;
  if (s !== null && link.loop !== null) {
    // shared loop: restore controls, place the start, and re-plan it
    el<HTMLInputElement>("loop-dist").value = String(
      Math.round(fromMeters(link.loop.km * 1000) * 10) / 10,
    );
    el<HTMLSelectElement>("loop-stop").value = link.loop.kind;
    if (s !== "here") {
      store.fromCurrent = false;
      // one start pin, even if the load-time locate put one down already
      if (store.start) store.start.setLngLat(s);
      else store.start = makeMarker(s, "#2b83ba", "start");
    }
    syncOD();
    void requestLoop();
    return;
  }
  // "here" leaves the start as the rider's own location, found when routing
  if (s !== null && s !== "here") setPoint("start", s);
  if (link.end) setPoint("end", link.end);
}

export function initPermalink(): void {
  links.updateHash.set(updateHash);
  // A link pasted into a tab that already has the app open changes only the
  // hash, which reloads nothing: the old trip stayed on screen and the link did
  // nothing at all. Follow it — unless it is this page's own write coming back
  // (see lastHash), or a ride is under way, which a link does not replace.
  window.addEventListener("hashchange", () => {
    const now = window.location.hash.replace(/^#/, "");
    if (now === lastHash || store.navActive) return;
    links.resetPlan.call(false);
    parseHash();
  });

  // share: Web Share API on mobile, clipboard elsewhere
  el<HTMLButtonElement>("share").addEventListener("click", () => {
    const url = window.location.href;
    const btn = el<HTMLButtonElement>("share");
    const flash = (text: string): void => {
      const prev = btn.textContent;
      btn.textContent = text;
      window.setTimeout(() => {
        btn.textContent = prev;
      }, 1500);
    };
    if (typeof navigator.share === "function") {
      void navigator.share({ title: "Family bike route", url }).catch(() => undefined);
      return;
    }
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        flash("✓ copied");
      })
      .catch(() => {
        window.prompt("copy this link:", url);
      });
  });
}
