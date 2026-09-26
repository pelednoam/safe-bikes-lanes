// The web app manifest: what Android and Chrome use to install the planner as
// an app. Its icons are full-bleed squares, and a launcher that masks them to a
// circle or a squircle cut the bike's wheels off — so there is a maskable one,
// and it has to be shipped wherever the manifest is.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  id?: string;
  start_url: string;
  icons: { src: string; sizes: string; purpose?: string }[];
}

const manifest = JSON.parse(readFileSync(join(WEB, "manifest.json"), "utf8")) as Manifest;

describe("the web app manifest", () => {
  it("names its identity, the same one it has always had", () => {
    // Without an id, the identity is derived from start_url, and changing
    // start_url later would make every installed copy a different app. "."
    // resolves to exactly what start_url does, so nothing already installed moves.
    expect(manifest.id).toBe(".");
    expect(manifest.start_url).toBe(".");
  });

  it("has a maskable icon, and every icon it names exists", () => {
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) {
      expect(existsSync(join(WEB, icon.src)), icon.src).toBe(true);
    }
  });

  it("ships every icon with the site and the Android bundle", () => {
    // the Pages deploy and the Capacitor bundle copy files by name
    const pages = readFileSync(join(WEB, "..", ".github", "workflows", "pages.yml"), "utf8");
    const assemble = readFileSync(join(WEB, "scripts", "assemble.sh"), "utf8");
    for (const icon of manifest.icons) {
      expect(pages, `pages.yml does not copy ${icon.src}`).toContain(`web/${icon.src}`);
      expect(assemble, `assemble.sh does not copy ${icon.src}`).toContain(icon.src);
    }
  });
});
