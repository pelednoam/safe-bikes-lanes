"""The safety model (safety_model.json): protection classes, their colours, and
what each rider profile pays per metre to ride them.

The browser router prices the same edges with the same numbers
(web/src/weights.gen.ts, generated from the same file), and a web unit test runs
this module to check the two agree edge for edge. Before, the numbers lived in
config.py, router.ts and app.ts, and the rule for paint on a busy road was
written twice and had already drifted once.

Standard library only: the web test runs `python3 pipeline/weights.py --table`
on a CI runner that has none of the pipeline's dependencies.
"""

from __future__ import annotations

import itertools
import json
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Final, TypedDict


class Profile(TypedDict):
    label: str
    paceKmh: float
    mult: dict[str, float]
    busyLane: float
    busyBuffered: float
    penScale: float


MODEL_PATH: Final[Path] = Path(__file__).with_name("safety_model.json")
_MODEL = json.loads(MODEL_PATH.read_text())

CLASSES: Final[tuple[str, ...]] = tuple(_MODEL["classes"])
CLASS_COLOR: Final[dict[str, str]] = {c: v["color"] for c, v in _MODEL["classes"].items()}
PROFILES: Final[dict[str, Profile]] = _MODEL["profiles"]


def facility_multiplier(
    cls: str,
    road_cls: str,
    busy: bool,
    table: Mapping[str, float],
    busy_lane: float,
    busy_buffered: float,
) -> float:
    """What riding an edge of class `cls` costs per metre, for one profile.

    Two rules on top of the class table:

    On a busy road, paint buys little: a lane or buffered lane there has its own
    (higher) price, and a sharrow — a marking, not a space — buys nothing, so it
    costs what the busy road costs. It used to cost 6.0, a quarter of the bare
    arterial it is painted on.

    And paint can only help. A marked facility never costs more than the same
    street without it: a residential street was 1.4 bare, 3.0 with a painted
    lane and 6.0 with sharrows, so the router steered families off quiet streets
    because someone had improved them. `road_cls` is the street's own class
    (classify_road), and the class shown to riders stays the facility.

    The browser's twin is facilityMultiplier in web/src/router.ts.
    """
    m = table[cls]
    if busy:
        if cls == "lane":
            m = busy_lane
        elif cls == "buffered":
            m = busy_buffered
        elif cls == "sharrow":
            m = table["busy_street"]
    return min(m, table[road_cls])


def profile_multiplier(profile: str, cls: str, road_cls: str, busy: bool) -> float:
    """facility_multiplier with one profile's numbers."""
    p = PROFILES[profile]
    return facility_multiplier(cls, road_cls, busy, p["mult"], p["busyLane"], p["busyBuffered"])


def table() -> list[list[object]]:
    """Every (profile, class, road class, busy) and its price, for the parity test."""
    return [
        [pid, cls, road, busy, profile_multiplier(pid, cls, road, busy)]
        for pid, cls, road, busy in itertools.product(PROFILES, CLASSES, CLASSES, (False, True))
    ]


if __name__ == "__main__":
    if sys.argv[1:] != ["--table"]:
        raise SystemExit("usage: python3 pipeline/weights.py --table")
    json.dump(table(), sys.stdout)
