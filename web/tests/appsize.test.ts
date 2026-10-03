// The shape of src/app/ (docs/app-split-plan.md): small files, and no import
// cycles among them. Both rules are only worth having if something fails when
// they are broken, since the file they came out of grew to about 6,700 lines one
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

/** The files a module imports, named and bare (`import "./x.js";`, which is how
 * the entry point loads started.ts), re-exported, and dynamic (`import("./x.js")`),
 * from this folder or one up. Comments are taken out first, so a mention in prose
 * is not an import. */
export function importsIn(source: string): string[] {
  // only comments that start a line: a "/*" inside a string ("src/app/**") must not
  // cut the code out up to the next "*/", and with it the imports in between
  const code = source.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");
  const found = [
    ...code.matchAll(/^\s*(?:import|export)\b(?:[^;"']*?\bfrom\s+)?\s*["'](\.{1,2}\/[^"']+)\.js["']/gm),
    ...code.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)\.js["']\s*\)/g),
  ];
  return found.map((m) => `${m[1]}.ts`);
}

const importsOf = (file: string): string[] =>
  importsIn(readFileSync(join(DIR, file), "utf8")).flatMap((i) => {
    // relative to src/app/: "./x.ts" is a sibling, "../x.ts" is not one of these
    return i.startsWith("./") ? [i.slice(2)] : [];
  });

describe("the modules in src/app/", () => {
  it("count lines of code the way the plan does", () => {
    expect(codeLines("// c\n\nconst a = 1;\n/* x\n y */\n/** z */\nconst b = 2; // t\n")).toBe(2);
  });

  it("sees every way of importing a sibling, and not a mention in a comment", () => {
    expect(importsIn('import { a } from "./a.js";')).toEqual(["./a.ts"]);
    expect(importsIn('import "./b.js";')).toEqual(["./b.ts"]);
    expect(importsIn('export { c } from "./c.js";')).toEqual(["./c.ts"]);
    expect(importsIn('import type { D } from "./d.js";')).toEqual(["./d.ts"]);
    expect(importsIn('import {\n  e,\n  f,\n} from "./e.js";')).toEqual(["./e.ts"]);
    expect(importsIn('const m = await import("./g.js");')).toEqual(["./g.ts"]);
    expect(importsIn('import "../app.js";')).toEqual(["../app.ts"]);
    expect(importsIn('// import "./h.js";\n/* import "./i.js"; */\nconst x = 1;')).toEqual([]);
    expect(importsIn('import { x } from "maplibre-gl";')).toEqual([]);
    // a glob in a string is not the start of a comment
    expect(importsIn('const g = "src/app/**";\nimport { x } from "./x.js";\n/* c */')).toEqual(["./x.ts"]);
  });

  it.each(files)("%s is a small file", (file) => {
    expect(codeLines(readFileSync(join(DIR, file), "utf8")), file).toBeLessThanOrEqual(MAX_CODE_LINES);
  });

  it("don't import the entry point, which imports them", () => {
    for (const f of files) {
      expect(importsIn(readFileSync(join(DIR, f), "utf8")), f).not.toContain("../app.ts");
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
