#!/usr/bin/env python3
"""Are the services the map is drawn from still answering, and still answering
with what the app expects?

check-live-data.py watches this project's own data. Nothing watched the services
the map is built out of, and one of them broke in the way hardest to notice: in
September 2026 Carto, the basemap then, began stamping "API KEY REQUIRED" across
its raster tiles. Every request still returned 200 OK, a valid PNG of the right
size, in the right content type. The map looked broken to every visitor and
every check was green; users found it.

The basemap is now our own file (basemap.pmtiles, scripts/publish-basemap.sh),
but it can still fail quietly: a deploy that leaves it out, a host that stops
serving byte ranges and sends all 50 MB for every tile, a monthly refresh that
stopped running. So this asserts content, not status:

  - the site's basemap.pmtiles must answer a byte range with just that range,
    be a PMTiles file of vector tiles to zoom 14, and hold a real tile over
    Somerville with roads and water in it, read the way the app reads it;
  - the published copy must be recent: the monthly refresh has not stopped;
  - aerial imagery and terrain must be real images, not error bodies or
    placeholders;
  - the geocoder must find a known address inside the app's area, and the
    Mapillary token the site publishes must still be accepted.

The URLs are read out of the app's source rather than listed here, so this checks
what the app actually requests, and fails loudly if it can no longer find them.

Standard library only, like check-live-data.py, so it runs without the
pipeline's dependencies.

Usage:
    python3 scripts/check-map-services.py [--site URL]

Exits non-zero with one line per problem.
"""

from __future__ import annotations

import argparse
import datetime
import gzip
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WEB_SRC = ROOT / "web" / "src"
DEFAULT_SITE = "https://pelednoam.github.io/safe-bikes-lanes"
TIMEOUT_S = 30
# Nominatim's usage policy asks for an identifying agent and at most one request
# a second; this makes two a day.
USER_AGENT = "safe-bikes-lanes-health/1.0 (+https://github.com/pelednoam/safe-bikes-lanes)"
NOMINATIM_GAP_S = 1.2

# The published basemap's description, written beside it by publish-basemap.sh.
BASEMAP_RELEASE_JSON = (
    "https://github.com/pelednoam/safe-bikes-lanes/releases/download/basemap/basemap.json"
)
# Refreshed monthly; two missed runs is a refresh that has stopped.
BASEMAP_MAX_AGE_DAYS = 70
BASEMAP_MAXZOOM = 14

# A tile over Somerville/Cambridge, inside the area the app covers: a z14 vector
# tile there always carries roads and water (the Mystic and Charles).
VECTOR_TILE = (14, 4956, 6057)
AERIAL_TILE = (16, 24238, 19823)  # ArcGIS order is z/y/x; see fetch below
TERRAIN_TILE = (12, 1238, 1514)
DAVIS_SQ = (42.3967, -71.1223)

# Real tiles here are tens of kilobytes. An error page, an empty tile, or a
# "no data" placeholder is a few hundred bytes.
MIN_VECTOR_TILE_BYTES = 5_000
MIN_IMAGE_BYTES = 2_000


# ---------------------------------------------------------------------------
# What the app requests, read from its source
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AppUrls:
    basemap: str
    aerial: str
    terrain: str
    nominatim_search: str
    mapillary_images: str


def _one(pattern: str, text: str, what: str) -> str:
    found = re.search(pattern, text)
    if found is None:
        raise LookupError(f"could not find {what} in the app's source — has it moved?")
    return found.group(1) if found.groups() else found.group(0)


def read_app_urls(src: Path = WEB_SRC) -> AppUrls:
    basemap = (src / "basemap.ts").read_text()
    # the app is app.ts and the modules split out of it (src/app/): a service's URL
    # may be in any of them
    app = "\n".join(
        path.read_text() for path in [src / "app.ts", *sorted((src / "app").glob("*.ts"))]
    )
    segment = (src / "segment.ts").read_text()
    return AppUrls(
        basemap=_one(
            r'const SITE_BASEMAP = "(https://[^"]+/basemap\.pmtiles)"', basemap, "SITE_BASEMAP"
        ),
        aerial=_one(
            r'"(https://tiles\.arcgis\.com/[^"]+\{z\}/\{y\}/\{x\})"', app, "the aerial URL"
        ),
        terrain=_one(
            r'"(https://s3\.amazonaws\.com/elevation-tiles-prod/terrarium/\{z\}/\{x\}/\{y\}\.png)"',
            app,
            "the terrain URL",
        ),
        nominatim_search=_one(
            r"https://nominatim\.openstreetmap\.org/search", app, "the geocoder URL"
        ),
        mapillary_images=_one(
            r"https://graph\.mapillary\.com/images", segment, "the Mapillary URL"
        ),
    )


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def fetch(url: str, headers: dict[str, str] | None = None) -> tuple[int, bytes, str]:
    """(status, body, content-type). One retry for a network error or a 5xx, so a
    single blip at 13:00 does not open an issue."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                return resp.status, resp.read(), resp.headers.get("Content-Type", "")
        except urllib.error.HTTPError as err:
            if err.code < 500 or attempt == 2:
                return err.code, err.read(), err.headers.get("Content-Type", "")
        except (urllib.error.URLError, TimeoutError) as err:
            if attempt == 2:
                raise ConnectionError(f"{url}: {err}") from err
        time.sleep(3)
    raise AssertionError("unreachable")


def fetch_json(url: str, headers: dict[str, str] | None = None) -> Any:
    status, body, _ = fetch(url, headers)
    if status != 200:
        raise ValueError(f"HTTP {status}")
    return json.loads(body)


def fill(template: str, z: int, x: int, y: int) -> str:
    return template.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))


# ---------------------------------------------------------------------------
# Content checks — pure, so they can be tested without a network
# ---------------------------------------------------------------------------


def vector_tile_problems(name: str, body: bytes) -> list[str]:
    try:
        raw = gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body
    except OSError:
        return [f"{name}: tile does not decompress"]
    problems: list[str] = []
    # Measured decompressed: how much map the tile holds, not how well it
    # happened to compress.
    if len(raw) < MIN_VECTOR_TILE_BYTES:
        problems.append(f"{name}: tile is {len(raw)} bytes — empty or an error, not a map tile")
    # Protomaps' layer names, which the app's styles (@protomaps/basemaps) draw
    for layer in (b"roads", b"water"):
        if layer not in raw:
            problems.append(
                f"{name}: tile has no '{layer.decode()}' layer — nothing to draw it with"
            )
    return problems


# ---------------------------------------------------------------------------
# PMTiles, read the way the app reads it: a header, a directory, a tile, each
# by byte range (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md)
# ---------------------------------------------------------------------------

PMTILES_HEADER_BYTES = 127
TILE_TYPE_MVT = 1
COMPRESSION_GZIP = 2


@dataclass(frozen=True)
class PMTilesHeader:
    root_offset: int
    root_length: int
    leaf_offset: int
    tile_data_offset: int
    internal_compression: int
    tile_compression: int
    tile_type: int
    max_zoom: int


def parse_header(raw: bytes) -> PMTilesHeader:
    if len(raw) < PMTILES_HEADER_BYTES or raw[:7] != b"PMTiles" or raw[7] != 3:
        raise ValueError("not a PMTiles v3 file")
    u64 = [int.from_bytes(raw[8 + 8 * i : 16 + 8 * i], "little") for i in range(11)]
    return PMTilesHeader(
        root_offset=u64[0],
        root_length=u64[1],
        leaf_offset=u64[4],
        tile_data_offset=u64[6],
        internal_compression=raw[97],
        tile_compression=raw[98],
        tile_type=raw[99],
        max_zoom=raw[101],
    )


def tile_id(z: int, x: int, y: int) -> int:
    """The tile's position on the Hilbert curve PMTiles orders tiles by."""
    acc = sum(1 << (2 * i) for i in range(z))
    n = 1 << z
    d = 0
    s = n // 2
    while s > 0:
        rx = 1 if x & s else 0
        ry = 1 if y & s else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x, y = n - 1 - x, n - 1 - y
            x, y = y, x
        s //= 2
    return acc + d


@dataclass(frozen=True)
class DirEntry:
    tile_id: int
    offset: int
    length: int
    run_length: int  # 0: a leaf directory, not a tile


def _varints(raw: bytes) -> list[int]:
    out: list[int] = []
    value = shift = 0
    for b in raw:
        value |= (b & 0x7F) << shift
        shift += 7
        if not b & 0x80:
            out.append(value)
            value = shift = 0
    return out


def parse_directory(raw: bytes) -> list[DirEntry]:
    v = _varints(raw)
    n = v[0]
    ids, runs, lengths, offsets = (
        v[1 : 1 + n],
        v[1 + n : 1 + 2 * n],
        v[1 + 2 * n : 1 + 3 * n],
        v[1 + 3 * n : 1 + 4 * n],
    )
    entries: list[DirEntry] = []
    tid = 0
    for i in range(n):
        tid += ids[i]
        if offsets[i] == 0 and i > 0:
            offset = entries[i - 1].offset + entries[i - 1].length
        else:
            offset = offsets[i] - 1
        entries.append(DirEntry(tid, offset, lengths[i], runs[i]))
    return entries


def find_entry(entries: list[DirEntry], tid: int) -> DirEntry | None:
    found = None
    for e in entries:  # sorted by tile_id; a directory is at most a few thousand
        if e.tile_id > tid:
            break
        found = e
    if found is None:
        return None
    if found.run_length == 0 or tid < found.tile_id + found.run_length:
        return found
    return None


def read_tile(read: Callable[[int, int], bytes], z: int, x: int, y: int) -> bytes | None:
    """One tile's bytes, via `read(offset, length)`; None where the file has none."""
    header = parse_header(read(0, PMTILES_HEADER_BYTES))

    def directory(offset: int, length: int) -> list[DirEntry]:
        raw = read(offset, length)
        if header.internal_compression == COMPRESSION_GZIP:
            raw = gzip.decompress(raw)
        return parse_directory(raw)

    tid = tile_id(z, x, y)
    entries = directory(header.root_offset, header.root_length)
    for _ in range(4):  # the spec allows at most three levels of leaves
        entry = find_entry(entries, tid)
        if entry is None:
            return None
        if entry.run_length > 0:
            return read(header.tile_data_offset + entry.offset, entry.length)
        entries = directory(header.leaf_offset + entry.offset, entry.length)
    raise ValueError("directory nests deeper than the spec allows")


def png_size(body: bytes) -> tuple[int, int] | None:
    if body[:8] != b"\x89PNG\r\n\x1a\n" or body[12:16] != b"IHDR":
        return None
    return int.from_bytes(body[16:20], "big"), int.from_bytes(body[20:24], "big")


def image_problems(name: str, body: bytes, content_type: str, kind: str) -> list[str]:
    if not content_type.startswith("image/") and not content_type.startswith(
        "application/octet-stream"
    ):
        return [f"{name}: answered {content_type or 'no content type'}, not an image"]
    if len(body) < MIN_IMAGE_BYTES:
        return [f"{name}: image is {len(body)} bytes — an error or a blank placeholder"]
    if kind == "jpeg" and body[:2] != b"\xff\xd8":
        return [f"{name}: not a JPEG"]
    if kind == "png":
        size = png_size(body)
        if size is None:
            return [f"{name}: not a PNG"]
        if size != (256, 256):
            return [f"{name}: {size[0]}x{size[1]} PNG, expected 256x256"]
    return []


# ---------------------------------------------------------------------------
# The checks
# ---------------------------------------------------------------------------


def ranged_reader(url: str) -> Callable[[int, int], bytes]:
    def read(offset: int, length: int) -> bytes:
        end = offset + length - 1
        status, body, _ = fetch(url, {"Range": f"bytes={offset}-{end}"})
        if status == 404:
            raise ValueError("HTTP 404 — the site doesn't serve it; did the deploy leave it out?")
        if status != 206:
            # A 200 here is the whole file: the map would download 50 MB per tile
            raise ValueError(f"HTTP {status} to a byte range, not 206 — ranges aren't served")
        if len(body) != length:
            raise ValueError(f"asked for {length} bytes at {offset}, got {len(body)}")
        return body

    return read


def basemap_age_problems(published: Any, today: datetime.date) -> list[str]:
    build = str(published.get("build", "")) if isinstance(published, dict) else ""
    try:
        built = datetime.datetime.strptime(build[:8], "%Y%m%d").date()
    except ValueError:
        return [f"basemap release: basemap.json names no build date ({build!r})"]
    age = (today - built).days
    if age > BASEMAP_MAX_AGE_DAYS:
        return [
            f"basemap release: built {built}, {age} days ago — the monthly refresh "
            "(.github/workflows/basemap.yml) has stopped"
        ]
    return []


def check_basemap(urls: AppUrls, site: str) -> list[str]:
    problems: list[str] = []
    url = f"{site}/basemap.pmtiles" if site != DEFAULT_SITE else urls.basemap
    read = ranged_reader(url)
    try:
        header = parse_header(read(0, PMTILES_HEADER_BYTES))
        if header.tile_type != TILE_TYPE_MVT:
            problems.append(f"basemap: tile type {header.tile_type}, not vector tiles")
        if header.max_zoom != BASEMAP_MAXZOOM:
            problems.append(
                f"basemap: goes to zoom {header.max_zoom}, the app expects {BASEMAP_MAXZOOM}"
            )
        tile = read_tile(read, *VECTOR_TILE)
        if tile is None:
            problems.append(f"basemap: no tile at {VECTOR_TILE}, over Somerville")
        else:
            if header.tile_compression == COMPRESSION_GZIP:
                tile = gzip.decompress(tile)
            problems += [f"basemap {p}" for p in vector_tile_problems("tile", tile)]
    except (ValueError, OSError, ConnectionError) as err:
        problems.append(f"basemap {url}: {err}")

    try:
        problems += basemap_age_problems(
            fetch_json(BASEMAP_RELEASE_JSON), datetime.datetime.now(datetime.UTC).date()
        )
    except Exception as err:
        problems.append(f"basemap release: {err}")
    return problems


def check_aerial(urls: AppUrls) -> list[str]:
    z, y, x = AERIAL_TILE  # ArcGIS tiles are z/y/x
    url = urls.aerial.replace("{z}", str(z)).replace("{y}", str(y)).replace("{x}", str(x))
    try:
        status, body, ctype = fetch(url)
    except ConnectionError as err:
        return [f"aerial imagery: {err}"]
    if status != 200:
        return [f"aerial imagery: HTTP {status}"]
    return image_problems("aerial imagery", body, ctype, "jpeg")


def check_terrain(urls: AppUrls) -> list[str]:
    try:
        status, body, ctype = fetch(fill(urls.terrain, *TERRAIN_TILE))
    except ConnectionError as err:
        return [f"terrain: {err}"]
    if status != 200:
        return [f"terrain: HTTP {status}"]
    return image_problems("terrain", body, ctype, "png")


def check_geocoder(urls: AppUrls) -> list[str]:
    problems: list[str] = []
    query = urllib.parse.urlencode(
        {"format": "jsonv2", "limit": "5", "q": "12 Elm Street, Somerville, MA"}
    )
    try:
        results = fetch_json(f"{urls.nominatim_search}?{query}")
        near = [
            r
            for r in results
            if 42.35 < float(r.get("lat", 0)) < 42.42 and -71.15 < float(r.get("lon", 0)) < -71.07
        ]
        if not near:
            problems.append(
                f"geocoder: no match for a known Somerville address ({len(results)} results)"
            )
    except Exception as err:
        problems.append(f"geocoder search: {err}")

    time.sleep(NOMINATIM_GAP_S)
    reverse = urls.nominatim_search.replace("/search", "/reverse")
    lat, lon = DAVIS_SQ
    try:
        answer = fetch_json(f"{reverse}?format=jsonv2&zoom=18&lat={lat}&lon={lon}")
        if "Somerville" not in str(answer.get("display_name", "")):
            problems.append("geocoder reverse: Davis Square no longer comes back as Somerville")
    except Exception as err:
        problems.append(f"geocoder reverse: {err}")
    return problems


def check_mapillary(urls: AppUrls, site: str) -> list[str]:
    """The token users get is the one the live site serves, so that is the one
    checked. A revoked token makes every street photo quietly disappear."""
    try:
        token = fetch_json(f"{site}/data/keys.json").get("mapillary", "")
    except Exception as err:
        return [f"mapillary: could not read the site's token: {err}"]
    if not token:
        return ["mapillary: the site publishes no token — street photos are off"]
    lat, lon = DAVIS_SQ
    d = 0.0015  # the app's own search box; a larger one is refused as too much data
    query = urllib.parse.urlencode(
        {
            "access_token": token,
            "bbox": f"{lon - d},{lat - d},{lon + d},{lat + d}",
            "fields": "id",
            "limit": "5",
        }
    )
    try:
        status, body, _ = fetch(f"{urls.mapillary_images}?{query}")
    except ConnectionError as err:
        return [f"mapillary: {err}"]
    if status != 200:
        return [f"mapillary: HTTP {status} — the published token may be revoked or rate-limited"]
    if "data" not in json.loads(body):
        return ["mapillary: answered without a data list"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--site", default=DEFAULT_SITE)
    args = parser.parse_args()

    try:
        urls = read_app_urls()
    except LookupError as err:
        print(f"setup: {err}")
        return 1

    checks: list[tuple[str, Callable[[], list[str]]]] = [
        ("basemap", lambda: check_basemap(urls, args.site)),
        ("aerial imagery", lambda: check_aerial(urls)),
        ("terrain", lambda: check_terrain(urls)),
        ("geocoder", lambda: check_geocoder(urls)),
        ("mapillary", lambda: check_mapillary(urls, args.site)),
    ]
    problems: list[str] = []
    for name, run in checks:
        try:
            found = run()
        except Exception as err:  # a crashed check is still a failed check
            found = [f"{name}: check crashed: {err!r}"]
        print(f"{'ok  ' if not found else 'FAIL'} {name}")
        problems += found

    if problems:
        print()
        for p in problems:
            print(p)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
