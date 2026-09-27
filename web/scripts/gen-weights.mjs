// Generate src/weights.gen.ts from pipeline/safety_model.json, the one place the
// safety model's numbers live (see pipeline/weights.py for the pipeline's side).
//
//   node scripts/gen-weights.mjs          write src/weights.gen.ts
//   node scripts/gen-weights.mjs --check  exit 1 if it is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = join(WEB, "..", "pipeline", "safety_model.json");
const OUT = join(WEB, "src", "weights.gen.ts");

function render(model) {
  const lines = [
    "// Generated from pipeline/safety_model.json by `npm run gen-weights`. Do not edit:",
    "// change the JSON and regenerate. tests/weights.test.ts fails if this is stale,",
    "// or if the router and the pipeline price any edge differently.",
    'import type { ProfileId, ProtectionClass, RiderProfile } from "./types.js";',
    "",
    "export const CLASS_COLORS: Record<ProtectionClass, string> = {",
    ...Object.entries(model.classes).map(([c, v]) => `  ${c}: ${JSON.stringify(v.color)},`),
    "};",
    "",
    "export const PROFILES: Record<ProfileId, RiderProfile> = {",
  ];
  for (const [id, p] of Object.entries(model.profiles)) {
    lines.push(
      `  ${id}: {`,
      `    id: ${JSON.stringify(id)},`,
      `    label: ${JSON.stringify(p.label)},`,
      `    paceKmh: ${p.paceKmh},`,
      "    mult: {",
      ...Object.entries(p.mult).map(([c, m]) => `      ${c}: ${m},`),
      "    },",
      `    busyLane: ${p.busyLane},`,
      `    busyBuffered: ${p.busyBuffered},`,
      `    penScale: ${p.penScale},`,
      "  },",
    );
  }
  lines.push("};", "");
  return lines.join("\n");
}

const text = render(JSON.parse(readFileSync(MODEL, "utf8")));
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    // missing counts as stale
  }
  if (current !== text) {
    console.error("src/weights.gen.ts is stale: run npm run gen-weights");
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
