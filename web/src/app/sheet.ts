// The bottom sheet on a phone: its three heights, dragging it, revealing the
// route's options, and keeping the page from scrolling under it.

import { el } from "./dom.js";
import { store } from "./store.js";

// draggable bottom-sheet (mobile): peek / half / full snap states
const SHEET_STATES = ["peek", "half", "full"] as const;

export type SheetState = (typeof SHEET_STATES)[number];

/** The layout where the panel is a bottom sheet — the same query the CSS uses. */
export const sheetLayout = window.matchMedia("(max-width: 760px), (max-height: 500px)");

/** The half sheet's max-height, as a share of the screen (#panel.half). */
export const SHEET_HALF = 0.52;

export function setSheet(state: SheetState): void {
  const panel = el<HTMLDivElement>("panel");
  panel.style.maxHeight = "";
  panel.classList.remove("peek", "half", "full");
  panel.classList.add(state);
  const handle = el<HTMLButtonElement>("sheet-handle");
  handle.setAttribute("aria-expanded", String(state !== "peek"));
  handle.setAttribute(
    "aria-label",
    `Panel size: ${state === "peek" ? "collapsed" : state === "half" ? "half open" : "fully open"}`,
  );
}

export function currentSheet(): SheetState {
  const panel = el<HTMLDivElement>("panel");
  return SHEET_STATES.find((s) => panel.classList.contains(s)) ?? "half";
}

/** The trip whose answer was last brought into view, so a re-plan of the same
 * trip (a preference changed, further down the sheet) does not yank the reader
 * away from what they were changing. */
let revealedTrip = "";

/** Set when the next panel repaint should bring the route options into view. */
let scrollToOptions = false;

/** After a route computes, make sure the sheet is at least half-open (mobile),
 * and that the answer is what it shows.
 *
 * "half" alone was not enough: measured on a 390x820 phone, the round-trip
 * block, Recent routes and the rider switch filled the half-open sheet, and "3
 * ROUTE OPTIONS" started at y=784 — the grade and ▶ Navigate needed a scroll
 * nothing hinted at. A new trip now scrolls its options to the top of the
 * sheet; ▶ Navigate is kept at the sheet's foot by CSS. */
export function revealSheet(): void {
  const wasPeek = currentSheet() === "peek";
  if (wasPeek) setSheet("half");
  if (!sheetLayout.matches) return;
  const s = store.start?.getLngLat();
  const e = store.end?.getLngLat();
  const trip =
    s && e ? `${s.lng.toFixed(5)},${s.lat.toFixed(5)}>${e.lng.toFixed(5)},${e.lat.toFixed(5)}` : "";
  if (!wasPeek && trip === revealedTrip) return;
  revealedTrip = trip;
  scrollToOptions = true;
}

/** Scroll the sheet so the route options sit just under its handle. */
export function showOptionsInSheet(): void {
  if (!scrollToOptions) return;
  scrollToOptions = false;
  if (!sheetLayout.matches || document.body.classList.contains("searching")) return;
  const panel = el<HTMLDivElement>("panel");
  const top = el<HTMLDivElement>("options").getBoundingClientRect().top;
  const handle = el<HTMLButtonElement>("sheet-handle").offsetHeight;
  panel.scrollTop += top - (panel.getBoundingClientRect().top + handle + 6);
}

/** iOS scrolls the whole page to bring a focused field above its keyboard, and
 * does not always scroll it back when the keyboard goes: the map and the sheet
 * were left shifted up by the keyboard's height. Nothing here is meant to
 * scroll the page itself, so any offset is leftover. */
export function resetPageScroll(): void {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
}

export function initSheet(): void {
  const panel = el<HTMLDivElement>("panel");
  const handle = el<HTMLButtonElement>("sheet-handle");
  // start collapsed: the map is the point, and a route expands the sheet
  // to "half" on its own (revealSheet)
  if (sheetLayout.matches) setSheet("peek");
  let dragging = false;
  let startY = 0;
  let startH = 0;
  let moved = 0;
  let liveH = 0;
  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    dragging = true;
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    liveH = startH;
    moved = 0;
    // kill the max-height transition for the duration: with it on, the sheet
    // lags ~200 ms behind the thumb and the drag feels broken
    panel.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e: PointerEvent) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    moved = Math.max(moved, Math.abs(dy));
    liveH = Math.min(window.innerHeight * 0.88, Math.max(70, startH + dy));
    panel.classList.remove("peek", "half", "full");
    panel.style.maxHeight = `${liveH}px`;
  });
  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("dragging");
    // snap from where the drag actually ended, not from a mid-animation
    // measurement of the element
    const h = liveH;
    panel.style.maxHeight = "";
    if (moved < 6) {
      // a tap cycles peek -> half -> full -> peek
      const next = SHEET_STATES[(SHEET_STATES.indexOf(currentSheet()) + 1) % 3];
      setSheet(next ?? "half");
      return;
    }
    const vh = window.innerHeight;
    setSheet(h < vh * 0.25 ? "peek" : h < vh * 0.68 ? "half" : "full");
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  // From a keyboard (or a switch, or a screen reader's double-tap, which
  // arrives as a click with no pointer before it): Enter and Space step through
  // the sizes as a tap does; the arrows open and close.
  handle.addEventListener("click", (e: MouseEvent) => {
    if (e.detail !== 0) return; // a real pointer tap, already handled by end()
    const next = SHEET_STATES[(SHEET_STATES.indexOf(currentSheet()) + 1) % 3];
    setSheet(next ?? "half");
  });
  handle.addEventListener("keydown", (e: KeyboardEvent) => {
    const i = SHEET_STATES.indexOf(currentSheet());
    const to =
      e.key === "ArrowUp"
        ? SHEET_STATES[Math.min(2, i + 1)]
        : e.key === "ArrowDown"
          ? SHEET_STATES[Math.max(0, i - 1)]
          : undefined;
    if (to === undefined) return;
    e.preventDefault();
    setSheet(to);
  });
  // some WebViews revoke capture mid-gesture; without this the sheet sticks
  handle.addEventListener("lostpointercapture", end);

  window.visualViewport?.addEventListener("resize", () => {
    if (!document.body.classList.contains("searching")) resetPageScroll();
  });
}
