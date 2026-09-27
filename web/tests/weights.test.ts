// One safety model, priced the same way on both sides.
//
// The pipeline prices the graph it ranks projects on (graph.pkl), and the
// browser prices the tiles it routes on. The numbers used to live in
// pipeline/config.py, router.ts and app.ts, and the rule for paint on a busy
// road was written in Python and again in TypeScript; they had already drifted
// once ("price markings in the browser the way the pipeline now does"). Now
// both read pipeline/safety_model.json, and this test holds them to it: the
// generated table must be current, and the two pricing functions must agree on
// every profile, class, street class and busy flag.
//
// It runs the Python side for real: pipeline/weights.py is standard library
// only, so this works on a CI runner without the pipeline's dependencies.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { facilityMultiplier } from "../src/router.js";
import type { ProfileId, ProtectionClass } from "../src/types.js";
import { CLASS_COLORS, PROFILES } from "../src/weights.gen.js";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = JSON.parse(readFileSync(join(WEB, "..", "pipeline", "safety_model.json"), "utf8")) as {
  classes: Record<string, { color: string }>;
  profiles: Record<string, { mult: Record<string, number> }>;
};

describe("the safety model", () => {
  it("is generated from safety_model.json and current", () => {
    const run = spawnSync("node", [join(WEB, "scripts", "gen-weights.mjs"), "--check"], {
      encoding: "utf8",
    });
    expect(run.stderr, "run npm run gen-weights").toBe("");
    expect(run.status).toBe(0);
    expect(Object.keys(PROFILES).sort()).toEqual(Object.keys(MODEL.profiles).sort());
    expect(CLASS_COLORS).toEqual(
      Object.fromEntries(Object.entries(MODEL.classes).map(([c, v]) => [c, v.color])),
    );
  });

  it("prices every edge the same in the pipeline and the router", () => {
    const run = spawnSync("python3", [join(WEB, "..", "pipeline", "weights.py"), "--table"], {
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const rows = JSON.parse(run.stdout) as [ProfileId, ProtectionClass, ProtectionClass, boolean, number][];
    // every combination, not a sample: 3 profiles × 10 classes × 10 street classes × busy
    expect(rows.length).toBe(Object.keys(PROFILES).length * 10 * 10 * 2);
    const disagree = rows.filter(
      ([pid, cls, road, busy, price]) => facilityMultiplier(PROFILES[pid], cls, road, busy) !== price,
    );
    expect(disagree, "the pipeline and the router price these edges differently").toEqual([]);
  });
});
