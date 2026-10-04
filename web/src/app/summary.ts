// The route's summary on the panel: distance, time and climb, the class ribbon with
// its marks, the reasons, the cautions, and the street-level photo preview.

import { CLASS_MARKS, RIBBON_PATTERNS, classSwatch } from "./classes.js";
import { type ProtectionClass, type RouteOption, type RouteSummary } from "../types.js";
import { h, render } from "preact";
import { Cautions, ClassBar, ClassKey, Ribbon, WhyList } from "../ui/RouteSummary.js";
import { CLASS_COLORS } from "../weights.gen.js";
import { CLASS_LABELS, nearestMapillary } from "../segment.js";
import { fmtClimb, fmtDist } from "../units.js";
import { el } from "./dom.js";
import { store } from "./store.js";
import { sunsetTime } from "../nav.js";
import { maplibregl } from "../maplibre.js";
import { map } from "./map.js";

/** The kinds whose map mark the ribbon repeats (see CLASS_MARKS). */
const RIBBON_MARKED: ReadonlySet<string> = new Set(CLASS_MARKS.map((m) => m.cls));

export function renderRibbon(option: RouteOption): void {
  render(
    h(Ribbon, {
      segs: option.payload.ribbon ?? [],
      colors: CLASS_COLORS,
      labels: CLASS_LABELS,
      marked: RIBBON_MARKED,
      patterns: RIBBON_PATTERNS,
      climb: fmtClimb,
    }),
    el<HTMLDivElement>("ribbon"),
  );
}

export function showSummary(option: RouteOption): void {
  const s: RouteSummary = option.payload.summary;
  el<HTMLDivElement>("summary").style.display = "block";
  el<HTMLElement>("s-dist").textContent = fmtDist(s.meters);
  el<HTMLElement>("s-time").textContent =
    `~${s.minutes} min` + ((s.walk_m ?? 0) > 0 ? ` · 🚶 ${fmtDist(s.walk_m ?? 0)}` : "");
  el<HTMLElement>("s-prot").textContent = `${s.pct_protected}%`;
  el<HTMLElement>("s-quiet").textContent = `${s.pct_quiet}%`;
  el<HTMLElement>("s-detour").textContent =
    s.shortest_meters === undefined || (s.detour_pct ?? 0) <= 0
      ? "same"
      : `+${s.detour_pct}% (${fmtDist(s.shortest_meters)})`;
  const parts = (Object.entries(s.by_class_m) as [ProtectionClass, number][]).map(([cls, meters]) => ({
    cls,
    meters,
  }));
  const breakdown = { parts, colors: CLASS_COLORS, labels: CLASS_LABELS };
  render(h(ClassBar, breakdown), el<HTMLDivElement>("classbar"));
  render(
    h(ClassKey, { ...breakdown, swatch: (cls: ProtectionClass) => classSwatch(cls, 22, 12) }),
    el<HTMLDivElement>("class-key"),
  );
  renderRibbon(option);
  render(
    h(Cautions, {
      cautions: s.cautions,
      labels: CLASS_LABELS,
      photos: store.mapillaryToken !== "",
      onPhoto: (lon: number, lat: number) => void showMapillaryPreview(lon, lat),
    }),
    el<HTMLDivElement>("cautions"),
  );
  const explanation = s.explanation ?? [];
  el<HTMLDetailsElement>("why").style.display = explanation.length > 0 ? "block" : "none";
  render(h(WhyList, { reasons: explanation }), el<HTMLUListElement>("why-list"));

  // daylight check: warn when the ride would end near or after sunset
  const sunsetBox = el<HTMLDivElement>("sunset");
  const arrival = new Date(Date.now() + s.minutes * 60_000);
  const sunset = sunsetTime(new Date(), 42.383, -71.105);
  const marginMin = (sunset.getTime() - arrival.getTime()) / 60_000;
  if (marginMin < 30) {
    const sunsetLocal = sunset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    sunsetBox.textContent =
      marginMin < 0
        ? `🌅 this ride ends after sunset (${sunsetLocal}) — lights on, and try dark mode`
        : `🌅 sunset at ${sunsetLocal} — you'd arrive with ~${Math.round(marginMin)} min of light`;
    sunsetBox.style.display = "block";
  } else {
    sunsetBox.style.display = "none";
  }
}

async function showMapillaryPreview(lon: number, lat: number): Promise<void> {
  try {
    // the same "nearest, and near enough to be here" rule the street card uses;
    // this used to keep its own narrow-box, newest-wins copy
    const newest = await nearestMapillary(
      lon,
      lat,
      store.mapillaryToken,
      "id,thumb_1024_url,captured_at,computed_geometry",
    );
    const box = document.createElement("div");
    if (newest?.thumb_1024_url) {
      const img = document.createElement("img");
      img.src = newest.thumb_1024_url;
      img.style.cssText = "max-width:260px;border-radius:6px;display:block";
      box.appendChild(img);
      const when = document.createElement("small");
      when.textContent =
        newest.captured_at !== undefined
          ? `📷 ${new Date(newest.captured_at).toLocaleDateString()} · `
          : "";
      box.appendChild(when);
    } else {
      box.textContent = "no street-level photos here — ";
    }
    const link = document.createElement("a");
    link.href = `https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=17`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "open in Mapillary";
    box.appendChild(link);
    new maplibregl.Popup({ maxWidth: "290px" }).setLngLat([lon, lat]).setDOMContent(box).addTo(map);
    map.flyTo({ center: [lon, lat], zoom: 16.5 });
  } catch {
    window.open(`https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=17`, "_blank");
  }
}
