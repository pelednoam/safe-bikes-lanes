"""Elevation sampling from AWS Terrain Tiles (Mapzen terrarium encoding).

Tiles are free, keyless, and cached in data/raw/terrain/. Decoding:
elevation_m = (R * 256 + G + B / 256) - 32768.
"""

import io
import math
import urllib.request
from pathlib import Path
from typing import Final

import config
from PIL import Image

TERRAIN_URL: Final[str] = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ZOOM: Final[int] = 13  # ~14 m/pixel at this latitude; plenty for street grades
TILE_SIZE: Final[int] = 256


def _tile_xy(lon: float, lat: float, z: int) -> tuple[float, float]:
    """Slippy-map tile coordinates (fractional)."""
    n = 2.0**z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n
    return x, y


class ElevationSampler:
    """Lazily downloads + caches terrain tiles; samples elevation per point."""

    def __init__(self, cache_dir: Path | None = None) -> None:
        self.cache_dir = cache_dir if cache_dir is not None else config.RAW_DIR / "terrain"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._tiles: dict[tuple[int, int], list[tuple[int, int, int]]] = {}

    def _tile_pixels(self, tx: int, ty: int) -> list[tuple[int, int, int]]:
        key = (tx, ty)
        cached = self._tiles.get(key)
        if cached is not None:
            return cached
        path = self.cache_dir / f"{ZOOM}_{tx}_{ty}.png"
        if not path.exists():
            url = TERRAIN_URL.format(z=ZOOM, x=tx, y=ty)
            req = urllib.request.Request(url, headers={"User-Agent": "family-bike-router/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                path.write_bytes(r.read())
        with Image.open(io.BytesIO(path.read_bytes())) as img:
            pixels = list(img.convert("RGB").getdata())
        self._tiles[key] = pixels
        return pixels

    def elevation(self, lon: float, lat: float) -> float:
        """Elevation in meters (nearest-pixel sample)."""
        fx, fy = _tile_xy(lon, lat, ZOOM)
        tx, ty = int(fx), int(fy)
        px = min(int((fx - tx) * TILE_SIZE), TILE_SIZE - 1)
        py = min(int((fy - ty) * TILE_SIZE), TILE_SIZE - 1)
        r, g, b = self._tile_pixels(tx, ty)[py * TILE_SIZE + px]
        return (r * 256 + g + b / 256) - 32768
