// Search on a phone: the sheet gives way to the keyboard and the list, and comes
// back; and the From field's two buttons, back to your own location or the next map
// tap.
//
// The sheet starts collapsed at the bottom of the screen, which is exactly
// where the keyboard opens. Measured on a 390x820 phone: tap "Where to?", type
// "Davis", and the field sat at y=760-800 under a keyboard starting around 480,
// while five results rendered at y=932 — below the screen, and clipped anyway
// by the collapsed sheet's overflow. People were typing into a field they could
// not see and getting answers they could not reach.
//
// It is worst in the Android app. Targeting SDK 35+ forces edge-to-edge, where
// the keyboard overlays the WebView instead of resizing it, so nothing on the
// page even learns the keyboard is there. Rather than depend on that — it
// differs by Android version, WebView, and browser — searching moves the field
// to the top of the screen, where no keyboard reaches, and puts the answers
// directly under it.

import { links } from "./links.js";
import { el } from "./dom.js";
import { store } from "./store.js";
import { clearSearchResults } from "./search-results.js";
import { syncOD } from "./markers.js";
import { type SheetState, currentSheet, resetPageScroll, setSheet, sheetLayout } from "./sheet.js";

/** Where the sheet was before a search took it over, to put it back. */
let sheetBeforeSearch: SheetState | null = null;

export function enterSearchMode(field: HTMLInputElement): void {
  if (!sheetLayout.matches) return;
  if (sheetBeforeSearch === null) sheetBeforeSearch = currentSheet();
  document.body.classList.add("searching");
  const panel = el<HTMLDivElement>("panel");
  // Open at once, not over the 0.2 s transition. Animated, the sheet was still
  // growing when the field was lifted, so the lift ran twice (now and 250 ms
  // later) and iOS, scrolling the focused field into view on its own schedule,
  // could act on either height. "dragging" is the class that already turns the
  // transition off; measuring below forces the full height to apply under it.
  panel.classList.add("dragging");
  setSheet("full");
  // Field to the top of the sheet, just under its (sticky) handle.
  const handle = el<HTMLButtonElement>("sheet-handle");
  const lift = (): void => {
    const gap = field.getBoundingClientRect().top - panel.getBoundingClientRect().top;
    panel.scrollTop += gap - handle.offsetHeight - 6;
  };
  lift();
  window.requestAnimationFrame(() => {
    panel.classList.remove("dragging");
    // content hidden a moment ago (the loop block) may have changed the layout
    lift();
  });
}

/** Leave search mode. `chose` means a place was picked, so the sheet should
 * show the route that is about to appear rather than go back to how it was. */
export function leaveSearchMode(chose: boolean): void {
  if (!document.body.classList.contains("searching")) return;
  document.body.classList.remove("searching");
  const before = sheetBeforeSearch ?? "half";
  sheetBeforeSearch = null;
  el<HTMLDivElement>("panel").scrollTop = 0;
  resetPageScroll();
  // A chosen place gets the map back, with the route options under it — "half",
  // the state a computed route asks for anyway (revealSheet). A search walked
  // away from goes back to where it started.
  setSheet(chose ? (before === "full" ? "full" : "half") : before);
}

export function initPhoneSearch(): void {
  links.leaveSearchMode.set(leaveSearchMode);
  el<HTMLButtonElement>("from-locate").addEventListener("click", () => {
    // back to riding from wherever you are
    store.start?.remove();
    store.start = null;
    store.fromCurrent = true;
    store.activeField = "end";
    const f = el<HTMLInputElement>("from-field");
    f.classList.remove("picking");
    f.value = "";
    clearSearchResults();
    syncOD();
    void links.requestRoute.call();
  });

  el<HTMLButtonElement>("from-pick").addEventListener("click", () => {
    // the next map tap sets the start
    store.activeField = "start";
    const f = el<HTMLInputElement>("from-field");
    f.classList.add("picking");
    f.value = "";
    f.placeholder = "tap the map to set the start…";
  });
}
