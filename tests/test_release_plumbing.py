"""The parts of a release that are shell and Gradle rather than Python.

Every one of these guards a mistake that has actually happened here: a version
code pinned at 1 for fifty releases, an environment variable set for one step and
not the one that needed it, and a build stamp whose whole purpose is defeated if
the substitution silently doesn't happen.

None of it runs in a unit test otherwise — it runs once, in CI, on a tag.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
GRADLE = ROOT / "web" / "android" / "app" / "build.gradle"
APK_WORKFLOW = ROOT / ".github" / "workflows" / "android-apk.yml"
PAGES_WORKFLOW = ROOT / ".github" / "workflows" / "pages.yml"
ASSEMBLE = ROOT / "web" / "scripts" / "assemble.sh"


def steps(workflow: Path) -> list[dict[str, Any]]:
    data = yaml.safe_load(workflow.read_text(encoding="utf-8"))
    return [step for job in data["jobs"].values() for step in job["steps"]]


def test_the_version_code_is_derived_from_the_tag() -> None:
    """It was `versionCode 1` from app-v1 to app-v50.

    Installs still worked, because the stable signing key lets one APK replace
    another and the in-app updater compares the tag string. But Android itself
    could not tell a newer build from an older one: a downgrade looked exactly
    like an upgrade to everything that reasons about version codes.
    """
    text = GRADLE.read_text(encoding="utf-8")
    line = next(ln for ln in text.splitlines() if ln.strip().startswith("versionCode"))
    assert not re.match(r"^\s*versionCode\s+\d+\s*$", line), (
        f"versionCode is a literal again: {line.strip()!r}"
    )
    assert "APP_VERSION" in line, "versionCode no longer reads the release tag"
    assert "releaseCode" in line, "versionCode no longer uses the tested rule"
    name = next(ln for ln in text.splitlines() if ln.strip().startswith("versionName"))
    assert "APP_VERSION" in name, "versionName is not the tag either"


def test_the_apk_build_step_is_given_the_tag() -> None:
    """The half that is easy to forget, and silent when forgotten.

    build.gradle can read APP_VERSION all it likes; if the step that runs Gradle
    doesn't set it, every APK is versionCode 1 again and nothing about the build
    looks wrong. The tag was set on the bundle step and not on this one.
    """
    gradle_steps = [
        s for s in steps(APK_WORKFLOW) if "gradlew" in str(s.get("run", ""))
    ]
    assert gradle_steps, "no Gradle step in the APK workflow"
    for step in gradle_steps:
        env = step.get("env") or {}
        assert "APP_VERSION" in env, (
            f"the step {step.get('name')!r} runs Gradle without APP_VERSION — "
            "versionCode would silently be 1"
        )
        assert "ref_name" in str(env["APP_VERSION"]), (
            "APP_VERSION is not the tag; github.ref_name is what carries app-vNN"
        )


@pytest.mark.skipif(shutil.which("java") is None, reason="no JVM to run Groovy with")
def test_the_version_code_expression_survives_a_malformed_tag() -> None:
    """Run the real expression, not a Python re-implementation of it.

    A build file that throws on an unexpected tag fails the release at the last
    step, after everything else has passed.
    """
    dists = Path.home() / ".gradle" / "wrapper" / "dists"
    jars = sorted(dists.glob("**/lib/groovy-3*.jar")) if dists.exists() else []
    if not jars:
        pytest.skip("no Groovy jar from a Gradle distribution available")
    lib = jars[0].parent

    # The rule itself, lifted verbatim from build.gradle — a re-implementation
    # here would only prove that two copies of my reasoning agree.
    text = GRADLE.read_text(encoding="utf-8")
    start = text.index("def releaseCode")
    end = text.index("\n}", start) + 2
    rule = text[start:end]
    script = f"""
    {rule}
    def cases = [["app-v50", 50], ["app-v7", 7], ["app-v123", 123], ["", 1],
                 ["dev", 1], ["app-vX", 1], ["v50", 1], ["app-v50-rc1", 1],
                 ["refs/tags/app-v50", 1]]
    def bad = cases.findAll {{ releaseCode(it[0]) != it[1] }}
    println(bad.isEmpty() ? "ALL OK" : "MISMATCH " + bad)
    """
    result = subprocess.run(
        [
            "java",
            "-cp",
            ":".join(str(p) for p in lib.glob("groovy*.jar")),
            "groovy.ui.GroovyMain",
            "-e",
            script,
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    assert result.returncode == 0, f"the expression does not evaluate: {result.stderr[:400]}"
    assert "ALL OK" in result.stdout, result.stdout.strip()[:400]


def test_the_build_stamp_is_substituted_and_the_build_fails_if_it_is_not() -> None:
    """The stamp says which build a page is. A silent miss makes it say nothing.

    Both producers replace the placeholder and then check their own work, because
    "About says development build" is a symptom nobody would report and everybody
    would ignore.
    """
    placeholders = ("__BUILD_VERSION__", "__BUILD_TIME__", "__BUILD_COMMIT__")
    source = (ROOT / "web" / "src" / "app.ts").read_text(encoding="utf-8")
    for placeholder in placeholders:
        assert placeholder in source, f"the app no longer carries {placeholder}"

    for producer in (ASSEMBLE, PAGES_WORKFLOW):
        text = producer.read_text(encoding="utf-8")
        for placeholder in placeholders:
            assert placeholder in text, f"{producer.name} does not substitute {placeholder}"
        assert "build.json" in text, f"{producer.name} does not publish build.json"
        # It verifies the substitution rather than hoping...
        assert "grep -q" in text, (
            f"{producer.name} substitutes the stamp without checking it worked"
        )
        # ...and that what replaced it is still JavaScript. The first version
        # embedded JSON in a string literal; sed ate the backslashes, app.js
        # stopped parsing, and every check passed because the placeholder was
        # indeed gone. Nine native tests failed before anything said why.
        assert "node --check" in text, (
            f"{producer.name} does not check that app.js still parses after the "
            "substitution — the check that would have caught the escaping bug"
        )


def test_the_app_reads_its_own_stamp_before_the_servers() -> None:
    """Baked, not fetched — the distinction is the whole point.

    A cached page asking the server which build is current gets the server's
    answer, which is right about the site and wrong about the page in front of
    the reader. That is exactly the case this exists for.
    """
    source = (ROOT / "web" / "src" / "app.ts").read_text(encoding="utf-8")
    stamp = source.index("const BUILD_COMMIT")
    fetched = source.index('fetch("build.json"')
    assert stamp < fetched, "the stamp must come from the bundle, not from the network"
    # the fetched copy is only for comparison, and must not be cached itself
    window = source[fetched : fetched + 200]
    assert 'cache: "no-store"' in window, (
        "the live build.json is fetched from cache, so a stale page would compare "
        "itself against an equally stale answer and report agreement"
    )
