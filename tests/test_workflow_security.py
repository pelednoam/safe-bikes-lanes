"""What the build and deploy workflows are allowed to run, and with which token.

A `uses: owner/action@v4` runs whatever commit that tag points at today, and a
tag can be moved. These workflows hold a contents:write token, the APK signing
key and the Pages deploy token, so each action is pinned to a commit instead,
with its version in a comment for people and for Dependabot.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
# refresh-data.yml is pinned separately; these are the three this covers.
PINNED = ["android-apk.yml", "pages.yml", "health.yml"]


def load(name: str) -> dict[str, Any]:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def all_steps(name: str) -> list[dict[str, Any]]:
    return [step for job in load(name)["jobs"].values() for step in job.get("steps", [])]


@pytest.mark.parametrize("name", PINNED)
def test_every_action_is_pinned_to_a_commit(name: str) -> None:
    text = (WORKFLOWS / name).read_text(encoding="utf-8")
    uses = re.findall(r"^\s*(?:- )?uses:\s*(.+)$", text, flags=re.M)
    assert uses, f"{name} uses no actions?"
    for ref in uses:
        assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*", ref.strip()), (
            f"{name}: {ref.strip()!r} is not pinned to a full commit SHA with its version"
        )


@pytest.mark.parametrize("name", PINNED)
def test_checkouts_leave_no_token_behind(name: str) -> None:
    """None of these push. A persisted token in the checkout's git config is
    readable by every npm package and build script that runs after it."""
    for step in all_steps(name):
        if "actions/checkout@" in str(step.get("uses", "")):
            assert (step.get("with") or {}).get("persist-credentials") is False, (
                f"{name}: a checkout keeps its credentials"
            )


def test_dependabot_keeps_the_pins_moving() -> None:
    config = yaml.safe_load((ROOT / ".github" / "dependabot.yml").read_text(encoding="utf-8"))
    ecosystems = {u["package-ecosystem"]: u for u in config["updates"]}
    assert "github-actions" in ecosystems, "nothing updates the pinned action SHAs"
    assert ecosystems["npm"]["directory"] == "/web"
    # the web app's lockfile is where Dependabot has to look
    assert (ROOT / "web" / "package-lock.json").exists()
