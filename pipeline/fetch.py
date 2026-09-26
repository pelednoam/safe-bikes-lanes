"""Download and cache all data sources into data/raw/.

Re-runnable: pass --refresh to re-download, otherwise cached files are kept.
Each fetch records a sidecar .meta.json with the source URL and retrieval time.
"""

import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any, Final

import config

UA: Final[dict[str, str]] = {"User-Agent": "family-bike-router/1.0 (personal project)"}

GeoJSON = dict[str, Any]


BROWSER_UA: Final[dict[str, str]] = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
}


# One dropped connection used to fail the whole weekly refresh. Three tries,
# a little apart, rides out a blip; a server that is actually down is still
# down on the third, and fails the refresh as it should.
GET_ATTEMPTS: Final[int] = 3
GET_RETRY_WAIT_S: Final[float] = 10.0


def _get(url: str, timeout: int = 120, browser: bool = False, data: bytes | None = None) -> bytes:
    """GET `url`, or POST `data` to it, retrying what might be transient.

    A 4xx is an answer, not a blip, and is raised at once.
    """
    req = urllib.request.Request(url, data=data, headers=BROWSER_UA if browser else UA)
    for attempt in range(1, GET_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body: bytes = r.read()
            return body
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == GET_ATTEMPTS:
                raise
        except OSError:  # refused, reset, timed out
            if attempt == GET_ATTEMPTS:
                raise
        time.sleep(GET_RETRY_WAIT_S * attempt)
    raise AssertionError("unreachable")


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


ARCGIS_PAGE: Final[int] = 1000


def _arcgis_json(
    layer_url: str, path: str, params: dict[str, str | int], post: bool = False
) -> Any:
    """One ArcGIS REST call. POST for long parameters — a page of object ids
    runs to kilobytes, past what some servers accept in a URL."""
    body = urllib.parse.urlencode(params)
    if post:
        data = json.loads(_get(layer_url + path, data=body.encode()))
    else:
        data = json.loads(_get(layer_url + path + "?" + body))
    if isinstance(data, dict) and "error" in data:
        raise RuntimeError(f"{layer_url}: {data['error']}")
    return data


def arcgis_query(layer_url: str, where: str = "1=1", bbox: bool = True) -> GeoJSON:
    """Query an ArcGIS FeatureServer/MapServer layer for every matching feature.

    Returns a GeoJSON FeatureCollection (f=geojson is supported on all the
    servers we use; verified 2026-07).

    Asks for the matching object ids first, then for the features by id, a
    page at a time, and fails if any id does not come back. Paging by offset
    could not be made to work: MassDOT's layers leave rows out of paged
    queries, paged by offset or by id range alike, while the count, the id
    list and a query by id all include them (measured 2026-09: 10 of 14,939
    Bike Inventory rows short, 971 of 251,046 LTS rows). Offset paging
    also shifts every later page by each row dropped, repeating some rows
    and skipping others. Before this the pager also stopped at the first page
    shorter than 1,000, so a layer capped at 500 came back as 500 features.
    """
    info = _arcgis_json(layer_url, "", {"f": "json"})
    page_size = min(ARCGIS_PAGE, int(info.get("maxRecordCount") or ARCGIS_PAGE))

    params: dict[str, str | int] = {"where": where}
    if bbox:
        params.update(
            {
                "geometry": (
                    f"{config.BBOX_WEST},{config.BBOX_SOUTH},{config.BBOX_EAST},{config.BBOX_NORTH}"
                ),
                "geometryType": "esriGeometryEnvelope",
                "inSR": 4326,
                "spatialRel": "esriSpatialRelIntersects",
            }
        )
    answer = _arcgis_json(layer_url, "/query", {**params, "returnIdsOnly": "true", "f": "json"})
    oid = str(answer.get("objectIdFieldName") or info.get("objectIdField") or "OBJECTID")
    ids: list[int] = sorted(answer.get("objectIds") or [])

    by_id: dict[Any, dict[str, Any]] = {}
    for start in range(0, len(ids), page_size):
        chunk = ids[start : start + page_size]
        page: GeoJSON = _arcgis_json(
            layer_url,
            "/query",
            {
                "objectIds": ",".join(map(str, chunk)),
                "outFields": "*",
                "outSR": 4326,
                "f": "geojson",
            },
            post=True,
        )
        for feat in page.get("features", []):
            by_id[(feat.get("properties") or {}).get(oid, feat.get("id"))] = feat
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise RuntimeError(
            f"{layer_url}: {len(missing)} of {len(ids)} features did not come back "
            f"when asked for by id (e.g. {oid} {missing[:5]})"
        )
    return {"type": "FeatureCollection", "features": [by_id[i] for i in ids]}


def fetch_pois() -> GeoJSON:
    """Kid-friendly POIs (playgrounds, ice cream, libraries, water, restrooms)
    via Overpass."""
    bbox = f"{config.BBOX_SOUTH},{config.BBOX_WEST},{config.BBOX_NORTH},{config.BBOX_EAST}"
    query = f"""[out:json][timeout:90];
(
  nwr["leisure"="playground"]({bbox});
  nwr["amenity"="school"]({bbox});
  nwr["amenity"="kindergarten"]({bbox});
  nwr["amenity"="ice_cream"]({bbox});
  node["cuisine"="ice_cream"]({bbox});
  nwr["amenity"="library"]({bbox});
  node["amenity"="drinking_water"]({bbox});
  nwr["amenity"="toilets"]({bbox});
);
out center tags;"""
    # public Overpass instances 504 under load — try mirrors with retry
    endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://lz4.overpass-api.de/api/interpreter",
    ]
    body = urllib.parse.urlencode({"data": query}).encode()
    raw = None
    last_err: Exception | None = None
    for _attempt in range(2):
        for ep in endpoints:
            try:
                req = urllib.request.Request(ep, data=body, headers=UA)
                with urllib.request.urlopen(req, timeout=180) as r:
                    answer = json.load(r)
                # A query that times out part-way still answers 200, with what
                # it had and a `remark` saying so. Taking it published a POI
                # layer missing whatever the query had not reached.
                if isinstance(answer, dict) and answer.get("remark"):
                    raise ValueError(f"partial Overpass response: {answer['remark']}")
                raw = answer
                break
            except (OSError, ValueError) as e:  # HTTP/timeout/JSON/partial
                last_err = e
                continue
        if raw is not None:
            break
    if raw is None:
        raise RuntimeError(f"all Overpass endpoints failed: {last_err}")
    features: list[dict[str, Any]] = []
    for el in raw.get("elements", []):
        tags: dict[str, str] = el.get("tags", {})
        lon = el.get("lon") or el.get("center", {}).get("lon")
        lat = el.get("lat") or el.get("center", {}).get("lat")
        if lon is None or lat is None:
            continue
        if tags.get("leisure") == "playground":
            kind = "playground"
        elif tags.get("amenity") in ("school", "kindergarten"):
            kind = "school"
        elif tags.get("amenity") == "ice_cream" or tags.get("cuisine") == "ice_cream":
            kind = "ice_cream"
        elif tags.get("amenity") == "library":
            kind = "library"
        elif tags.get("amenity") == "drinking_water":
            kind = "water"
        elif tags.get("amenity") == "toilets":
            kind = "restroom"
        else:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                "properties": {"kind": kind, "name": tags.get("name", "")},
            }
        )
    return {"type": "FeatureCollection", "features": features}


def fetch_towns() -> GeoJSON:
    """Municipal boundaries, trimmed to TOWN name only.

    The source layer carries a dozen administrative fields and multi-part coast
    geometry; the where-to-build module needs only which polygon a street falls
    in, and the untrimmed layer is 4.9 MB of properties we'd never read.
    """
    fc = arcgis_query(config.MASSGIS_TOWNS_URL)
    for feat in fc.get("features", []):
        props = feat.get("properties", {})
        feat["properties"] = {"town": str(props.get("TOWN", "")).title()}
    return fc


def fetch_population() -> GeoJSON:
    """Census 2020 block groups, trimmed to population + outer rings.

    Only the population and the shape are wanted: the source carries three dozen
    administrative fields and 10 MB of multi-part geometry for our bbox alone.
    Interior rings are dropped — a lake inside a block group doesn't change how
    many people live in it, and the polygons are only used to decide which
    streets a block group's residents live on.
    """
    fc = arcgis_query(config.CENSUS_BLOCKGROUPS_URL)
    out: list[dict[str, Any]] = []
    for feat in fc.get("features", []):
        props = feat.get("properties", {})
        geom = feat.get("geometry") or {}
        try:
            pop = int(props.get("POP100") or 0)
        except (TypeError, ValueError):
            pop = 0
        if geom.get("type") == "Polygon":
            polys = [geom.get("coordinates", [])]
        elif geom.get("type") == "MultiPolygon":
            polys = geom.get("coordinates", [])
        else:
            continue
        rings = [
            [[round(float(x), 5), round(float(y), 5)] for x, y in poly[0]] for poly in polys if poly
        ]
        if not rings:
            continue
        out.append(
            {
                "type": "Feature",
                "geometry": {"type": "MultiPolygon", "coordinates": [[r] for r in rings]},
                "properties": {"geoid": str(props.get("GEOID", "")), "pop": pop},
            }
        )
    return {"type": "FeatureCollection", "features": out}


SOCRATA_PAGE: Final[int] = 1000


def fetch_cambridge_permits() -> GeoJSON:
    """Active Cambridge street/excavation permits (geocoded, with end dates)."""
    today = datetime.date.today().isoformat()
    where = f"status='Active' AND end_date>='{today}T00:00:00.000'"
    # Paged, and in a fixed order: one request with $limit=5000 silently ended
    # the list at 5,000, and Socrata pages without $order can skip and repeat.
    rows: list[dict[str, Any]] = []
    while True:
        query = {"$where": where, "$order": ":id", "$limit": SOCRATA_PAGE, "$offset": len(rows)}
        page: list[dict[str, Any]] = json.loads(
            _get(config.CAMBRIDGE_PERMITS_URL + "?" + urllib.parse.urlencode(query))
        )
        rows.extend(page)
        if len(page) < SOCRATA_PAGE:
            break
    features: list[dict[str, Any]] = []
    for row in rows:
        try:
            lon = float(row["longitude"])
            lat = float(row["latitude"])
        except (KeyError, TypeError, ValueError):
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                "properties": {
                    "src": "cambridge_permit",
                    "name": row.get("city_contract_name") or row.get("company_name") or "",
                    "address": row.get("full_address", ""),
                    "start": str(row.get("start_date", ""))[:10],
                    "end": str(row.get("end_date", ""))[:10],
                    "kind": row.get("permit_type", "Excavation"),
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def fetch_workzones() -> GeoJSON:
    """MassDOT Connected Work Zones (WZDx GeoJSON). Needs an API key."""
    key = os.environ.get(config.WZDX_KEY_ENV, "")
    if not key:
        raise RuntimeError(
            f"{config.WZDX_KEY_ENV} not set — register (free) at the MassDOT "
            "Work Zones portal to enable statewide work-zone data"
        )
    # verified 2026-07-22: the feed authenticates with a Bearer token
    req = urllib.request.Request(
        config.WZDX_FEED_URL, headers={**UA, "Authorization": f"Bearer {key}"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        feed: GeoJSON = json.load(r)
    return feed


def fetch_mapc() -> GeoJSON:
    """MAPC AllTrails: query each EXISTING typed layer and tag every feature
    with its mapped protection class in a `mapc_cls` property."""
    features: list[dict[str, Any]] = []
    for layer_id, cls in config.MAPC_ALLTRAILS_LAYERS.items():
        fc = arcgis_query(f"{config.MAPC_ALLTRAILS_URL}/{layer_id}")
        for f in fc.get("features", []):
            f.setdefault("properties", {})["mapc_cls"] = cls
            features.append(f)
    return {"type": "FeatureCollection", "features": features}


# Sources that change slowly enough that a known copy beats going without.
# Somerville's high-crash corridors are the city's own analysis, revised
# rarely, and they raise the crash penalty on the streets they name. On
# 2026-09-26 the city's GIS server was unreachable all day. Failing the
# refresh held back every other source's week of changes, and building
# without the layer would have made those corridors look safer than the city
# says they are. A copy is used only when the live fetch fails. The run says
# so, with the copy's date, and the sidecar records it.
FALLBACK_DIR: Final[Path] = Path(__file__).parent / "fallback"
FALLBACKS: Final[frozenset[str]] = frozenset({"somerville_high_crash_corridors.geojson"})


def _use_fallback(name: str, error: Exception) -> bool:
    """Save the committed copy of `name` in place of a failed fetch, if it has one."""
    path = FALLBACK_DIR / name
    if name not in FALLBACKS or not path.exists():
        return False
    meta = json.loads((FALLBACK_DIR / f"{name}.meta.json").read_text())
    copied = str(meta.get("retrieved", "?"))[:10]
    _save(
        name,
        json.loads(path.read_text()),
        f"committed copy of {copied} (live fetch failed: {error})",
    )
    # a GitHub Actions annotation, so it shows on the run's page, not only in its log
    print(f"::warning::{name}: live fetch failed ({error}); using the committed copy of {copied}")
    return True


def fetch_all(refresh: bool = False) -> list[tuple[str, str]]:
    """Fetch every source; return the ones that failed.

    One dead endpoint doesn't stop the others being fetched, but it is a
    failure (see main): the build that follows would otherwise run without
    that layer — or, locally, on last month's copy of it — and publish the
    result as this week's data.
    """
    jobs: dict[str, Callable[[], GeoJSON]] = {
        "cambridge_bike_facilities.geojson": lambda: json.loads(
            _get(config.CAMBRIDGE_FACILITIES_URL)
        ),
        "boston_bike_facilities.geojson": lambda: arcgis_query(config.BOSTON_FACILITIES_URL),
        "newton_bike_facilities.geojson": lambda: arcgis_query(config.NEWTON_FACILITIES_URL),
        "everett_bike_facilities.geojson": lambda: arcgis_query(config.EVERETT_FACILITIES_URL),
        "natick_bike_facilities.geojson": lambda: arcgis_query(config.NATICK_FACILITIES_URL),
        "salem_bike_facilities.geojson": lambda: arcgis_query(config.SALEM_FACILITIES_URL),
        "mapc_bike_network.geojson": fetch_mapc,
        "massdot_bike_inventory.geojson": lambda: arcgis_query(config.MASSDOT_BIKE_INVENTORY),
        "massdot_lts.geojson": lambda: arcgis_query(config.MASSDOT_LTS),
        "somerville_high_crash_corridors.geojson": lambda: arcgis_query(
            f"{config.SOMERVILLE_MOBILITY3}/{config.SOMERVILLE_HIGH_CRASH_LAYERS['corridors']}"
        ),
    }
    jobs["pois.geojson"] = fetch_pois
    jobs["towns.geojson"] = fetch_towns
    jobs["population.geojson"] = fetch_population
    jobs["cambridge_permits.geojson"] = fetch_cambridge_permits
    # needs a key; without one it is a configuration choice, not a failure
    if os.environ.get(config.WZDX_KEY_ENV):
        jobs["workzones.geojson"] = fetch_workzones
    else:
        print(f"  workzones.geojson: {config.WZDX_KEY_ENV} not set, not configured — skipping")
    for year in config.IMPACT_CRASH_YEARS:
        service_year = config.IMPACT_CRASH_SERVICE_YEAR.get(year, str(year))
        jobs[f"crashes_{year}.geojson"] = lambda y=service_year: arcgis_query(  # type: ignore[misc]
            config.IMPACT_CRASH_URL.format(year=y),
            where=config.IMPACT_CRASH_WHERE,
            bbox=False,
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
            if _use_fallback(name, e):
                continue
            failures.append((name, str(e)))
            print(f"  {name}: FAILED - {e}", file=sys.stderr)
    if failures:
        print(f"\n{len(failures)} source(s) failed: {[f[0] for f in failures]}", file=sys.stderr)
    return failures


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-download cached sources")
    failures = fetch_all(refresh=ap.parse_args(argv).refresh)
    # Exit non-zero, so the weekly refresh stops here instead of building and
    # publishing a snapshot without the layers that failed.
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
