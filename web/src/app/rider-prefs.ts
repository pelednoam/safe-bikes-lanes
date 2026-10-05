// The rider's choices that change every route: who is riding, the hills, how far to
// walk, and the kinds of street to avoid.

import { el } from "./dom.js";
import { AVOIDABLE, store } from "./store.js";
import { requestRoute } from "./plan-route.js";
import { computeShed } from "./shed.js";
import { regradeVisible } from "./search-grade.js";
import { readItem, writeItem } from "../storage.js";
import { syncAvoidSummary } from "./avoid.js";
import { updateHash } from "./permalink.js";



export function initRiderPrefs(): void {
  el<HTMLInputElement>("prefer-flat").addEventListener("change", (e: Event) => {
    store.preferFlat = (e.target as HTMLInputElement).checked;
    void requestRoute();
    void computeShed();
    regradeVisible();
  });

  el<HTMLSelectElement>("walk-max").addEventListener("change", (e: Event) => {
    store.walkMaxM = Number((e.target as HTMLSelectElement).value);
    writeItem("walkMaxM", String(store.walkMaxM));
    void requestRoute();
    regradeVisible();
  });

  // restore the persisted walking budget
  store.walkMaxM = Number(readItem("walkMaxM") ?? "0") || 0;

  el<HTMLSelectElement>("walk-max").value = String(store.walkMaxM);

  for (const [cls] of AVOIDABLE) {
    const box = el<HTMLInputElement>(`avoid-${cls}`);
    box.checked = store.avoidTypes.has(cls);
    box.addEventListener("change", () => {
      if (box.checked) store.avoidTypes.add(cls);
      else store.avoidTypes.delete(cls);
      writeItem("avoidTypes", JSON.stringify([...store.avoidTypes]));
      syncAvoidSummary();
      // Write the permalink NOW, not just when the reroute finishes: the URL is
      // parsed on load and overrides the stored preferences, so a reload (or a
      // shared link) in the seconds after ticking a box used to resurrect the
      // previous set and silently drop the change.
      updateHash();
      void requestRoute();
      // the letters in the search list were computed against the old set
      regradeVisible();
    });
  }

  syncAvoidSummary();

  for (const radio of document.querySelectorAll<HTMLInputElement>("input[name=profile]")) {
    radio.addEventListener("change", () => {
      const v = radio.value;
      if (radio.checked && (v === "young_kids" || v === "older_kids" || v === "solo")) {
        store.profileId = v;
        void requestRoute();
        void computeShed();
        // the letters were the safest route for a different rider; a cache key
        // can stop a stale one being replayed but cannot take down one already
        // on screen
        regradeVisible();
      }
    });
  }
}
