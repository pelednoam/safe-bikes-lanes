// The two search boxes: typing, picking from the list, the keys, and leaving alone
// a name the rider typed over.

import { paintSearch, searchListShown, searchView } from "./search-view.js";
import { type Candidate, GEOCODE_DEBOUNCE_MS, geocodeDelayMs, rank as rankSearch, worthGeocoding } from "../search.js";
import { chooseSearchRow, clearSearchResults, renderSearchResults } from "./search-results.js";
import { SEARCH_ROWS, geocoderCandidates, localCandidates, searchAddress, searchOrigin, streetCandidates } from "./search-candidates.js";
import { enterSearchMode, leaveSearchMode } from "./phone-search.js";
import { el } from "./dom.js";
import { autoNamed } from "./names.js";

/** When the geocoder was last asked. The policy itself is in search.ts, where it
 * can be tested as arithmetic rather than through browser timing. */
let lastGeocodeAt = 0;

/** Which field the visible result list belongs to.
 *
 * Both fields render into #search-results, and each attachSearch closure captures
 * its own target. A late geocoder answer for the start field could therefore
 * re-render the list while the reader was typing a destination — and every row in
 * it would then set the START when tapped. Wrong point, silently. */
let searchOwner: HTMLInputElement | null = null;

/** Wire an address search to a field, so the origin is searchable too and not
 * only settable by tapping the map or using the current location. */
function attachSearch(input: HTMLInputElement, target: "start" | "end"): void {
  let timer: number | undefined;
  // The geocoder's last answer for the query still in the box, so a keystroke
  // can re-rank without asking again — and so local and remote results appear in
  // one list rather than the local ones being replaced when the network answers.
  let remote: { query: string; rows: Candidate[] } = { query: "", rows: [] };
  /** The row the arrow keys are on, by identity rather than by position. */
  let activeKey: string | null = null;

  const highlight = (key: string | null): void => {
    activeKey = key;
    searchView.active = key;
    paintSearch();
  };

  const show = (q: string): void => {
    if (searchOwner !== input) return; // the other field owns the list now
    const origin = searchOrigin();
    const candidates = [
      ...localCandidates(),
      ...streetCandidates(q, origin),
      ...(remote.query === q ? remote.rows : []),
    ];
    renderSearchResults(rankSearch(q, candidates, { origin, limit: SEARCH_ROWS }), target);
    // put the selection back where it was, or drop it if that place is gone —
    // never leave it pointing at whatever row inherited the position
    highlight(searchView.rows.some((r) => r.key === activeKey) ? activeKey : null);
  };

  input.addEventListener("focus", () => enterSearchMode(input));
  input.addEventListener("blur", () => {
    // Walked away without choosing. Only let the sheet go if nothing is left to
    // tap: blur arrives on touchstart and the click only on touchend, so shrinking
    // the sheet while a list is up would slide the row out from under the finger
    // that was reaching for it. Deferred a tick so focus hopping to the other
    // search field counts as still searching.
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active === el("search") || active === el("from-field")) return;
      if (!searchListShown()) leaveSearchMode(false);
    }, 0);
  });

  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    searchOwner = input;
    const q = input.value.trim();
    if (q === "") {
      clearSearchResults();
      return;
    }
    // Local first, on every keystroke, from the first letter. This is the part
    // that makes the box feel like it is answering rather than thinking: 2,500
    // named places and the streets on screen are already here, and waiting 400 ms
    // to ask a geocoder for what we have on the device is waiting for nothing.
    highlight(null); // a new query is a new list
    show(q);

    // Then the geocoder, for house numbers and businesses we do not have — as a
    // fallback, and on its terms. See worthGeocoding and GEOCODE_MIN_GAP_MS.
    const localHits = searchView.rows.length;
    if (!worthGeocoding(q, localHits)) return;
    timer = window.setTimeout(() => {
      const wait = geocodeDelayMs(Date.now(), lastGeocodeAt);
      if (wait > 0) {
        // too soon: ask again once the floor has passed, rather than dropping the
        // query or hammering the service
        timer = window.setTimeout(() => {
          if (input.value.trim() === q) input.dispatchEvent(new Event("input"));
        }, wait);
        return;
      }
      lastGeocodeAt = Date.now();
      searchAddress(q)
        .then((results) => {
          if (input.value.trim() !== q) return; // a later keystroke moved on
          if (searchOwner !== input) return; // and the other field owns the list
          remote = { query: q, rows: geocoderCandidates(results) };
          // Not while a row is chosen. Re-ranking under a committed selection is
          // how someone ends up riding to a place they did not pick; the answers
          // are kept and merge into the next keystroke's list instead.
          //
          // Deliberately redundant with the highlight restore in show(): either
          // alone keeps the selection, and a test can only kill both together.
          // This one avoids the churn; that one covers re-renders from any other
          // cause, which is where the bug came from in the first place.
          if (activeKey !== null) return;
          show(q);
        })
        .catch(() => {
          // The local list is still on screen and still useful, so this is a
          // footnote rather than an error state — the old code replaced
          // everything with "search unavailable". And only for the query and the
          // field it was asked for: a slow failure used to be able to write over a
          // list the reader had since moved on from.
          if (input.value.trim() !== q || searchOwner !== input) return;
          if (searchView.rows.length === 0) {
            searchView.message = "search unavailable";
            paintSearch();
          }
        });
    }, GEOCODE_DEBOUNCE_MS);
  });

  // Arrow keys and Enter, because a list you can only reach with a mouse is a
  // list you cannot use one-handed.
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    // The keys walk the list as the search's state has it, not as it was drawn.
    const rows = searchView.rows;
    if (rows.length === 0) return;
    const current = rows.findIndex((r) => r.key === searchView.active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next =
        e.key === "ArrowDown" ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0);
      const chosen = rows[next === -1 ? 0 : next];
      highlight(chosen?.key ?? null);
      if (chosen !== undefined) {
        const drawn = el<HTMLDivElement>("search-results").querySelector<HTMLElement>(
          `.search-row[data-key="${CSS.escape(chosen.key)}"]`,
        );
        drawn?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Enter with nothing highlighted takes the first row, which is what the
      // ranking is for: the best answer should need no aiming at all.
      const chosen = rows[current === -1 ? 0 : current];
      if (chosen !== undefined) chooseSearchRow(chosen);
    } else if (e.key === "Escape" && activeKey !== null) {
      // Step back out of the list without wiping the query — and show whatever the
      // geocoder answered while a row was selected, which was deliberately held
      // back then and would otherwise never have appeared at all.
      e.preventDefault();
      e.stopPropagation();
      highlight(null);
      show(input.value.trim());
    }
  });
}

export function initSearchInput(): void {
  attachSearch(el<HTMLInputElement>("search"), "end");

  attachSearch(el<HTMLInputElement>("from-field"), "start");

  // once you type over a name we filled in, it's yours and we leave it alone
  for (const [kind, id] of [
    ["start", "from-field"],
    ["end", "search"],
  ] as const) {
    el<HTMLInputElement>(id).addEventListener("input", () => {
      autoNamed[kind] = false;
    });
  }
}
