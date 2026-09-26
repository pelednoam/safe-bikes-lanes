"""The check that watches the services the map is drawn from.

It exists because the worst failure this project has had from a third party was
invisible to anything that reads status codes: Carto served its raster tiles with
200 OK and "API KEY REQUIRED" drawn into the image, and visitors found it before
any check did. So these tests are about recognising a service that answers but
answers wrong — offline, from synthetic bodies — plus one invariant about the app
itself that makes the rest of the check sufficient.
"""

from __future__ import annotations

import gzip
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check-map-services.py"
_spec = importlib.util.spec_from_file_location("check_map_services", SCRIPT)
assert _spec is not None and _spec.loader is not None
check = importlib.util.module_from_spec(_spec)
# Registered before it runs: @dataclass looks its own module up in sys.modules
# while the class is being built, and a module loaded by path is not there yet.
sys.modules[_spec.name] = check
_spec.loader.exec_module(check)

WEB_SRC = Path(__file__).resolve().parents[1] / "web" / "src"


def a_style(**overrides: Any) -> dict[str, Any]:
    style: dict[str, Any] = {
        "version": 8,
        "sources": {"carto": {"type": "vector", "url": "https://tiles.example/tiles.json"}},
        "glyphs": "https://tiles.example/fonts/{fontstack}/{range}.pbf",
        "layers": [{"id": f"l{i}", "type": "line"} for i in range(40)],
    }
    style.update(overrides)
    return style


def a_tile(*layers: bytes, pad: int = 8_000) -> bytes:
    """Stand-in for a Mapbox vector tile: the layer names are stored as plain UTF-8
    inside the protobuf, which is all the check looks for."""
    return gzip.compress(b"\x1a" + b"\x00".join(layers) + b"\x00" * pad)


# --- styles ----------------------------------------------------------------


def test_a_real_looking_style_passes() -> None:
    assert check.style_problems("positron", a_style()) == []


def test_a_style_that_mentions_an_api_key_is_caught() -> None:
    # A stamp on vector data cannot be drawn into pixels; it has to arrive as a
    # layer or a label. Either way the words are in the style.
    stamped = a_style(
        layers=[*a_style()["layers"], {"id": "notice", "type": "symbol",
                                       "layout": {"text-field": "API KEY REQUIRED"}}]
    )
    assert any("API key" in p for p in check.style_problems("positron", stamped))


def test_a_gutted_style_is_caught() -> None:
    problems = check.style_problems("positron", a_style(layers=[{"id": "background"}]))
    assert any("only 1 layers" in p for p in problems)


def test_a_style_without_the_carto_source_is_caught() -> None:
    # The app's injected layers name the source "carto"; renamed, none of them draw.
    problems = check.style_problems("positron", a_style(sources={"openmaptiles": {}}))
    assert any("'carto' vector source" in p for p in problems)


# --- vector tiles ----------------------------------------------------------


def test_a_real_looking_tile_passes() -> None:
    assert check.vector_tile_problems("tiles-a", a_tile(b"transportation", b"water")) == []


def test_an_uncompressed_tile_is_read_too() -> None:
    raw = gzip.decompress(a_tile(b"transportation", b"water"))
    assert check.vector_tile_problems("tiles-a", raw) == []


def test_an_empty_tile_is_caught() -> None:
    # What a tile server answers for "no data here", or with an error it chose to
    # send as 200: well-formed, and nothing to draw.
    problems = check.vector_tile_problems("tiles-a", gzip.compress(b"\x1a\x00"))
    assert any("bytes" in p for p in problems)
    assert any("transportation" in p for p in problems)


def test_a_tile_with_no_roads_is_caught() -> None:
    problems = check.vector_tile_problems("tiles-a", a_tile(b"water"))
    assert any("transportation" in p for p in problems)


def test_a_stamped_vector_tile_is_caught() -> None:
    tile = a_tile(b"transportation", b"water", b"watermark", b"API KEY REQUIRED")
    assert any("API key" in p for p in check.vector_tile_problems("tiles-a", tile))


def test_a_tile_that_does_not_decompress_is_caught() -> None:
    assert check.vector_tile_problems("tiles-a", b"\x1f\x8bnot gzip at all") == [
        "tiles-a: tile does not decompress"
    ]


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
    assert len(urls.carto_tiles) == 4
    assert all(t.endswith("/{z}/{x}/{y}.mvt") for t in urls.carto_tiles)
    assert "{fontstack}" in urls.carto_glyphs
    assert urls.carto_styles
    assert "{z}/{y}/{x}" in urls.aerial
    assert urls.terrain.endswith("/{z}/{x}/{y}.png")


def test_the_app_draws_no_carto_raster_tiles() -> None:
    """What makes checking only Carto's vector services enough.

    Every one of Carto's raster basemap sets is stamped — light_all, dark_all, both
    _nolabels, and since late September dark_only_labels, which the city pages
    were still drawing over aerial photography three weeks after the main map
    moved off raster. A raster tile's stamp is in its pixels, invisible to
    anything this check reads, so the only safe number of them is zero.
    """
    raster = re.compile(r"basemaps\.cartocdn\.com/(?!gl/)[a-z_]+/\{z\}")
    offenders = [
        f"{path.name}:{n}"
        for path in sorted(WEB_SRC.glob("*.ts"))
        for n, line in enumerate(path.read_text().splitlines(), 1)
        if raster.search(line)
    ]
    assert offenders == [], f"Carto raster tiles are stamped 'API KEY REQUIRED': {offenders}"


def test_the_raster_rule_would_have_caught_the_city_pages() -> None:
    # The line the city pages carried until this check existed.
    line = 'tiles: ["https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png"],'
    assert re.search(r"basemaps\.cartocdn\.com/(?!gl/)[a-z_]+/\{z\}", line)


def test_the_real_styles_do_not_trip_the_stamp_detector() -> None:
    # Guards against a detector so eager it would open an issue every day: the
    # words it looks for must not occur in an ordinary style's JSON.
    assert not check.STAMP.search(json.dumps(a_style()).encode())
