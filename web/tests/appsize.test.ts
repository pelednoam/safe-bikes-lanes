// The shape of src/app/ (docs/app-split-plan.md): small files, and no import
// cycles among them. Both rules are only worth having if something fails when
// they are broken, since the file they came out of grew to 6,700 lines one
// reasonable addition at a time.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "..", "src", "app");
/** About 200 is the aim; this is where it stops being "about". */
const MAX_CODE_LINES = 220;

const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

/** Lines of code: not blank, not a comment (line, or inside a block). */
export function codeLines(source: string): number {
  let inBlock = false;
  let n = 0;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    n++;
  }
  return n;
}

const importsOf = (file: string): string[] =>
  [...readFileSync(join(DIR, file), "utf8").matchAll(/^(?:import|export)\b[^;]*?from\s+"(\.\/[^"]+)\.js";/gms)].map(
    (m) => `${m[1]}.ts`.replace(/^\.\//, ""),
  );

describe("the modules in src/app/", () => {
  it("count lines of code the way the plan does", () => {
    expect(codeLines("// c\n\nconst a = 1;\n/* x\n y */\n/** z */\nconst b = 2; // t\n")).toBe(2);
  });

  it.each(files)("%s is a small file", (file) => {
    expect(codeLines(readFileSync(join(DIR, file), "utf8")), file).toBeLessThanOrEqual(MAX_CODE_LINES);
  });

  it("don't import the entry point, which imports them", () => {
    for (const f of files) {
      expect(readFileSync(join(DIR, f), "utf8"), f).not.toMatch(/from\s+"\.\.\/app\.js"/);
    }
  });

  it("don't import each other in a circle", () => {
    const edges = new Map(files.map((f) => [f, importsOf(f).filter((i) => files.includes(i))]));
    const state = new Map<string, "open" | "done">();
    const walk = (f: string, path: string[]): void => {
      if (state.get(f) === "done") return;
      if (state.get(f) === "open") throw new Error(`import cycle: ${[...path.slice(path.indexOf(f)), f].join(" -> ")}`);
      state.set(f, "open");
      for (const next of edges.get(f) ?? []) walk(next, [...path, f]);
      state.set(f, "done");
    };
    for (const f of files) expect(() => walk(f, [])).not.toThrow();
  });
});
