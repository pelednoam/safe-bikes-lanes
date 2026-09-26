"""Decide the app version an APK build carries, for GITHUB_OUTPUT.

A tag build is its tag: app-v53 -> version "app-v53", versionCode 53.

Any other build (Run workflow on a branch) used to carry github.ref_name —
"main" — which build.gradle turned into versionCode 1. Android refuses to
install versionCode 1 over app-v52 without uninstalling first (losing the
rides and saved places), and the in-app updater could not parse "main", so it
never offered the next release either. A trap on both ends.

So a non-tag build is named for the newest release it follows, plus its
commit: "app-v52-dev.1a2b3c4", with versionCode 52 — the same as app-v52's.
Android installs an equal versionCode over the installed app, so it goes on
over the release a tester already has, and app-v53 (versionCode 53) goes on
over it in turn; the updater reads the base release and offers app-v53 when
it is out. The name says "dev" everywhere it is shown.

Prints `app_version=...` and `version_code=...` lines.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

TAG = re.compile(r"^app-v(\d+)$")


def newest_release(tags: list[str]) -> int | None:
    numbers = [int(m.group(1)) for t in tags if (m := TAG.match(t))]
    return max(numbers) if numbers else None


def decide(ref: str, ref_name: str, sha: str, tags: list[str]) -> tuple[str, int]:
    if ref.startswith("refs/tags/"):
        m = TAG.match(ref_name)
        if m is None:
            # A release must never go out as versionCode 1.
            raise SystemExit(f"tag {ref_name!r} is not app-vN; refusing to build a release from it")
        return ref_name, int(m.group(1))
    base = newest_release(tags)
    if base is None:
        raise SystemExit("no app-vN tag found to base a development build on")
    if not re.fullmatch(r"[0-9a-f]{7,40}", sha):
        raise SystemExit(f"not a commit sha: {sha!r}")
    return f"app-v{base}-dev.{sha[:7]}", base


def remote_tags() -> list[str]:
    out = subprocess.run(
        ["git", "ls-remote", "--tags", "--refs", "origin", "refs/tags/app-v*"],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    ).stdout
    return [line.split("refs/tags/", 1)[1] for line in out.splitlines() if "refs/tags/" in line]


def main() -> None:
    ref = os.environ["GITHUB_REF"]
    tags = [] if ref.startswith("refs/tags/") else remote_tags()
    version, code = decide(ref, os.environ["GITHUB_REF_NAME"], os.environ["GITHUB_SHA"], tags)
    print(f"app_version={version}")
    print(f"version_code={code}")
    print(f"{version} -> versionCode {code}", file=sys.stderr)


if __name__ == "__main__":
    main()
