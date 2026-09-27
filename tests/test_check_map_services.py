"""The check that watches the services the map is drawn from.

It exists because the worst failure this project has had from a third party was
invisible to anything that reads status codes: Carto, the basemap then, served
its raster tiles with 200 OK and "API KEY REQUIRED" drawn into the image, and
visitors found it before any check did. So these tests are about recognising a
service that answers but answers wrong — offline, from synthetic bodies — and
about reading our own basemap file the way the app does.
"""

from __future__ import annotations

import datetime
import gzip
import importlib.util
import re
import sys
from collections.abc import Callable
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check-map-services.py"
_spec = importlib.util.spec_from_file_location("check_map_services", SCRIPT)
assert _spec is not None and _spec.loader is not None
check = importlib.util.module_from_spec(_spec)
# Registered before it runs: @dataclass looks its own module up in sys.modules
# while the class is being built, and a module loaded by path is not there yet.
sys.modules[_spec.name] = check
_spec.loader.exec_module(check)

WEB_SRC = Path(__file__).resolve().parents[1] / "web" / "src"


def a_tile(*layers: bytes, pad: int = 8_000) -> bytes:
    """Stand-in for a Mapbox vector tile: the layer names are stored as plain UTF-8
    inside the protobuf, which is all the check looks for."""
    return gzip.compress(b"\x1a" + b"\x00".join(layers) + b"\x00" * pad)


# --- vector tiles ----------------------------------------------------------


def test_a_real_looking_tile_passes() -> None:
    assert check.vector_tile_problems("tile", a_tile(b"roads", b"water")) == []


def test_an_uncompressed_tile_is_read_too() -> None:
    raw = gzip.decompress(a_tile(b"roads", b"water"))
    assert check.vector_tile_problems("tile", raw) == []


def test_an_empty_tile_is_caught() -> None:
    # What a tile server answers for "no data here", or with an error it chose to
    # send as 200: well-formed, and nothing to draw.
    problems = check.vector_tile_problems("tile", gzip.compress(b"\x1a\x00"))
    assert any("bytes" in p for p in problems)
    assert any("roads" in p for p in problems)


def test_a_tile_with_no_roads_is_caught() -> None:
    problems = check.vector_tile_problems("tile", a_tile(b"water"))
    assert any("roads" in p for p in problems)


def test_a_tile_that_does_not_decompress_is_caught() -> None:
    assert check.vector_tile_problems("tile", b"\x1f\x8bnot gzip at all") == [
        "tile: tile does not decompress"
    ]


# --- the basemap file --------------------------------------------------------


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        out.append(byte | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _directory(entries: list[tuple[int, int, int, int]]) -> bytes:
    """(tile_id, offset, length, run_length) -> a gzipped PMTiles directory."""
    raw = _varint(len(entries))
    last = 0
    for tid, *_ in entries:
        raw += _varint(tid - last)
        last = tid
    raw += b"".join(_varint(e[3]) for e in entries)
    raw += b"".join(_varint(e[2]) for e in entries)
    raw += b"".join(_varint(e[1] + 1) for e in entries)
    return gzip.compress(raw)


def a_pmtiles(tiles: dict[tuple[int, int, int], bytes], max_zoom: int = 14) -> bytes:
    """A PMTiles v3 file holding `tiles`, behind one level of leaf directory, the
    way a real regional extract is laid out."""
    data = b""
    leaf_entries = []
    for zxy, body in sorted(tiles.items(), key=lambda t: check.tile_id(*t[0])):
        leaf_entries.append((check.tile_id(*zxy), len(data), len(body), 1))
        data += body
    leaf = _directory(leaf_entries)
    root = _directory([(leaf_entries[0][0], 0, len(leaf), 0)])
    root_off = 127
    leaf_off = root_off + len(root)
    data_off = leaf_off + len(leaf)
    u64 = [root_off, len(root), 0, 0, leaf_off, len(leaf), data_off, len(data),
           len(tiles), len(tiles), len(tiles)]
    header = b"PMTiles\x03" + b"".join(v.to_bytes(8, "little") for v in u64)
    header += bytes([1, check.COMPRESSION_GZIP, check.COMPRESSION_GZIP, check.TILE_TYPE_MVT,
                     0, max_zoom])
    header += b"\x00" * (127 - len(header))
    return header + root + leaf + data


def reader(blob: bytes) -> Callable[[int, int], bytes]:
    return lambda offset, length: blob[offset : offset + length]


def test_tiles_are_found_on_the_hilbert_curve_pmtiles_orders_them_by() -> None:
    # the spec's own examples: each zoom's tiles follow the last one's
    assert check.tile_id(0, 0, 0) == 0
    assert [check.tile_id(1, x, y) for x, y in [(0, 0), (0, 1), (1, 1), (1, 0)]] == [1, 2, 3, 4]
    assert check.tile_id(2, 0, 0) == 5


def test_a_tile_is_read_out_through_a_leaf_directory() -> None:
    somerville = a_tile(b"roads", b"water")
    blob = a_pmtiles({(14, 4956, 6057): somerville, (14, 4957, 6057): b"other",
                      (13, 2478, 3028): b"parent"})
    assert check.read_tile(reader(blob), 14, 4956, 6057) == somerville
    assert check.read_tile(reader(blob), 13, 2478, 3028) == b"parent"


def test_a_tile_the_file_does_not_hold_is_none() -> None:
    blob = a_pmtiles({(14, 4956, 6057): b"x"})
    assert check.read_tile(reader(blob), 14, 4956, 6058) is None
    assert check.read_tile(reader(blob), 0, 0, 0) is None


def test_the_header_is_read() -> None:
    header = check.parse_header(a_pmtiles({(14, 1, 1): b"x"}, max_zoom=12)[:127])
    assert (header.tile_type, header.max_zoom) == (check.TILE_TYPE_MVT, 12)


def test_something_that_is_not_pmtiles_is_refused() -> None:
    # what a host sends for a file the deploy left out: its 404 page
    try:
        check.parse_header(b"<!doctype html><title>404</title>" + b" " * 200)
    except ValueError as err:
        assert "not a PMTiles" in str(err)
    else:
        raise AssertionError("an HTML page parsed as a basemap")


def test_a_host_that_ignores_byte_ranges_is_caught(monkeypatch: pytest.MonkeyPatch) -> None:
    # 200 and the whole file for every tile: 50 MB a tile, and every check that
    # reads only the status line would call it healthy
    monkeypatch.setattr(check, "fetch", lambda url, headers=None: (200, b"x" * 500, ""))
    try:
        check.ranged_reader("https://example.test/basemap.pmtiles")(0, 127)
    except ValueError as err:
        assert "not 206" in str(err)
    else:
        raise AssertionError("a 200 to a range request passed")


def test_a_basemap_whose_refresh_stopped_is_caught() -> None:
    today = datetime.date(2026, 12, 20)
    assert check.basemap_age_problems({"build": "20261115.pmtiles"}, today) == []
    stale = check.basemap_age_problems({"build": "20260927.pmtiles"}, today)
    assert stale and "has stopped" in stale[0]
    assert check.basemap_age_problems({}, today)  # no date is not a pass


# --- images ----------------------------------------------------------------


def a_png(width: int, height: int, pad: int = 4_000) -> bytes:
    ihdr = width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"
    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0d" + b"IHDR" + ihdr + b"\x00" * pad


def test_a_real_looking_terrain_tile_passes() -> None:
    assert check.image_problems("terrain", a_png(256, 256), "image/png", "png") == []


def test_an_error_page_served_as_a_tile_is_caught() -> None:
    body = b"<html><body>Service Unavailable</body></html>" * 100
    problems = check.image_problems("aerial imagery", body, "text/html", "jpeg")
    assert problems and "text/html" in problems[0]


def test_a_placeholder_image_is_caught() -> None:
    # "Map data not yet available" tiles are real images, just tiny ones.
    problems = check.image_problems("aerial imagery", b"\xff\xd8" + b"\x00" * 300,
                                    "image/jpeg", "jpeg")
    assert problems and "blank placeholder" in problems[0]


def test_a_wrongly_sized_png_is_caught() -> None:
    problems = check.image_problems("terrain", a_png(512, 512), "image/png", "png")
    assert problems == ["terrain: 512x512 PNG, expected 256x256"]


def test_arcgis_octet_stream_images_are_accepted() -> None:
    # MassGIS's ArcGIS server sends its JPEGs as application/octet-stream.
    body = b"\xff\xd8" + b"\x00" * 5_000
    assert check.image_problems("aerial imagery", body, "application/octet-stream", "jpeg") == []


# --- the app's own source --------------------------------------------------


def test_every_url_the_check_needs_is_found_in_the_app() -> None:
    # If the app renames or moves one of these, the check must say so rather than
    # quietly checking a URL nothing requests any more.
    urls = check.read_app_urls(WEB_SRC)
    assert urls.basemap.endswith("/basemap.pmtiles")
    assert "{z}/{y}/{x}" in urls.aerial
    assert urls.terrain.endswith("/{z}/{x}/{y}.png")


def test_the_map_asks_nothing_of_carto() -> None:
    """What makes checking our own file enough.

    Carto stamped every one of its raster basemap sets, then the labels-only one
    the city pages were still drawing three weeks after the main map had moved
    off raster. The basemap is ours now; any Carto URL left in a page or a
    module would be a request to the service that did that.
    """
    carto = re.compile(r"https://[a-z0-9.-]*cartocdn\.com")
    web = WEB_SRC.parent
    # the source pages, not a build of them (dist/) that may predate this rule
    pages = [p for p in web.glob("*/index.html") if p.parent.name != "dist"]
    files = [*web.glob("src/*.ts"), web / "index.html", *pages, *web.glob("public/*.js")]
    offenders = [
        f"{path.relative_to(web)}:{n}"
        for path in sorted(files)
        for n, line in enumerate(path.read_text().splitlines(), 1)
        if carto.search(line)
    ]
    assert files and offenders == [], f"Carto URLs: {offenders}"


def test_the_rule_would_have_caught_the_city_pages() -> None:
    # The line the city pages carried until the first version of this check.
    line = 'tiles: ["https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png"],'
    assert re.search(r"https://[a-z0-9.-]*cartocdn\.com", line)
