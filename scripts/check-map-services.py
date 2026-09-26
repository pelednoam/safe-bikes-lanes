#!/usr/bin/env python3
"""Are the third-party services the map is drawn from still answering, and
still answering with what the app expects?

check-live-data.py watches this project's own data. Nothing watched the services
the map is built out of, and one of them broke in the way hardest to notice: in
September 2026 Carto began stamping "API KEY REQUIRED" across its raster basemap
tiles. Every request still returned 200 OK, a valid PNG of the right size, in the
right content type. The map looked broken to every visitor and every check was
green; users found it. Then the same stamp reached the labels-only raster the
city pages drew over aerial photography, three weeks after that layer had been
checked and called clean.

So this asserts content, not status:

  - Carto's vector styles must parse, carry a real layer list, and mention no
    API key anywhere — a stamp on vector data would have to arrive as a layer or
    a feature, since there are no pixels to draw it into;
  - the tile URLs and glyph URL those styles point at must be the ones the app
    hard-codes in web/src/basemap.ts. The app names its tiles inline so its pages
    do not wait on Carto to draw their own layers; if Carto moves them, the map
    goes blank while Carto's own styles keep working;
  - every vector tile host must return a tile that decompresses to the map
    layers the styles draw (roads, water);
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
MIN_STYLE_LAYERS = 20

STAMP = re.compile(rb"api[\s_-]?key", re.IGNORECASE)


# ---------------------------------------------------------------------------
# What the app requests, read from its source
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AppUrls:
    carto_tiles: list[str]
    carto_glyphs: str
    carto_styles: list[str]
    aerial: str
    terrain: str
    nominatim_search: str
    mapillary_images: str


def _one(pattern: str, text: str, what: str) -> str:
    found = re.search(pattern, text)
    if found is None:
        raise LookupError(f"could not find {what} in the app's source — has it moved?")
    return found.group(1) if found.groups() else found.group(0)


def parse_carto_tiles(basemap_ts: str) -> list[str]:
    block = re.search(r"export const CARTO_TILES = \[(.*?)\];", basemap_ts, re.DOTALL)
    if block is None:
        raise LookupError("could not find CARTO_TILES in basemap.ts")
    tiles = re.findall(r'"(https://[^"]+)"', block.group(1))
    if not tiles:
        raise LookupError("CARTO_TILES in basemap.ts lists no URLs")
    return tiles


def read_app_urls(src: Path = WEB_SRC) -> AppUrls:
    basemap = (src / "basemap.ts").read_text()
    app = (src / "app.ts").read_text()
    segment = (src / "segment.ts").read_text()
    styles = sorted(
        set(
            re.findall(
                r"https://basemaps\.cartocdn\.com/gl/[a-z-]+-gl-style/style\.json", basemap
            )
        )
    )
    if not styles:
        raise LookupError("could not find any Carto style URL in basemap.ts")
    return AppUrls(
        carto_tiles=parse_carto_tiles(basemap),
        carto_glyphs=_one(r'export const CARTO_GLYPHS = "([^"]+)"', basemap, "CARTO_GLYPHS"),
        carto_styles=styles,
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


def style_problems(name: str, style: Any) -> list[str]:
    problems: list[str] = []
    if not isinstance(style, dict):
        return [f"{name}: not a style object"]
    layers = style.get("layers")
    if not isinstance(layers, list) or len(layers) < MIN_STYLE_LAYERS:
        count = len(layers) if isinstance(layers, list) else 0
        problems.append(f"{name}: only {count} layers — not the basemap it used to be")
    source = (style.get("sources") or {}).get("carto")
    if not isinstance(source, dict) or not source.get("url"):
        problems.append(f"{name}: no 'carto' vector source — the app's layers name that source")
    if STAMP.search(json.dumps(style).encode()):
        problems.append(f"{name}: mentions an API key — Carto may be stamping its vector styles")
    return problems


def vector_tile_problems(host: str, body: bytes) -> list[str]:
    try:
        raw = gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body
    except OSError:
        return [f"{host}: tile does not decompress"]
    problems: list[str] = []
    # Measured decompressed: how much map the tile holds, not how well it
    # happened to compress.
    if len(raw) < MIN_VECTOR_TILE_BYTES:
        problems.append(f"{host}: tile is {len(raw)} bytes — empty or an error, not a map tile")
    for layer in (b"transportation", b"water"):
        if layer not in raw:
            problems.append(
                f"{host}: tile has no '{layer.decode()}' layer — nothing to draw roads with"
            )
    if STAMP.search(raw):
        problems.append(f"{host}: tile mentions an API key — Carto may be stamping vector tiles")
    return problems


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


def check_carto(urls: AppUrls) -> list[str]:
    problems: list[str] = []
    tilejson_urls: set[str] = set()
    glyph_urls: set[str] = set()
    for style_url in urls.carto_styles:
        name = style_url.split("/gl/")[1].split("/")[0]
        try:
            style = fetch_json(style_url)
        except Exception as err:  # any failure is the finding
            problems.append(f"carto style {name}: {err}")
            continue
        problems += [f"carto style {p}" for p in style_problems(name, style)]
        source = (style.get("sources") or {}).get("carto") or {}
        if isinstance(source.get("url"), str):
            tilejson_urls.add(source["url"])
        if isinstance(style.get("glyphs"), str):
            glyph_urls.add(style["glyphs"])

    # The app names its tiles inline (see CARTO_TILES). If the tileset the styles
    # use has moved, the styles keep working and the app's map goes blank.
    for tj in sorted(tilejson_urls):
        try:
            served = fetch_json(tj).get("tiles", [])
        except Exception as err:
            problems.append(f"carto tilejson: {err}")
            continue
        if sorted(served) != sorted(urls.carto_tiles):
            problems.append(
                "carto tiles have moved: the styles now use "
                f"{served} but web/src/basemap.ts CARTO_TILES has {urls.carto_tiles}"
            )
    for glyphs in sorted(glyph_urls):
        if glyphs != urls.carto_glyphs:
            problems.append(
                f"carto glyphs have moved: the styles use {glyphs} but basemap.ts "
                f"CARTO_GLYPHS is {urls.carto_glyphs} — city and build page labels would vanish"
            )

    z, x, y = VECTOR_TILE
    for template in urls.carto_tiles:
        host = urllib.parse.urlparse(template).hostname or template
        try:
            status, body, _ = fetch(fill(template, z, x, y))
        except ConnectionError as err:
            problems.append(f"carto tiles {err}")
            continue
        if status != 200:
            problems.append(f"carto tiles {host}: HTTP {status}")
            continue
        problems += [f"carto tiles {p}" for p in vector_tile_problems(host, body)]

    # One glyph range in a font the styles actually ask for.
    glyph_url = urls.carto_glyphs.replace("{fontstack}", "Open Sans Regular").replace(
        "{range}", "0-255"
    )
    try:
        status, body, _ = fetch(urllib.parse.quote(glyph_url, safe=":/"))
        if status != 200 or len(body) < 1_000:
            problems.append(
                f"carto glyphs: HTTP {status}, {len(body)} bytes — labels would not draw"
            )
    except ConnectionError as err:
        problems.append(f"carto glyphs: {err}")
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
        ("carto basemap", lambda: check_carto(urls)),
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
