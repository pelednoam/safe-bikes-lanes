// The first-run card on a phone: what the app is for, and who is riding.

import { sheetLayout } from "./sheet.js";
import { el } from "./dom.js";
import { classSwatch } from "./classes.js";
import { type ProtectionClass } from "../types.js";

/** Remembered once dismissed; a phone that has seen it once does not again. */
const FIRST_RUN_KEY = "firstRunSeen";

/** The first-run card on a phone (see #first-run in index.html): what the app
 * is for, what the line colours and marks mean, and who is riding — the one
 * choice that changes every route, which otherwise sat below the fold. */
export function initFirstRun(): void {
  let seen = false;
  try {
    seen = localStorage.getItem(FIRST_RUN_KEY) === "1";
  } catch {
    /* private mode: show it, it just won't be remembered */
  }
  if (seen || !sheetLayout.matches) return;
  const card = el<HTMLElement>("first-run");
  for (const slot of card.querySelectorAll<HTMLElement>("[data-swatch]")) {
    slot.innerHTML = classSwatch(slot.dataset["swatch"] as ProtectionClass, 28, 12);
  }
  const who = [...card.querySelectorAll<HTMLButtonElement>("[data-profile]")];
  const sync = (): void => {
    const current = document.querySelector<HTMLInputElement>("input[name=profile]:checked")?.value;
    for (const b of who) b.setAttribute("aria-pressed", String(b.dataset["profile"] === current));
  };
  for (const b of who) {
    b.addEventListener("click", () => {
      const radio = document.querySelector<HTMLInputElement>(
        `input[name=profile][value="${b.dataset["profile"] ?? ""}"]`,
      );
      if (radio === null || radio.checked) return;
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
    });
  }
  // the same choice made in the panel shows here too
  for (const radio of document.querySelectorAll<HTMLInputElement>("input[name=profile]")) {
    radio.addEventListener("change", sync);
  }
  sync();
  el<HTMLButtonElement>("first-run-ok").addEventListener("click", () => {
    card.hidden = true;
    try {
      localStorage.setItem(FIRST_RUN_KEY, "1");
    } catch {
      /* private mode */
    }
  });
  card.hidden = false;
}
