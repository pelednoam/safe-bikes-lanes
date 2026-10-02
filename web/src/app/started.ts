// Imported first by app.ts, so this runs before anything that could throw.
import { startReporting } from "../report.js";

// First, before anything that could throw: this module parsed and is running.
// compat.js checks for it at DOMContentLoaded, and without it tells the rider
// their browser can't run the app, rather than leaving a blank map.
window.__appStarted = true;
// and then report what goes wrong from here on (src/report.ts: off unless the
// build names an endpoint)
startReporting("planner");
