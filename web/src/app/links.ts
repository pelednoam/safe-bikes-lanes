// The functions one part of the app needs from another that imports it (see
// src/hooks.ts). Each is set once, by the module that has the function, as the
// app starts; until the part that has it moves into its own module, app.ts does.
import { hook } from "../hooks.js";

export const links = {
  /** Read the hazards stored on the device and redraw them. */
  refreshHazards: hook<[], Promise<void>>("refreshHazards"),
};
