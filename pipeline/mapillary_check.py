"""Audit OSM-only facility segments against Mapillary street-level imagery.

For every facility edge whose protection class is known only from OSM (not
confirmed by an official layer), query Mapillary for nearby imagery and record
the newest capture date + a viewer link — a manual-review worklist for "is
this lane really there?". Requires a free Mapillary client token in
MAPILLARY_TOKEN; skipped otherwise. Writes data/mapillary_report.json.
"""

import json
import os
import pickle
import urllib.parse
import urllib.request
from typing import Any, Final

import config
import networkx as nx

MAPILLARY_API: Final[str] = "https://graph.mapillary.com/images"
FACILITY_CLASSES: Final[set[str]] = {"path", "separated", "buffered", "lane"}
MAX_QUERIES: Final[int] = 200
BOX_DEG: Final[float] = 0.0004  # ~35 m


def query_images(token: str, lon: float, lat: float) -> dict[str, Any] | None:
    params = {
        "access_token": token,
        "bbox": f"{lon - BOX_DEG},{lat - BOX_DEG},{lon + BOX_DEG},{lat + BOX_DEG}",
        "fields": "id,captured_at,thumb_1024_url",
        "limit": 3,
    }
    url = MAPILLARY_API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "family-bike-router/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except OSError:
        return None
    images: list[dict[str, Any]] = data.get("data", [])
    if not images:
        return None
    newest = max(images, key=lambda i: int(i.get("captured_at", 0)))
    return newest


def run() -> None:
    token = os.environ.get("MAPILLARY_TOKEN", "")
    if not token:
        print("MAPILLARY_TOKEN not set — skipping imagery audit")
        return
    with open(config.DATA_DIR / "graph.pkl", "rb") as f:
        graph: nx.MultiDiGraph = pickle.load(f)

    # midpoints of OSM-only facility edges, deduped on a ~100 m grid
    seen_cells: set[tuple[int, int]] = set()
    sites: list[dict[str, Any]] = []
    for u, v, d in graph.edges(data=True):
        if d.get("cls") not in FACILITY_CLASSES or d.get("cls_source") != "osm":
            continue
        lon = (graph.nodes[u]["x"] + graph.nodes[v]["x"]) / 2
        lat = (graph.nodes[u]["y"] + graph.nodes[v]["y"]) / 2
        cell = (int(lon / 0.0012), int(lat / 0.0009))
        if cell in seen_cells:
            continue
        seen_cells.add(cell)
        name = d.get("name")
        if isinstance(name, list):
            name = name[0]
        sites.append({"lon": round(lon, 6), "lat": round(lat, 6), "cls": d["cls"], "name": name})

    print(f"{len(sites)} OSM-only facility sites; querying up to {MAX_QUERIES}")
    report: list[dict[str, Any]] = []
    for site in sites[:MAX_QUERIES]:
        newest = query_images(token, site["lon"], site["lat"])
        entry = dict(site)
        if newest is not None:
            entry["captured_at"] = newest.get("captured_at")
            entry["thumb"] = newest.get("thumb_1024_url")
        entry["viewer"] = (
            f"https://www.mapillary.com/app/?lat={site['lat']}&lng={site['lon']}&z=17"
        )
        report.append(entry)
    out = config.DATA_DIR / "mapillary_report.json"
    out.write_text(json.dumps(report, indent=1))
    covered = sum(1 for r in report if "captured_at" in r)
    print(f"wrote {out}: {covered}/{len(report)} sites have imagery")


if __name__ == "__main__":
    run()
