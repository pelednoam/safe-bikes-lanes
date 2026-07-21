"""Aerial-imagery helpers: MassGIS ortho tiles (2023 + 2025), cached fetching,
crop extraction around a point, and pavement-marking pixel classification.

All classification here is a heuristic reviewer aid — it proposes, a human
confirms. Green thresholds target Cambridge's saturated blue-green lane paint
and deliberately exclude the yellow-greens of vegetation.
"""

import io
import math
import urllib.request
from pathlib import Path
from typing import Final

import config
import numpy as np
import numpy.typing as npt
from PIL import Image

TILE_URL: Final[str] = (
    "https://tiles.arcgis.com/tiles/hGdibHYSPO59RG1h/arcgis/rest/services/"
    "{service}/MapServer/tile/{z}/{y}/{x}"
)
SERVICES: Final[dict[str, str]] = {
    "2023": "orthos2023",
    "2025": "Massachusetts_Aerial_Imagery_2025",
}
ZOOM: Final[int] = 20  # 0.149 m/px — native 15 cm imagery
TILE_SIZE: Final[int] = 256

# marking classification thresholds (heuristic, tuned on real crops):
# lane-paint green is BRIGHT (val >= 0.28) — dark blue-green roofs, which
# dominate residential crops, sit below that and must not count.
GREEN_HUE_RANGE: Final[tuple[float, float]] = (128.0, 178.0)
GREEN_MIN_SAT: Final[float] = 0.30
GREEN_VAL_RANGE: Final[tuple[float, float]] = (0.28, 0.90)
WHITE_MAX_SAT: Final[float] = 0.22
WHITE_MIN_VAL: Final[float] = 0.68


def tile_xy(lon: float, lat: float, z: int = ZOOM) -> tuple[float, float]:
    """Fractional slippy-map tile coordinates."""
    n = 2.0**z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


class TileStore:
    """Fetches and caches ortho tiles for one imagery vintage."""

    def __init__(self, vintage: str, cache_root: Path | None = None) -> None:
        self.service = SERVICES[vintage]
        self.vintage = vintage
        root = cache_root if cache_root is not None else config.RAW_DIR / "aerial"
        self.cache = root / vintage
        self.cache.mkdir(parents=True, exist_ok=True)
        self.fetched = 0

    def tile(self, tx: int, ty: int) -> npt.NDArray[np.uint8] | None:
        """RGB array for a tile, or None when unavailable."""
        path = self.cache / f"{ZOOM}_{tx}_{ty}.jpg"
        if not path.exists():
            url = TILE_URL.format(service=self.service, z=ZOOM, y=ty, x=tx)
            req = urllib.request.Request(
                url, headers={"User-Agent": "family-bike-router/1.0 (lane QA)"}
            )
            try:
                with urllib.request.urlopen(req, timeout=45) as r:
                    path.write_bytes(r.read())
                self.fetched += 1
            except OSError:
                return None
        try:
            with Image.open(io.BytesIO(path.read_bytes())) as img:
                return np.asarray(img.convert("RGB"), dtype=np.uint8)
        except OSError:
            return None

    def crop(self, lon: float, lat: float, half: int = 80) -> npt.NDArray[np.uint8] | None:
        """(2*half)² RGB crop centered on lon/lat, mosaicked across tiles."""
        fx, fy = tile_xy(lon, lat)
        cx = int(fx * TILE_SIZE)  # global pixel coords
        cy = int(fy * TILE_SIZE)
        size = 2 * half
        out = np.zeros((size, size, 3), dtype=np.uint8)
        filled = False
        ty0, ty1 = (cy - half) // TILE_SIZE, (cy + half - 1) // TILE_SIZE
        tx0, tx1 = (cx - half) // TILE_SIZE, (cx + half - 1) // TILE_SIZE
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                arr = self.tile(tx, ty)
                if arr is None:
                    continue
                # overlap of this tile with the crop window, in global pixels
                gx0 = max(cx - half, tx * TILE_SIZE)
                gx1 = min(cx + half, (tx + 1) * TILE_SIZE)
                gy0 = max(cy - half, ty * TILE_SIZE)
                gy1 = min(cy + half, (ty + 1) * TILE_SIZE)
                if gx0 >= gx1 or gy0 >= gy1:
                    continue
                ox0, oy0 = cx - half, cy - half
                out[gy0 - oy0 : gy1 - oy0, gx0 - ox0 : gx1 - ox0] = arr[
                    gy0 - ty * TILE_SIZE : gy1 - ty * TILE_SIZE,
                    gx0 - tx * TILE_SIZE : gx1 - tx * TILE_SIZE,
                ]
                filled = True
        return out if filled else None


def marking_ratios(rgb: npt.NDArray[np.uint8]) -> tuple[float, float]:
    """(green_paint_ratio, white_marking_ratio) of an RGB crop, each in 0..1."""
    arr = rgb.astype(np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    v = arr.max(axis=-1)
    c = v - arr.min(axis=-1)
    s = np.where(v > 0, c / np.maximum(v, 1e-6), 0.0)
    # hue in degrees (only needed where chroma is meaningful)
    hue = np.zeros_like(v)
    mask = c > 1e-6
    rm, gm, bm = r[mask], g[mask], b[mask]
    cm, vm = c[mask], v[mask]
    h = np.where(
        vm == rm,
        ((gm - bm) / cm) % 6,
        np.where(vm == gm, (bm - rm) / cm + 2, (rm - gm) / cm + 4),
    )
    hue[mask] = h * 60.0
    green = (
        (hue >= GREEN_HUE_RANGE[0])
        & (hue <= GREEN_HUE_RANGE[1])
        & (s >= GREEN_MIN_SAT)
        & (v >= GREEN_VAL_RANGE[0])
        & (v <= GREEN_VAL_RANGE[1])
    )
    white = (s <= WHITE_MAX_SAT) & (v >= WHITE_MIN_VAL)
    n = float(rgb.shape[0] * rgb.shape[1])
    return float(green.sum()) / n, float(white.sum()) / n
