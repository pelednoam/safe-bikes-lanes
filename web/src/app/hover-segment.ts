// Hovering a street or the route: highlight it, show its safety card, and mark it sketchy.

import { map } from "./map.js";
import { type MapLayerMouseEvent } from "maplibre-gl";
import { type ProtectionClass } from "../types.js";
import { hover, segmentCard } from "./hover-state.js";
import { h } from "preact";
import { store } from "./store.js";
import { maplibregl } from "../maplibre.js";
import { openSketchyPopup } from "./sketchy.js";

/** The street card's photo on a hover is fetched once the pointer rests on a segment. */
let segPhotoTimer: number | undefined;

export function initSegmentHover(): void {
  // hover inspection on the network and the planned route: highlight the
  // segment and show a safety card
  let hoverStateId: number | string | null = null;
  let lastHoverKey: string | null = null;
  const clearHoverState = (): void => {
    if (hoverStateId !== null) {
      map.setFeatureState({ source: "network", id: hoverStateId }, { hover: false });
      hoverStateId = null;
    }
  };
  const setHoverState = (id: number | string | undefined): void => {
    if (id === hoverStateId) return;
    clearHoverState();
    if (id !== undefined) {
      map.setFeatureState({ source: "network", id }, { hover: true });
      hoverStateId = id;
    }
  };
  for (const layer of ["network-hit", "route"]) {
    map.on("mousemove", layer, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "crosshair";
      const f = e.features?.[0];
      if (!f) return;
      // only rebuild when the segment under the cursor actually changes
      const key = `${layer}:${String(f.id)}`;
      if (key === lastHoverKey) return;
      lastHoverKey = key;
      if (layer !== "route") setHoverState(f.id as number | string | undefined);
      else clearHoverState();
      const props = f.properties as {
        cls?: ProtectionClass;
        name?: string;
        crashes?: number;
        source?: string;
      };
      // "right-click" means nothing on a phone
      const hint = window.matchMedia("(hover: none)").matches
        ? "press and hold to mark as sketchy"
        : "right-click to mark as sketchy";
      segmentCard.show(props, [h("br", null), h("small", null, hint)], store.mapillaryToken !== "");
      if (!hover.popup) {
        hover.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });
        hover.popup.addTo(map);
      }
      // the same element each time: the card is drawn into it, not replaced
      hover.popup.setLngLat(e.lngLat).setDOMContent(segmentCard.el);
      if (store.mapillaryToken !== "") {
        window.clearTimeout(segPhotoTimer);
        const popup = hover.popup;
        const { lng, lat } = e.lngLat;
        // debounce: only fetch once the cursor rests on a segment
        segPhotoTimer = window.setTimeout(() => {
          segmentCard.loadPhoto(lng, lat, store.mapillaryToken, () => popup === hover.popup);
        }, 300);
      }
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
      clearHoverState();
      lastHoverKey = null;
      hover.popup?.remove();
      hover.popup = null;
    });
    // right-click (desktop) marks a segment as personally sketchy;
    // touch devices use long-press (wired in app.ts)
    map.on("contextmenu", layer, (e: MapLayerMouseEvent) => {
      e.preventDefault();
      openSketchyPopup([e.lngLat.lng, e.lngLat.lat]);
    });
  }
}
