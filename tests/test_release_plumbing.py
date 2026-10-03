"""The parts of a release that are shell and Gradle rather than Python.

Every one of these guards a mistake that has actually happened here: a version
code pinned at 1 for fifty releases, an environment variable set for one step and
not the one that needed it, and a build stamp whose whole purpose is defeated if
the substitution silently doesn't happen.

None of it runs in a unit test otherwise — it runs once, in CI, on a tag.
"""

from __future__ import annotations

import importlib.util
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
REFRESH_WORKFLOW = ROOT / ".github" / "workflows" / "refresh-data.yml"
PUBLISH = ROOT / "scripts" / "publish-data.sh"


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
    all_steps = steps(APK_WORKFLOW)
    version = [s for s in all_steps if s.get("id") == "version"]
    assert version and "app_version.py" in str(version[0].get("run", "")), (
        "the version is no longer decided by .github/scripts/app_version.py"
    )
    gradle_steps = [s for s in all_steps if "gradlew" in str(s.get("run", ""))]
    assert gradle_steps, "no Gradle step in the APK workflow"
    for step in gradle_steps:
        env = step.get("env") or {}
        assert "APP_VERSION" in env, (
            f"the step {step.get('name')!r} runs Gradle without APP_VERSION — "
            "versionCode would silently be 1"
        )
        # Not github.ref_name: on a Run-workflow build that is "main", which is
        # versionCode 1 and a version string the updater cannot read.
        assert "steps.version.outputs.app_version" in str(env["APP_VERSION"]), (
            "APP_VERSION is not the decided version"
        )
        # a release build: debug is debuggable, and debuggable means WebView
        # remote debugging into the app's storage
        assert "assembleRelease" in str(step["run"]), "the APK is not a release build"
        assert "assembleDebug" not in str(step["run"])


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
                 ["refs/tags/app-v50", 1], ["app-v52-dev.1a2b3c4", 52],
                 ["app-v52-dev.", 1], ["app-v52-dev.XYZ1234", 1], ["main", 1]]
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


def test_the_build_stamp_is_baked_in_and_the_build_fails_if_it_is_not() -> None:
    """The stamp says which build a page is. A silent miss makes it say nothing.

    It is filled in by the build (vite.config.ts `define`), not substituted into
    app.js with sed afterwards. The sed version escaped JSON badly once, app.js
    stopped parsing, and every check passed because the placeholder was indeed
    gone. Nine native tests failed before anything said why. Now the build fails
    on a placeholder left behind (scripts/check-dist.mjs), and both producers
    publish build.json from the same build.
    """
    placeholders = ("__BUILD_VERSION__", "__BUILD_TIME__", "__BUILD_COMMIT__")
    web = ROOT / "web"
    # the stamp lives in the about module, and it only counts if the app loads that
    # module and starts it: removing either leaves a build that shows no stamp
    entry = (web / "src" / "app.ts").read_text(encoding="utf-8")
    source = (web / "src" / "app" / "app-info.ts").read_text(encoding="utf-8")
    assert 'from "./app/app-info.js"' in entry, "app.ts no longer loads the stamp's module"
    assert "initAppInfo();" in entry, "app.ts no longer starts the stamp's module"
    config = (web / "vite.config.ts").read_text(encoding="utf-8")
    check = (web / "scripts" / "check-dist.mjs").read_text(encoding="utf-8")
    for placeholder in placeholders:
        assert placeholder in source, f"the app no longer carries {placeholder}"
        assert f"{placeholder}:" in config, f"vite.config.ts does not define {placeholder}"
    assert "__BUILD_(VERSION|TIME|COMMIT)__" in check, "check-dist misses a leftover stamp"
    build = '"build": "npm run vendor && vite build && node scripts/check-dist.mjs"'
    package = (web / "package.json").read_text(encoding="utf-8")
    assert build in package, "npm run build no longer checks what it built"

    for producer in (ASSEMBLE, PAGES_WORKFLOW):
        text = producer.read_text(encoding="utf-8")
        assert "build.json" in text, f"{producer.name} does not publish build.json"
        assert "APP_VERSION" in text, f"{producer.name} doesn't say which build this is"
        assert "sed -i" not in text, f"{producer.name} is editing the built code again"
    assert "npm run build" in ASSEMBLE.read_text(encoding="utf-8")


def test_the_app_reads_its_own_stamp_before_the_servers() -> None:
    """Baked, not fetched — the distinction is the whole point.

    A cached page asking the server which build is current gets the server's
    answer, which is right about the site and wrong about the page in front of
    the reader. That is exactly the case this exists for.
    """
    source = (ROOT / "web" / "src" / "app" / "app-info.ts").read_text(encoding="utf-8")
    stamp = source.index("const BUILD_COMMIT")
    fetched = source.index('fetch("build.json"')
    assert stamp < fetched, "the stamp must come from the bundle, not from the network"
    # the fetched copy is only for comparison, and must not be cached itself
    window = source[fetched : fetched + 200]
    assert 'cache: "no-store"' in window, (
        "the live build.json is fetched from cache, so a stale page would compare "
        "itself against an equally stale answer and report agreement"
    )


def test_the_weekly_refresh_publishes_through_the_checked_script() -> None:
    """Its last step tarred web/data and ran `gh release upload` itself, so the
    checks in publish-data.sh — no ranking resting on zero joined crashes, no
    unstamped graph — guarded only local publishes, and CI published
    whatever it had built."""
    runs = [str(step.get("run", "")) for step in steps(REFRESH_WORKFLOW)]
    assert not any("gh release upload" in r for r in runs), (
        "the refresh uploads the snapshot itself again, around publish-data.sh"
    )
    assert any("scripts/publish-data.sh" in r for r in runs)


def test_publishing_runs_the_sanity_gate_before_uploading() -> None:
    text = PUBLISH.read_text(encoding="utf-8")
    gate = text.index("pipeline/sanity_gate.py")
    assert gate < text.index("gh release upload"), "the gate must run before the upload"
    assert "exit 1" in text[gate : gate + 200], "a failed gate must stop the publish"


def test_a_failed_fetch_fails_the_refresh() -> None:
    """fetch.py exited 0 however many sources failed; the step must be the
    script whose exit status says so, not something that swallows it."""
    runs = [str(step.get("run", "")) for step in steps(REFRESH_WORKFLOW)]
    fetch_runs = [r for r in runs if "fetch.py" in r]
    assert fetch_runs, "the refresh no longer fetches"
    for r in fetch_runs:
        assert "|| true" not in r and "continue-on-error" not in r


def test_the_refresh_installs_exact_hashed_versions() -> None:
    """`pip install osmnx geopandas ...` took whatever was newest, in a job that
    publishes the site's data."""
    installs = [
        str(step.get("run", ""))
        for step in steps(REFRESH_WORKFLOW)
        if "pip install" in str(step.get("run", ""))
    ]
    assert installs, "the refresh no longer installs its dependencies"
    for run in installs:
        assert "--require-hashes" in run and "pipeline/requirements.txt" in run, run
    lock = (ROOT / "pipeline" / "requirements.txt").read_text(encoding="utf-8")
    pins = [ln for ln in lock.splitlines() if ln and not ln.startswith((" ", "#"))]
    assert pins and all("==" in p for p in pins), "every requirement pinned exactly"
    assert lock.count("--hash=sha256:") >= len(pins)
    for pkg in ("osmnx", "geopandas", "networkx", "shapely", "scipy", "pillow"):
        assert any(p.startswith(f"{pkg}==") for p in pins), f"{pkg} is not in the lock"


def test_the_refresh_does_not_leave_its_token_on_disk() -> None:
    """With the default persist-credentials, checkout writes the job's token —
    which can publish releases here — into .git/config for every later step,
    installed packages included."""
    checkouts = [s for s in steps(REFRESH_WORKFLOW) if "actions/checkout" in str(s.get("uses"))]
    assert checkouts
    for step in checkouts:
        assert (step.get("with") or {}).get("persist-credentials") is False
    with_token = [s for s in steps(REFRESH_WORKFLOW) if "GH_TOKEN" in (s.get("env") or {})]
    # Only the two steps that write releases hold a token: the publish, and the
    # source archive after it. The archive's is one standard-library-only
    # Python call, isolated from the installed packages like the publish's own.
    archive = "python3 -I -S pipeline/source_archive.py upload data/raw"
    assert [s.get("run") for s in with_token] == ["scripts/publish-data.sh", archive], (
        "only the publish and archive steps should hold a token"
    )
    # and that step's own Python does not load the installed packages' .pth hooks
    publish = PUBLISH.read_text(encoding="utf-8")
    starts = ("python3", "if ! python3")
    calls = [ln for ln in publish.splitlines() if ln.lstrip().startswith(starts)]
    assert calls and all("-I -S" in ln for ln in calls), calls


def _app_version() -> Any:
    spec = importlib.util.spec_from_file_location(
        "app_version", ROOT / ".github" / "scripts" / "app_version.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_tag_build_is_its_tag() -> None:
    decide = _app_version().decide
    assert decide("refs/tags/app-v53", "app-v53", "1a2b3c4d5e", []) == ("app-v53", 53)
    # a release must never go out as versionCode 1
    with pytest.raises(SystemExit):
        decide("refs/tags/app-vX", "app-vX", "1a2b3c4d5e", [])


def test_a_run_workflow_build_follows_the_newest_release() -> None:
    """It was "main", versionCode 1: it could not install over app-v52, and the
    updater could not parse "main" to offer app-v53. A trap on both ends."""
    decide = _app_version().decide
    tags = ["app-v9", "app-v52", "app-v48", "data-snapshot", "app-v52-rc", "v60"]
    version, code = decide("refs/heads/main", "main", "1a2b3c4d5e6f7", tags)
    assert (version, code) == ("app-v52-dev.1a2b3c4", 52)
    # nothing to follow is an error, not a quiet versionCode 1
    with pytest.raises(SystemExit):
        decide("refs/heads/main", "main", "1a2b3c4d5e6f7", ["data-snapshot"])


def test_the_dev_version_is_one_gradle_and_the_updater_both_read() -> None:
    """Three readers of one string: build.gradle's versionCode, the in-app
    updater's comparison, and a person reading the About box."""
    version, code = _app_version().decide("refs/heads/x", "x", "abcdef1234", ["app-v52"])
    gradle = GRADLE.read_text(encoding="utf-8")
    pattern = re.search(r"tag =~ /(.+?)/\)", gradle)
    assert pattern is not None, "releaseCode's pattern moved"
    match = re.match(pattern.group(1), version)
    assert match is not None and int(match.group(1)) == code
    native = (ROOT / "web" / "src" / "native.ts").read_text(encoding="utf-8")
    assert "-dev" in native, "the updater does not read development versions"
