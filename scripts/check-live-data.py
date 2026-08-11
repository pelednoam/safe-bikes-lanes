#!/usr/bin/env python3
"""Is the site people actually load still telling the truth?

Every other check in this repo runs before or during a deploy, on data the same
job just built. That leaves the one failure nobody was watching for: a good
deploy whose data is later replaced, or quietly ages, or arrives with a whole
criterion empty.

It happened. The weekly refresh built 6,066 candidates with 4,037 joined bike
crashes on 2026-08-10 at 07:15 UTC. A manual publish at 13:50 replaced that asset
with a local build from a graph predating the crash-count write-back: 5,685
candidates, `crashes: null` on every one, and 805 of them telling a reader
"recorded bike crashes nearby". Every workflow was green for a week.

So this reads the deployed files over HTTP and asserts what a reader is entitled
to assume. It is meant to run on a schedule and to fail loudly.

Usage:
    python3 scripts/check-live-data.py [--base URL] [--max-age-days N]

Exits non-zero with one line per problem.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import urllib.error
import urllib.request
from typing import Any

DEFAULT_BASE = "https://pelednoam.github.io/safe-bikes-lanes"
TIMEOUT_S = 30
# The format the code in this commit expects. Kept here rather than imported so
# this script can run without the pipeline's dependencies installed.
EXPECTED_FORMAT_PATH = "pipeline/config.py"


def fetch_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "safe-bikes-lanes-healthcheck"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read().decode())


def expected_format(path: str = EXPECTED_FORMAT_PATH) -> int | None:
    """DATA_FORMAT from the checked-out pipeline config, by text, not by import.

    Read as text so this script runs with no dependencies installed, and takes the
    path so it can be pointed at a specific checkout rather than at the process's
    working directory.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("DATA_FORMAT"):
                    return int(line.split("=")[1].split("#")[0].strip())
    except OSError:
        return None
    return None


def days_old(stamp: str) -> float | None:
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S"):
        try:
            when = dt.datetime.strptime(stamp, fmt)
        except ValueError:
            continue
        if when.tzinfo is None:
            when = when.replace(tzinfo=dt.UTC)
        return (dt.datetime.now(dt.UTC) - when).total_seconds() / 86400
    return None


def check(base: str, max_age_days: float) -> list[str]:
    problems: list[str] = []
    base = base.rstrip("/")

    try:
        meta = fetch_json(f"{base}/data/meta.json")
    except (urllib.error.URLError, json.JSONDecodeError, OSError) as exc:
        return [f"data/meta.json is not readable: {exc}"]

    # 1. Is it fresh? A refresh that stops running looks exactly like one that
    #    runs and changes nothing — except for this date. GitHub also disables
    #    scheduled workflows after 60 days of repository inactivity, which is a
    #    silent stop by design.
    built = meta.get("built")
    if not isinstance(built, str):
        problems.append("data/meta.json has no build date")
    else:
        age = days_old(built)
        if age is None:
            problems.append(f"data/meta.json build date is unparseable: {built!r}")
        elif age > max_age_days:
            problems.append(
                f"the live data is {age:.1f} days old (built {built}); the refresh "
                f"is weekly, so anything over {max_age_days:.0f} means it stopped "
                "or its publish was discarded"
            )

    # 2. Does it match the code that is deployed beside it? check-data-format.sh
    #    asserts this at deploy time; a later publish of a differently-shaped
    #    snapshot is invisible to that.
    want = expected_format()
    if want is not None and meta.get("format") != want:
        problems.append(
            f"live data format is {meta.get('format')!r}, this commit expects {want}"
        )

    # 3. The ranking, if this build has one. These are the claims a city quotes.
    try:
        prio_meta = fetch_json(f"{base}/data/priorities_meta.json")
        prio = fetch_json(f"{base}/data/priorities.geojson")
    except (urllib.error.URLError, json.JSONDecodeError, OSError):
        # A build without a ranking is legitimate — the app hides the section.
        return problems

    features = prio.get("features") or []
    if not features:
        problems.append("priorities.geojson has no candidates")
        return problems

    provenance = prio_meta.get("provenance") or {}
    if provenance.get("graph_edge_schema") is None:
        problems.append(
            "the live ranking carries no provenance.graph_edge_schema — it was "
            "built from an unstamped graph, i.e. by an older pipeline than the "
            "one deployed"
        )
    joined = provenance.get("crashes_joined")
    if joined == 0:
        problems.append(
            "the graph behind the live ranking joined 0 bike crashes, so the "
            "crash criterion is resting on nothing"
        )

    # 4. A criterion that is empty for every single project. This is the cheap,
    #    high-signal check that would have caught the 2026-08-10 publish on the
    #    day it happened: an entire column of nulls is never a real measurement.
    total = len(features)
    for field, label in (
        ("crashes", "bike crash counts"),
        ("dest_unlocked", "destinations in reach"),
        ("pop_gaining", "residents gaining access"),
    ):
        present = sum(1 for f in features if (f.get("properties") or {}).get(field) is not None)
        if present == 0:
            problems.append(
                f"{label} ({field}) is null on all {total} live projects — a whole "
                "criterion is being published with nothing behind it"
            )

    # 5. And the sentences must not claim what the fields don't carry.
    claims_crashes = sum(
        1
        for f in features
        if "crash" in str((f.get("properties") or {}).get("summary", ""))
        and (f.get("properties") or {}).get("crashes") is None
    )
    if claims_crashes:
        problems.append(
            f"{claims_crashes} of {total} live projects mention crashes in their "
            "summary while carrying no crash count"
        )

    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=DEFAULT_BASE, help="site root to check")
    parser.add_argument(
        "--max-age-days",
        type=float,
        default=10.0,
        help="how stale the live data may be (the refresh is weekly)",
    )
    args = parser.parse_args()

    problems = check(args.base, args.max_age_days)
    if not problems:
        print(f"live data at {args.base} looks current and complete")
        return 0
    print(f"::error::live data at {args.base} has {len(problems)} problem(s)")
    for problem in problems:
        print(f"  - {problem}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
