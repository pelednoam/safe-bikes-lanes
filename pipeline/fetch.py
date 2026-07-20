"""Download and cache all data sources into data/raw/.

Re-runnable: pass --refresh to re-download, otherwise cached files are kept.
Each fetch records a sidecar .meta.json with the source URL and retrieval time.
"""

import argparse
import datetime
import json
import sys
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any, Final

import config

UA: Final[dict[str, str]] = {"User-Agent": "family-bike-router/1.0 (personal project)"}

GeoJSON = dict[str, Any]


def _get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data: bytes = r.read()
    return data


def _save(name: str, data: GeoJSON, source: str) -> None:
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    path = config.RAW_DIR / name
    path.write_text(json.dumps(data))
    meta = {
        "source": source,
        "retrieved": datetime.datetime.now(datetime.UTC).isoformat(),
        "features": len(data.get("features", [])),
    }
    (config.RAW_DIR / (name + ".meta.json")).write_text(json.dumps(meta, indent=2))
    print(f"  {name}: {meta['features']} features")


def arcgis_query(layer_url: str, where: str = "1=1", bbox: bool = True) -> GeoJSON:
    """Query an ArcGIS FeatureServer/MapServer layer, paging until exhausted.

    Returns a GeoJSON FeatureCollection (f=geojson is supported on all the
    servers we use; verified 2026-07).
    """
    features: list[dict[str, Any]] = []
    offset = 0
    while True:
        params: dict[str, str | int] = {
            "where": where,
            "outFields": "*",
            "outSR": 4326,
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": 1000,
        }
        if bbox:
            params.update(
                {
                    "geometry": (
                        f"{config.BBOX_WEST},{config.BBOX_SOUTH},"
                        f"{config.BBOX_EAST},{config.BBOX_NORTH}"
                    ),
                    "geometryType": "esriGeometryEnvelope",
                    "inSR": 4326,
                    "spatialRel": "esriSpatialRelIntersects",
                }
            )
        url = layer_url + "/query?" + urllib.parse.urlencode(params)
        page: GeoJSON = json.loads(_get(url))
        if "error" in page:
            raise RuntimeError(f"{layer_url}: {page['error']}")
        batch: list[dict[str, Any]] = page.get("features", [])
        features.extend(batch)
        if len(batch) < 1000:
            break
        offset += len(batch)
    return {"type": "FeatureCollection", "features": features}


def fetch_all(refresh: bool = False) -> None:
    jobs: dict[str, Callable[[], GeoJSON]] = {
        "cambridge_bike_facilities.geojson": lambda: json.loads(
            _get(config.CAMBRIDGE_FACILITIES_URL)
        ),
        "massdot_bike_inventory.geojson": lambda: arcgis_query(config.MASSDOT_BIKE_INVENTORY),
        "massdot_lts.geojson": lambda: arcgis_query(config.MASSDOT_LTS),
        "somerville_high_crash_intersections.geojson": lambda: arcgis_query(
            f"{config.SOMERVILLE_MOBILITY3}/{config.SOMERVILLE_HIGH_CRASH_LAYERS['intersections']}"
        ),
        "somerville_high_crash_corridors.geojson": lambda: arcgis_query(
            f"{config.SOMERVILLE_MOBILITY3}/{config.SOMERVILLE_HIGH_CRASH_LAYERS['corridors']}"
        ),
    }
    for year in config.IMPACT_CRASH_YEARS:
        service_year = config.IMPACT_CRASH_SERVICE_YEAR.get(year, str(year))
        jobs[f"crashes_{year}.geojson"] = (
            lambda y=service_year: arcgis_query(  # type: ignore[misc]
                config.IMPACT_CRASH_URL.format(year=y),
                where=config.IMPACT_CRASH_WHERE,
                bbox=False,
            )
        )

    failures: list[tuple[str, str]] = []
    for name, job in jobs.items():
        path = config.RAW_DIR / name
        if path.exists() and not refresh:
            print(f"  {name}: cached, skipping")
            continue
        print(f"fetching {name} ...")
        try:
            _save(name, job(), name)
        except Exception as e:
            failures.append((name, str(e)))
            print(f"  {name}: FAILED - {e}", file=sys.stderr)
    if failures:
        print(f"\n{len(failures)} source(s) failed: {[f[0] for f in failures]}", file=sys.stderr)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-download cached sources")
    fetch_all(refresh=ap.parse_args().refresh)
