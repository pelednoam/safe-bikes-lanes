"""Tests for stamp_version: a data snapshot's version is what it contains."""

import datetime
import json
from pathlib import Path

import stamp_version


def _snapshot(root: Path) -> Path:
    data = root / "data"
    (data / "tiles").mkdir(parents=True)
    (data / "meta.json").write_text(json.dumps({"built": "2026-09-26", "format": 3}))
    (data / "tiles" / "1_1.json").write_text('{"edges": []}')
    (data / "pois.geojson").write_text('{"features": []}')
    (data / "keys.json").write_text('{"mapillary": "a"}')
    return data


def test_the_same_data_gets_the_same_version_however_often_it_is_stamped(
    tmp_path: Path,
) -> None:
    """Re-stamping rewrites meta.json, and a same-content rebuild must not look
    new: that would make every phone download a snapshot it already has."""
    data = _snapshot(tmp_path)
    first = stamp_version.stamp(data)["version"]
    second = stamp_version.stamp(data)["version"]
    assert first == second
    assert len(first) == 16


def test_any_change_to_the_data_changes_the_version(tmp_path: Path) -> None:
    data = _snapshot(tmp_path)
    before = stamp_version.content_version(data)
    (data / "tiles" / "1_1.json").write_text('{"edges": [1]}')
    assert stamp_version.content_version(data) != before
    # and a renamed file, same bytes, is different data
    changed = stamp_version.content_version(data)
    (data / "tiles" / "1_1.json").rename(data / "tiles" / "1_2.json")
    assert stamp_version.content_version(data) != changed


def test_the_hand_kept_keys_are_not_part_of_the_data(tmp_path: Path) -> None:
    """keys.json is config the tarball leaves out; a new token is not new data."""
    data = _snapshot(tmp_path)
    before = stamp_version.content_version(data)
    (data / "keys.json").write_text('{"mapillary": "b"}')
    assert stamp_version.content_version(data) == before


def test_the_stamp_keeps_what_meta_json_already_said(tmp_path: Path) -> None:
    data = _snapshot(tmp_path)
    when = datetime.datetime(2026, 9, 26, 22, 9, 24, 123456, tzinfo=datetime.UTC)
    stamp_version.stamp(data, now=when)
    meta = json.loads((data / "meta.json").read_text())
    assert meta["built"] == "2026-09-26" and meta["format"] == 3
    assert meta["builtAt"] == "2026-09-26T22:09:24+00:00"
