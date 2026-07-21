"""Aerial audit of the bike network: paint verification + change flagging.

For sample sites along facility corridors (OSM-only segments first, then
official facilities), pull 15 cm ortho crops from both imagery vintages
(2023, 2025) and compute green-paint / white-marking pixel ratios. Produces:

  data/aerial_report.json          all audited sites with ratios + verdicts
  web/data/review/crops/*.jpg      side-by-side crops for flagged sites

Verdicts (heuristic — a reviewer worklist, not ground truth):
  changed        marking ratios differ strongly between vintages
  no_markings    a painted-facility class shows no visible markings (2025)
  ok             nothing suspicious
"""

import argparse
import json
import pickle
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Final

import config
import networkx as nx
import numpy as np
from aerial import TileStore, marking_ratios
from PIL import Image

FACILITY_CLASSES: Final[list[str]] = ["separated", "buffered", "lane", "path"]
PAINTED_CLASSES: Final[set[str]] = {"separated", "buffered", "lane"}
GRID_DEG_LON: Final[float] = 0.0012  # ~100 m dedupe grid
GRID_DEG_LAT: Final[float] = 0.0009
CROP_HALF: Final[int] = 80  # 160 px = ~24 m display window
ANALYSIS_HALF: Final[int] = 40  # ratios computed on the central ~12 m (roadway)

GREEN_PRESENT: Final[float] = 0.015
WHITE_PRESENT: Final[float] = 0.015
GREEN_DELTA: Final[float] = 0.040
# white deltas between vintages are dominated by exposure differences
# (median |Δwhite| ≈ 0.07 on identical streets) — only dramatic shifts flag
WHITE_DELTA: Final[float] = 0.220
# crops darker than this (deep building shadow) can't be assessed
MIN_BRIGHTNESS: Final[float] = 0.18
MAX_CROPS: Final[int] = 150


def collect_sites(max_sites: int) -> list[dict[str, Any]]:
    """Sample sites along facility edges, OSM-only first, deduped on a grid."""
    with open(config.DATA_DIR / "graph.pkl", "rb") as f:
        graph: nx.MultiDiGraph = pickle.load(f)
    buckets: dict[str, list[dict[str, Any]]] = {"osm_only": []}
    for cls in FACILITY_CLASSES:
        buckets[cls] = []
    seen: set[tuple[int, int]] = set()
    for u, v, d in graph.edges(data=True):
        cls = d.get("cls")
        if cls not in FACILITY_CLASSES:
            continue
        lon = (graph.nodes[u]["x"] + graph.nodes[v]["x"]) / 2
        lat = (graph.nodes[u]["y"] + graph.nodes[v]["y"]) / 2
        cell = (int(lon / GRID_DEG_LON), int(lat / GRID_DEG_LAT))
        if cell in seen:
            continue
        seen.add(cell)
        name = d.get("name")
        if isinstance(name, list):
            name = name[0]
        site = {
            "lon": round(lon, 6),
            "lat": round(lat, 6),
            "cls": cls,
            "source": d.get("cls_source", "osm"),
            "name": name if isinstance(name, str) else "",
        }
        if d.get("cls_source") == "osm" and cls in PAINTED_CLASSES:
            buckets["osm_only"].append(site)
        else:
            buckets[str(cls)].append(site)
    ordered: list[dict[str, Any]] = []
    for key in ["osm_only", "separated", "buffered", "lane", "path"]:
        ordered.extend(buckets[key])
    total = len(ordered)
    if total > max_sites:
        print(f"capping to {max_sites} of {total} sites (priority: OSM-only, "
              f"separated, buffered, lane, path) — raise --max-sites for more")
    return ordered[:max_sites]


def audit_site(
    site: dict[str, Any], store23: TileStore, store25: TileStore
) -> dict[str, Any]:
    out = dict(site)
    crops: dict[str, Any] = {}
    for vintage, store in (("2023", store23), ("2025", store25)):
        crop = store.crop(site["lon"], site["lat"], CROP_HALF)
        if crop is None:
            out[f"g{vintage}"] = out[f"w{vintage}"] = None
            continue
        lo, hi = CROP_HALF - ANALYSIS_HALF, CROP_HALF + ANALYSIS_HALF
        window = crop[lo:hi, lo:hi]
        g, w = marking_ratios(window)
        out[f"g{vintage}"] = round(g, 4)
        out[f"w{vintage}"] = round(w, 4)
        out[f"v{vintage}"] = round(float(window.mean()) / 255.0, 3)
        crops[vintage] = crop
    g23, w23 = out.get("g2023"), out.get("w2023")
    g25, w25 = out.get("g2025"), out.get("w2025")
    verdict = "ok"
    bright = (
        (out.get("v2023") or 0) >= MIN_BRIGHTNESS and (out.get("v2025") or 0) >= MIN_BRIGHTNESS
    )
    if g23 is not None and g25 is not None and w23 is not None and w25 is not None:
        if not bright:
            verdict = "unclear"  # deep shadow — can't assess markings
        elif abs(g25 - g23) >= GREEN_DELTA or abs(w25 - w23) >= WHITE_DELTA:
            verdict = "changed"
        elif site["cls"] in PAINTED_CLASSES and g25 < GREEN_PRESENT and w25 < WHITE_PRESENT:
            verdict = "no_markings"
    elif g25 is None:
        verdict = "no_imagery"
    out["verdict"] = verdict
    out["_crops"] = crops
    return out


def save_crops(flagged: list[dict[str, Any]]) -> None:
    crop_dir = config.DATA_DIR.parent / "web" / "data" / "review" / "crops"
    crop_dir.mkdir(parents=True, exist_ok=True)
    for old in crop_dir.glob("*.jpg"):
        old.unlink()
    for i, site in enumerate(flagged[:MAX_CROPS]):
        for vintage, crop in site.pop("_crops", {}).items():
            img = Image.fromarray(np.asarray(crop, dtype=np.uint8))
            img.save(crop_dir / f"{i}_{vintage}.jpg", quality=80)
        site["crop_idx"] = i


def run(max_sites: int) -> None:
    sites = collect_sites(max_sites)
    print(f"auditing {len(sites)} sites against 2023 + 2025 orthoimagery ...")
    store23 = TileStore("2023")
    store25 = TileStore("2025")
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda s: audit_site(s, store23, store25), sites))
    flagged = [r for r in results if r["verdict"] in ("changed", "no_markings")]
    flagged.sort(key=lambda r: (r["verdict"] != "changed", r["name"]))
    save_crops(flagged)
    for r in results:
        r.pop("_crops", None)
    report = {
        "audited": len(results),
        "coverage_note": (
            f"{len(sites)} of the deduped facility sites audited; "
            "rerun with --max-sites to extend (tiles are cached)"
        ),
        "flagged": flagged,
        "counts": {
            v: sum(1 for r in results if r["verdict"] == v)
            for v in ("ok", "changed", "no_markings", "unclear", "no_imagery")
        },
    }
    out = config.DATA_DIR / "aerial_report.json"
    out.write_text(json.dumps(report, indent=1))
    print(
        f"wrote {out}: {report['counts']}"
        f" (tiles fetched: 2023={store23.fetched}, 2025={store25.fetched})"
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-sites", type=int, default=900)
    run(ap.parse_args().max_sites)
