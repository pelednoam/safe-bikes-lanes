// The rider's hazard reports as points, and the card a tap on one opens.

import { map } from "./map.js";
import { emptyFC } from "./dom.js";
import { onTap } from "./taps.js";
import { type MapLayerMouseEvent } from "maplibre-gl";
import { dropHoverCard } from "./hover-state.js";
import { HAZARD_LABELS, type HazardCategory, getHazardPhoto, removeHazard } from "../hazards.js";
import { maplibregl } from "../maplibre.js";
import { forgetPendingHazard, refreshHazards } from "./hazard-dialog.js";
import { requestRoute } from "./plan-route.js";

export function initHazardLayers(): void {
  map.addSource("hazardpts", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "hazardpts",
    type: "circle",
    source: "hazardpts",
    paint: {
      "circle-radius": 7,
      "circle-color": "#e67e22",
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
    },
  });
  onTap("hazardpts", (e: MapLayerMouseEvent) => {
    dropHoverCard();
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties as {
      id?: string;
      category?: HazardCategory;
      note?: string;
      t?: number;
      hasPhoto?: boolean;
    };
    if (props.id === undefined) return;
    const box = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = `⚠ ${props.category !== undefined ? HAZARD_LABELS[props.category] : "hazard"}`;
    box.appendChild(title);
    if (props.note) {
      const note = document.createElement("div");
      note.textContent = props.note;
      box.appendChild(note);
    }
    const when = document.createElement("small");
    when.textContent = props.t !== undefined ? new Date(props.t).toLocaleDateString() : "";
    box.appendChild(when);
    if (props.hasPhoto) {
      const img = document.createElement("img");
      img.style.cssText = "max-width:200px;display:block;border-radius:6px;margin:6px 0";
      void getHazardPhoto(props.id).then((blob) => {
        if (blob) img.src = URL.createObjectURL(blob);
      });
      box.appendChild(img);
    }
    const rm = document.createElement("button");
    rm.textContent = "✕ remove";
    const popup = new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(box).addTo(map);
    rm.addEventListener("click", () => {
      if (props.id === undefined) return;
      forgetPendingHazard(props.id);
      void removeHazard(props.id).then(() => {
        popup.remove();
        void refreshHazards().then(() => requestRoute());
      });
    });
    box.appendChild(rm);
  });
}
