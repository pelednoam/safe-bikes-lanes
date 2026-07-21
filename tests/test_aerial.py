"""Tests for aerial tile math and marking classification (pure parts)."""

import numpy as np
import numpy.typing as npt
from aerial import marking_ratios, tile_xy


def solid(rgb: tuple[int, int, int], size: int = 32) -> npt.NDArray[np.uint8]:
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    arr[:, :] = rgb
    return arr


def test_tile_xy_harvard_square() -> None:
    x, y = tile_xy(-71.1097, 42.3736, 20)
    # matches the tile verified by a live fetch during development
    assert int(x) == 317165
    assert int(y) == 387780


def test_green_paint_detected() -> None:
    # Cambridge bike-lane green: saturated blue-green
    g, w = marking_ratios(solid((0, 130, 90)))
    assert g > 0.95
    assert w < 0.05


def test_vegetation_not_green_paint() -> None:
    # olive / yellow-green vegetation must not count as lane paint
    g, _ = marking_ratios(solid((110, 130, 40)))
    assert g < 0.05


def test_white_markings_detected() -> None:
    g, w = marking_ratios(solid((235, 235, 235)))
    assert w > 0.95
    assert g < 0.05


def test_asphalt_is_neither() -> None:
    g, w = marking_ratios(solid((95, 95, 100)))
    assert g < 0.02
    assert w < 0.02


def test_mixed_scene_ratios() -> None:
    arr = solid((95, 95, 100), 40)  # asphalt
    arr[:10, :] = (0, 130, 90)  # 25% green stripe
    arr[30:, :] = (240, 240, 240)  # 25% white stripe
    g, w = marking_ratios(arr)
    assert 0.2 < g < 0.3
    assert 0.2 < w < 0.3
