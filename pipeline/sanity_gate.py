"""Refuse to publish a snapshot much smaller than the one the site is serving.

Every failure this project has had in its data was quiet: a fetch that timed
out part-way, a layer that never downloaded, a join that matched nothing. Each
produced a snapshot that built, exported and published cleanly, just smaller.
This compares the new web/data/meta.json with the published one and stops on a
large drop in anything that should not shrink week to week:

  - the routing graph's node and edge counts
  - bike crashes joined to it
  - each source's feature count (facility layers, crashes per year, POIs,
    towns, population, LTS, ...)

It deliberately does not compare kilometres per protection class. Those move
when the classifier changes — cycleway=separate stopping being "separated"
moved 57 km at once — and a gate that fires on every honest reclassification
gets overridden by habit.

Construction data (Cambridge permits, MassDOT work zones) is skipped: it is
supposed to come and go.

Stdlib only, so publish-data.sh can run it with any python3.

  python3 pipeline/sanity_gate.py web/data/meta.json

Exit 0 to publish, 1 to stop. ALLOW_DATA_DROP=1 publishes anyway, after
printing what dropped; PUBLISHED_META_URL points at another published copy.
"""

import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any, Final

PUBLISHED_META_URL: Final[str] = "https://pelednoam.github.io/safe-bikes-lanes/data/meta.json"
MAX_DROP: Final[float] = 0.20
OVERRIDE_ENV: Final[str] = "ALLOW_DATA_DROP"
# sources that legitimately empty out: construction comes and goes
VOLATILE: Final[frozenset[str]] = frozenset({"cambridge_permits", "workzones"})


def measures(meta: dict[str, Any]) -> dict[str, float]:
    """The numbers from a meta.json that should not shrink."""
    out: dict[str, float] = {}
    graph = meta.get("graph") or {}
    for key in ("nodes", "edges", "crashes_joined"):
        if isinstance(graph.get(key), (int, float)):
            out[f"graph {key}"] = float(graph[key])
    for src in meta.get("sources") or []:
        name = str(src.get("name", ""))
        if name and name not in VOLATILE and isinstance(src.get("features"), (int, float)):
            out[f"source {name}"] = float(src["features"])
    return out


def compare(
    published: dict[str, Any], new: dict[str, Any], max_drop: float = MAX_DROP
) -> list[str]:
    """Every way `new` is smaller than `published` by more than `max_drop`."""
    before, after = measures(published), measures(new)
    problems: list[str] = []
    for key, old in sorted(before.items()):
        if old <= 0:
            continue
        if key not in after:
            # a measure the published snapshot has and this one lacks entirely:
            # a source that was not fetched, or a graph with no stats at all
            problems.append(f"{key}: {old:,.0f} published, missing from this build")
            continue
        drop = (old - after[key]) / old
        if drop > max_drop:
            problems.append(
                f"{key}: {old:,.0f} published -> {after[key]:,.0f} now ({drop:.0%} fewer)"
            )
    return problems


def fetch_published(url: str) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"User-Agent": "family-bike-router/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data: dict[str, Any] = json.load(r)
    return data


def main(argv: list[str]) -> int:
    new_path = Path(argv[1] if len(argv) > 1 else "web/data/meta.json")
    override = os.environ.get(OVERRIDE_ENV) == "1"
    url = os.environ.get("PUBLISHED_META_URL", PUBLISHED_META_URL)
    new = json.loads(new_path.read_text())
    try:
        published = fetch_published(url)
    except (OSError, ValueError) as exc:
        print(f"  sanity gate: cannot read the published snapshot at {url}: {exc}")
        if override:
            print(f"  publishing without a comparison ({OVERRIDE_ENV}=1)")
            return 0
        print(f"  refusing to publish blind. Retry, or set {OVERRIDE_ENV}=1.")
        return 1
    problems = compare(published, new)
    if not problems:
        print(
            f"  sanity gate: nothing dropped more than {MAX_DROP:.0%} against the snapshot "
            f"built {published.get('built', '?')}"
        )
        return 0
    print(f"  sanity gate: this build is much smaller than the published one ({url}):")
    for p in problems:
        print(f"    - {p}")
    if override:
        print(f"  publishing anyway ({OVERRIDE_ENV}=1)")
        return 0
    print(
        "  refusing to publish. A drop like this is usually a fetch that failed or"
        " came back partial. If it is real (a source retired a layer, the area"
        f" shrank), re-run with {OVERRIDE_ENV}=1."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
