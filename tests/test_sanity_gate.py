"""The gate between a fresh build and the site: publish nothing much smaller.

Every data failure this project has had was quiet — a partial download, a layer
that never arrived, a join that matched nothing — and each one built, exported
and published cleanly. These tests feed the gate the shapes those failures take.
"""

import json
from pathlib import Path
from typing import Any

import pytest
import sanity_gate


def meta(
    edges: int = 900_000, lts: int = 250_000, permits: int = 150, **extra: Any
) -> dict[str, Any]:
    sources = [
        {"name": "massdot_lts", "features": lts},
        {"name": "crashes_2025", "features": 800},
        {"name": "cambridge_permits", "features": permits},
    ]
    return {
        "built": "2026-09-21",
        "graph": {"nodes": 360_000, "edges": edges, "crashes_joined": 3_990},
        "sources": sources,
        **extra,
    }


def test_the_same_snapshot_passes() -> None:
    assert sanity_gate.compare(meta(), meta()) == []


def test_a_graph_that_lost_a_quarter_of_its_edges_is_stopped() -> None:
    problems = sanity_gate.compare(meta(), meta(edges=650_000))
    assert len(problems) == 1 and "graph edges" in problems[0] and "28% fewer" in problems[0]


def test_a_small_drop_is_ordinary_weekly_churn() -> None:
    assert sanity_gate.compare(meta(), meta(edges=880_000)) == []


def test_a_source_that_shrank_or_vanished_is_stopped() -> None:
    assert sanity_gate.compare(meta(), meta(lts=997))  # a truncated download
    gone = meta()
    gone["sources"] = [s for s in gone["sources"] if s["name"] != "crashes_2025"]
    (problem,) = sanity_gate.compare(meta(), gone)
    assert "crashes_2025" in problem and "missing" in problem


def test_construction_is_allowed_to_come_and_go() -> None:
    assert sanity_gate.compare(meta(permits=150), meta(permits=3)) == []


def test_a_first_snapshot_without_graph_stats_is_compared_on_what_it_has() -> None:
    old = meta()
    del old["graph"]
    assert sanity_gate.compare(old, meta()) == []


def _run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, published: dict[str, Any] | Exception,
    new: dict[str, Any],
) -> int:
    path = tmp_path / "meta.json"
    path.write_text(json.dumps(new))

    def fetch(_url: str) -> dict[str, Any]:
        if isinstance(published, Exception):
            raise published
        return published

    monkeypatch.setattr(sanity_gate, "fetch_published", fetch)
    return sanity_gate.main(["sanity_gate.py", str(path)])


def test_main_refuses_a_drop_unless_told_to_publish_anyway(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv(sanity_gate.OVERRIDE_ENV, raising=False)
    assert _run(tmp_path, monkeypatch, meta(), meta(edges=100)) == 1
    assert "refusing to publish" in capsys.readouterr().out
    monkeypatch.setenv(sanity_gate.OVERRIDE_ENV, "1")
    assert _run(tmp_path, monkeypatch, meta(), meta(edges=100)) == 0
    assert "publishing anyway" in capsys.readouterr().out


def test_main_will_not_publish_blind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(sanity_gate.OVERRIDE_ENV, raising=False)
    assert _run(tmp_path, monkeypatch, OSError("site down"), meta()) == 1
    assert _run(tmp_path, monkeypatch, meta(), meta()) == 0
