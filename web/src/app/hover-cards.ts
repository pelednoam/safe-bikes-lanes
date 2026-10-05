// Hover and tap cards for the dots and areas: places, crossings, hazards, construction, lanes, elevation.

import { type ComponentChild, h, render } from "preact";
import { POI_META } from "./classes.js";
import { BlockCard, ConstructionCard, CrossingCard, ElevationCard, HazardCard, PlaceCard, cardElement, constructionProps, textOf } from "../ui/MapCards.js";
import { HAZARD_LABELS, type HazardCategory } from "../hazards.js";
import { hazardPhotos } from "./hazard-dialog.js";
import { map } from "./map.js";
import { type MapLayerMouseEvent } from "maplibre-gl";
import { dropHoverCard, hover } from "./hover-state.js";
import { maplibregl } from "../maplibre.js";
import { onTap } from "./taps.js";

export function initHoverCards(): void {
  // hover tooltips on every dot layer (clicks keep their richer popups);
  // src/ui/MapCards.tsx draws them
  const placeCard = (p: Record<string, unknown>, withKind: boolean): ComponentChild => {
    const kind = typeof p["kind"] === "string" ? p["kind"] : "";
    const meta = POI_META[kind];
    const name = textOf(p["name"]);
    return h(PlaceCard, {
      emoji: meta?.emoji ?? "📍",
      name: name || (meta?.label ?? "stop"),
      kind: withKind && name !== "" ? (meta?.label ?? "") : "",
    });
  };
  const constructionCard = (p: Record<string, unknown>): ComponentChild =>
    h(ConstructionCard, constructionProps(p));
  const hazardPhotoId = (p: Record<string, unknown>): string | null =>
    (p["hasPhoto"] === true || p["hasPhoto"] === "true") && textOf(String(p["id"] ?? "")) !== ""
      ? String(p["id"])
      : null;
  const hoverCards: Record<string, (props: Record<string, unknown>) => ComponentChild> = {
    pois: (p) => placeCard(p, true),
    gateways: () => h(CrossingCard, {}),
    hazardpts: (p) => {
      const cat = typeof p["category"] === "string" ? (p["category"] as HazardCategory) : null;
      const id = hazardPhotoId(p);
      return h(HazardCard, {
        label: cat !== null ? HAZARD_LABELS[cat] : "hazard",
        note: textOf(p["note"]),
        when: typeof p["t"] === "number" ? new Date(p["t"]).toLocaleDateString() : null,
        photo: id !== null ? hazardPhotos.get(id) : null,
      });
    },
    "construction-pts": constructionCard,
    "construction-lines": constructionCard,
  };
  for (const [layer, card] of Object.entries(hoverCards)) {
    map.on("mousemove", layer, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as Record<string, unknown>;
      const content = cardElement(card(props));
      hover.popup?.remove();
      hover.popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 10,
      })
        .setLngLat(e.lngLat)
        .setDOMContent(content)
        .addTo(map);
      // hazard photos live in IndexedDB: read once, then drawn from memory
      const photoId = layer === "hazardpts" ? hazardPhotoId(props) : null;
      if (photoId !== null) {
        void hazardPhotos.ensure(photoId).then((arrived) => {
          if (arrived && content.isConnected) render(card(props), content);
        });
      }
    });
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = "";
      hover.popup?.remove();
      hover.popup = null;
    });
  }

  // gateways have no click popup of their own — give phones (no hover) one
  onTap("gateways", (e: MapLayerMouseEvent) => {
    dropHoverCard();
    new maplibregl.Popup({ offset: 10 })
      .setLngLat(e.lngLat)
      .setDOMContent(cardElement(h(CrossingCard, {})))
      .addTo(map);
  });

  onTap(
    "pois",
    (e: MapLayerMouseEvent) => {
      dropHoverCard();
      const f = e.features?.[0];
      if (!f) return;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setDOMContent(cardElement(placeCard(f.properties as Record<string, unknown>, false)))
        .addTo(map);
    },
    true,
  );

  map.on("mousemove", "lanemap", (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties as { fac_m?: number; prot_m?: number };
    if (props.fac_m === undefined) return;
    hover.popup?.remove();
    hover.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setDOMContent(
        cardElement(
          h(BlockCard, { facilityM: Number(props.fac_m) || 0, protectedM: Number(props.prot_m) || 0 }),
        ),
      )
      .addTo(map);
  });
  map.on("mouseleave", "lanemap", () => {
    hover.popup?.remove();
    hover.popup = null;
  });
  map.on("mousemove", "elevmap", (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties as { elev?: number };
    if (props.elev === undefined) return;
    hover.popup?.remove();
    hover.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
      .setLngLat(e.lngLat)
      .setDOMContent(cardElement(h(ElevationCard, { elevM: Number(props.elev) || 0 })))
      .addTo(map);
  });
  map.on("mouseleave", "elevmap", () => {
    hover.popup?.remove();
    hover.popup = null;
  });
}
