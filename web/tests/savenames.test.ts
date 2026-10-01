// The Android side's file-name rules (SaveNames.java), compiled and run for
// real: they hold no Android code, so javac alone can. Skipped where there is
// no Java, which CI's build image has.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const hasJavac = spawnSync("javac", ["-version"]).status === 0;
const SRC = "android/app/src/main/java/com/pelednoam/safebikes/SaveNames.java";

const CHECK = `
package com.pelednoam.safebikes;
import java.io.File;
import java.nio.file.Files;
public class Check {
    static int fails = 0;
    static void check(boolean ok, String what) { if (!ok) { fails++; System.out.println("FAIL " + what); } }
    public static void main(String[] a) throws Exception {
        check(SaveNames.isPlain("ride-2026-09-29.gpx"), "a plain name");
        check(SaveNames.isPlain("backup_1.json"), "an underscore");
        for (String bad : new String[] {null, "", ".", "..", "...", "a/b", "../x", "a b", "\\u00e9.gpx", "x".repeat(121)}) {
            check(!SaveNames.isPlain(bad), "rejects " + bad);
        }
        File dir = Files.createTempDirectory("savenames").toFile();
        File one = SaveNames.uniqueIn(dir, "ride.gpx");
        check(one.getName().equals("ride.gpx"), "the first keeps its name");
        one.createNewFile();
        File two = SaveNames.uniqueIn(dir, "ride.gpx");
        check(two.getName().equals("ride (1).gpx"), "the second is numbered, not " + two.getName());
        two.createNewFile();
        check(SaveNames.uniqueIn(dir, "ride.gpx").getName().equals("ride (2).gpx"), "the third");
        new File(dir, "noext").createNewFile();
        check(SaveNames.uniqueIn(dir, "noext").getName().equals("noext (1)"), "no extension");
        System.out.println(fails == 0 ? "all ok" : fails + " failed");
        System.exit(fails == 0 ? 0 : 1);
    }
}
`;

describe.skipIf(!hasJavac)("the names the Android app saves files under", () => {
  it("are plain, never a folder, and never replace a file of the same name", () => {
    const dir = mkdtempSync(join(tmpdir(), "savenames-"));
    const check = join(dir, "Check.java");
    writeFileSync(check, CHECK);
    execFileSync("javac", ["-d", dir, SRC, check]);
    const out = execFileSync("java", ["-cp", dir, "com.pelednoam.safebikes.Check"]).toString();
    expect(out.trim()).toBe("all ok");
  });
});
