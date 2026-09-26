// Where to tap the map when a test means "the map", not something drawn on it.
import type { Map as MLMap } from "maplibre-gl";

type Page = import("@playwright/test").Page;

/** The layers whose features open a card on a tap instead of setting a point. */
export const INFO_LAYERS = ["construction-lines", "construction-pts", "hazardpts", "gateways"];

/** A spot near (x, y) with no construction site, hazard or gateway on it.
 * A tap on one of those opens its card instead of re-planning (the rider asked
 * to read it). The map follows the rider, so what sits under a fixed pixel
 * changes from run to run, and the margin covers the drift until the tap. */
export async function plainSpot(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([x0, y0, info]) => {
      const map = (window as unknown as { _map?: MLMap })._map;
      const layers = info.filter((l) => map?.getLayer(l) !== undefined);
      for (let r = 0; r <= 200; r += 20) {
        for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]] as const) {
          const px = x0 + dx;
          const py = y0 + dy;
          const box: [[number, number], [number, number]] = [
            [px - 30, py - 30],
            [px + 30, py + 30],
          ];
          if ((map?.queryRenderedFeatures(box, { layers }).length ?? 0) === 0) {
            return { x: px, y: py };
          }
        }
      }
      return { x: x0, y: y0 };
    },
    [x, y, INFO_LAYERS] as [number, number, string[]],
  );
}
