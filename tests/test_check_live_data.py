"""The check that watches the deployed site.

It exists because every other check in the repo runs on data the job it belongs to
just built, which cannot see a snapshot replaced after the fact. On 2026-08-10 a
manual publish overwrote CI's build with one made from a stale graph, and the site
served a ranking whose crash criterion rested on a derived proxy for a week with
every workflow green.

So these tests are about the failures it has to notice, not about its plumbing.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check-live-data.py"
_spec = importlib.util.spec_from_file_location("check_live_data", SCRIPT)
assert _spec is not None and _spec.loader is not None
check_live_data = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_live_data)


def make_project(**overrides: Any) -> dict[str, Any]:
    props: dict[str, Any] = {
        "pid": "c1",
        "name": "Broadway",
        "crashes": 3,
        "dest_unlocked": 5,
        "pop_gaining": 210.0,
        "summary": "0.2 mi of Broadway — connects 4.0 mi of kid-safe streets",
    }
    props.update(overrides)
    return {"type": "Feature", "properties": props}


def serve(
    monkeypatch: pytest.MonkeyPatch,
    *,
    meta: dict[str, Any] | None = None,
    prio_meta: dict[str, Any] | None = None,
    projects: list[dict[str, Any]] | None = None,
    missing: tuple[str, ...] = (),
) -> None:
    """Stand in for the deployed files, without a network."""
    today = check_live_data.dt.datetime.now(check_live_data.dt.UTC).strftime("%Y-%m-%d")
    bodies = {
        "data/meta.json": meta if meta is not None else {"built": today, "format": 3},
        "data/priorities_meta.json": (
            prio_meta
            if prio_meta is not None
            else {
                "provenance": {
                    "graph_edge_schema": ["cls", "crash_count", "length"],
                    "crashes_joined": 4037,
                }
            }
        ),
        "data/priorities.geojson": {
            "features": projects if projects is not None else [make_project()]
        },
    }

    def fake_fetch(url: str) -> Any:
        for name, body in bodies.items():
            if url.endswith(name):
                if name in missing:
                    raise OSError(f"404 {name}")
                return body
        raise OSError(f"unexpected url {url}")

    monkeypatch.setattr(check_live_data, "fetch_json", fake_fetch)
    monkeypatch.setattr(check_live_data, "expected_format", lambda: 3)


def test_a_healthy_site_reports_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    serve(monkeypatch)
    assert check_live_data.check("https://example.test", 10.0) == []


def test_a_whole_criterion_of_nulls_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """The check that would have caught 2026-08-10 on the day.

    An entire column of nulls is never a real measurement — it is a stale graph,
    a failed fetch, or a renamed upstream field.
    """
    serve(monkeypatch, projects=[make_project(crashes=None), make_project(crashes=None)])
    problems = check_live_data.check("https://example.test", 10.0)
    assert any("crashes" in p and "all 2 live projects" in p for p in problems)


def test_one_missing_value_among_many_is_not_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """A gap in the data is normal; a criterion with nothing behind it is not."""
    serve(monkeypatch, projects=[make_project(crashes=None), make_project(crashes=2)])
    problems = check_live_data.check("https://example.test", 10.0)
    assert not any("crashes" in p for p in problems)


def test_a_sentence_claiming_crashes_without_a_count_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The exact live symptom: 805 of 1,500 said "recorded bike crashes nearby"
    while carrying no count."""
    serve(
        monkeypatch,
        projects=[
            make_project(summary="…; recorded bike crashes nearby", crashes=None),
            make_project(crashes=4),
        ],
    )
    problems = check_live_data.check("https://example.test", 10.0)
    assert any("mention crashes in their summary" in p for p in problems)


def test_stale_data_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """A refresh that stops running looks exactly like one that changes nothing.

    GitHub also disables scheduled workflows after 60 days of repository
    inactivity, which is a silent stop by design.
    """
    serve(monkeypatch, meta={"built": "2020-01-01", "format": 3})
    problems = check_live_data.check("https://example.test", 10.0)
    assert any("days old" in p for p in problems)


def test_fresh_data_within_the_window_is_not_called_stale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recent = (
        check_live_data.dt.datetime.now(check_live_data.dt.UTC)
        - check_live_data.dt.timedelta(days=6)
    ).strftime("%Y-%m-%d")
    serve(monkeypatch, meta={"built": recent, "format": 3})
    assert not any("days old" in p for p in check_live_data.check("https://example.test", 10.0))


def test_a_format_mismatch_with_the_deployed_code_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    today = check_live_data.dt.datetime.now(check_live_data.dt.UTC).strftime("%Y-%m-%d")
    serve(monkeypatch, meta={"built": today, "format": 2})
    problems = check_live_data.check("https://example.test", 10.0)
    assert any("format" in p for p in problems)


def test_an_unstamped_snapshot_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """No provenance means it came from a pipeline older than the guard, which is
    how the stale graph got published in the first place."""
    serve(monkeypatch, prio_meta={"provenance": {}})
    problems = check_live_data.check("https://example.test", 10.0)
    assert any("graph_edge_schema" in p for p in problems)


def test_zero_joined_crashes_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """0 joined crashes and "no street here had a crash" are different claims, and
    only one of them is a measurement."""
    serve(
        monkeypatch,
        prio_meta={"provenance": {"graph_edge_schema": ["crash_count"], "crashes_joined": 0}},
    )
    problems = check_live_data.check("https://example.test", 10.0)
    assert any("joined 0 bike crashes" in p for p in problems)


def test_an_unreachable_site_is_reported_not_swallowed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    serve(monkeypatch, missing=("data/meta.json",))
    problems = check_live_data.check("https://example.test", 10.0)
    assert len(problems) == 1
    assert "not readable" in problems[0]


def test_a_build_with_no_ranking_is_allowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The app hides the section when there is no ranking, so its absence is a
    legitimate build rather than a fault."""
    serve(monkeypatch, missing=("data/priorities.geojson", "data/priorities_meta.json"))
    assert check_live_data.check("https://example.test", 10.0) == []


def test_an_empty_ranking_is_not(monkeypatch: pytest.MonkeyPatch) -> None:
    """A file that exists and holds nothing is a broken build, not an absent one."""
    serve(monkeypatch, projects=[])
    problems = check_live_data.check("https://example.test", 10.0)
    assert any("no candidates" in p for p in problems)


def test_the_expected_format_is_read_from_the_pipeline_config() -> None:
    """Read by text so this can run without the pipeline's dependencies — which
    means it has to actually find the number."""
    root = Path(__file__).resolve().parents[1]
    found = check_live_data.expected_format(str(root / "pipeline" / "config.py"))
    assert isinstance(found, int)
    text = (root / "pipeline" / "config.py").read_text(encoding="utf-8")
    line = next(line for line in text.splitlines() if line.startswith("DATA_FORMAT"))
    assert str(found) in line


def test_days_old_handles_the_stamps_the_pipeline_writes() -> None:
    assert check_live_data.days_old("2020-01-01") is not None
    assert check_live_data.days_old("2020-01-01T12:00:00+00:00") is not None
    assert check_live_data.days_old("not a date") is None


def test_main_exits_nonzero_when_the_live_data_is_wrong(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(check_live_data.sys, "argv", ["check-live-data.py"])
    monkeypatch.setattr(check_live_data, "check", lambda *_: ["something is wrong"])
    assert check_live_data.main() == 1
    out = capsys.readouterr().out
    assert "::error::" in out
    assert "something is wrong" in out

    monkeypatch.setattr(check_live_data, "check", lambda *_: [])
    assert check_live_data.main() == 0
    assert "current and complete" in capsys.readouterr().out


def test_the_reporter_and_the_checker_agree_about_the_report_path() -> None:
    """The workflow tees the check into a file the reporter reads. Two names in two
    files, and nothing would fail if they drifted apart."""
    root = Path(__file__).resolve().parents[1]
    workflow = (root / ".github" / "workflows" / "health.yml").read_text(encoding="utf-8")
    reporter = (root / "scripts" / "report-live-health.sh").read_text(encoding="utf-8")
    assert "/tmp/health.txt" in workflow
    assert "/tmp/health.txt" in reporter
    # and the reporter is the step the workflow actually runs
    assert "scripts/report-live-health.sh" in workflow


def test_the_publish_gate_reads_the_field_the_pipeline_writes() -> None:
    """publish-data.sh refuses a snapshot whose meta lacks provenance. It greps a
    JSON key by name, so a rename in the pipeline would silently disable it."""
    root = Path(__file__).resolve().parents[1]
    gate = (root / "scripts" / "publish-data.sh").read_text(encoding="utf-8")
    pipeline = (root / "pipeline" / "priorities.py").read_text(encoding="utf-8")
    for key in ("graph_edge_schema", "crashes_joined"):
        assert key in gate, f"the publish gate no longer checks {key}"
        assert f'"{key}"' in pipeline, f"the pipeline no longer writes {key}"
    assert json.dumps({"provenance": {}})  # the shape the gate expects, for the reader
