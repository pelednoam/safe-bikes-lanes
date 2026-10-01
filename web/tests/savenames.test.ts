// The Android side's file-name rules (SaveNames.java), compiled and run for
// real: they hold no Android code, so javac alone can. Skipped where there is
// no Java, which CI's build image has.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// In CI the Java is there (the Android build needs it), and a missing javac is a
// broken runner, not a reason to say nothing: a skipped test passes.
if (process.env["CI"] !== undefined && spawnSync("javac", ["-version"]).status !== 0) {
  throw new Error("tests/savenames.test.ts needs javac in CI");
}

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
        File one = SaveNames.reserveIn(dir, "ride.gpx");
        check(one.getName().equals("ride.gpx") && one.exists(), "the first keeps its name, and is made");
        File two = SaveNames.reserveIn(dir, "ride.gpx");
        check(two.getName().equals("ride (1).gpx") && two.exists(), "the second is numbered, not " + two.getName());
        check(SaveNames.reserveIn(dir, "ride.gpx").getName().equals("ride (2).gpx"), "the third");
        check(SaveNames.reserveIn(dir, "noext").getName().equals("noext"), "no extension, first");
        check(SaveNames.reserveIn(dir, "noext").getName().equals("noext (1)"), "no extension, second");
        // never a file that was there already, even with every name taken
        File crowded = Files.createTempDirectory("crowded").toFile();
        new File(crowded, "x.gpx").createNewFile();
        new File(crowded, "x (1).gpx").createNewFile();
        new File(crowded, "x (2).gpx").createNewFile();
        boolean refused = false;
        try { SaveNames.reserveIn(crowded, "x.gpx", 2); } catch (java.io.IOException e) { refused = true; }
        check(refused, "fails when every name is taken, instead of returning one that is");
        // two saves at once don't get the same name
        File racing = Files.createTempDirectory("racing").toFile();
        java.util.Set<String> names = java.util.concurrent.ConcurrentHashMap.newKeySet();
        Thread[] threads = new Thread[8];
        for (int i = 0; i < threads.length; i++) {
            threads[i] = new Thread(() -> { try { names.add(SaveNames.reserveIn(racing, "r.gpx").getName()); } catch (Exception e) { names.add("FAILED"); } });
            threads[i].start();
        }
        for (Thread t : threads) t.join();
        check(names.size() == 8 && !names.contains("FAILED"), "eight saves at once, eight names: " + names);
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
