// Construction lines and points, and the card a tap on one opens.

import { map } from "./map.js";
import { emptyFC } from "./dom.js";
import { constructionIcon } from "./classes.js";
import { onTap } from "./taps.js";
import { type MapLayerMouseEvent } from "maplibre-gl";
import { dropHoverCard } from "./hover-state.js";
import { maplibregl } from "../maplibre.js";
import { ConstructionCard, cardElement, constructionProps } from "../ui/MapCards.js";
import { h } from "preact";

export function initConstructionLayers(): void {
  map.addSource("construction", { type: "geojson", data: emptyFC() });
  // Barricade tape — black and white, which nothing else on the map is. As
  // orange dashes it read as a route, in a colour between the palette's amber
  // and red. (See constructionIcon for the points.)
  map.addLayer({
    id: "construction-lines-base",
    type: "line",
    source: "construction",
    filter: ["!=", ["geometry-type"], "Point"],
    paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.95 },
  });
  map.addLayer({
    id: "construction-lines",
    type: "line",
    source: "construction",
    filter: ["!=", ["geometry-type"], "Point"],
    paint: { "line-color": "#111619", "line-width": 6, "line-dasharray": [1, 1] },
  });
  const barricade = constructionIcon();
  if (barricade !== null) map.addImage("construction-icon", barricade, { pixelRatio: 2 });
  map.addLayer({
    id: "construction-pts",
    type: "symbol",
    source: "construction",
    filter: ["==", ["geometry-type"], "Point"],
    layout: {
      "icon-image": "construction-icon",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      // small from afar, where there are a hundred and seventy of them
      "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 14, 0.85, 16, 1.2],
    },
  });
  for (const layer of ["construction-lines", "construction-pts"] as const) {
    onTap(layer, (e: MapLayerMouseEvent) => {
      dropHoverCard();
      const f = e.features?.[0];
      if (!f) return;
      // The same card as the hover's (src/ui/MapCards.tsx), drawn as text:
      // every field comes from a city permit feed or MassDOT's work-zone API,
      // and this one once set them as HTML unescaped while the hover escaped
      // them, the kind of gap that survives because the two look alike.
      const p = f.properties as Record<string, unknown>;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setDOMContent(
          cardElement(
            h(ConstructionCard, constructionProps(p)),
          ),
        )
        .addTo(map);
    });
  }
}
