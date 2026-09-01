"""Static-content regression test for `Dockerfile`'s seeder/seeder_kit COPY
lines — no `docker build` involved (none of this repo's automated test
runs have a `docker` binary available), just asserting the exact
static-analysis-catchable regression that caused a real live bug: a
container built without these lines has no `agent_seeder`/`agent_config`
native routes at all, so requests to those endpoints fall through to the
proxied catch-all and hit upstream's own CSRF check, producing the
misleading "Cross-origin mismatch - check reverse proxy headers" error for
a request that was never supposed to go anywhere near that code path.

Run directly (no repo test runner wires this in yet — it has no natural
home in `wrapper/tests/` since this Dockerfile isn't owned by that
package, and no `seeder`/`seeder_kit` package installs `pytest` either):

    python3 backend/workspace-image/test_dockerfile_seeder_content.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

DOCKERFILE = Path(__file__).parent / "Dockerfile"


def _dockerfile_text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def test_copies_seeder_kit_before_wrapper_install() -> None:
    text = _dockerfile_text()
    assert "COPY backend/seeder_kit /opt/hermes-webui/seeder_kit" in text, (
        "Dockerfile must COPY backend/seeder_kit — the wrapper's "
        "'seeder-kit' dependency (see wrapper/pyproject.toml) is installed "
        "from this sibling checkout, not PyPI."
    )
    copy_idx = text.index("COPY backend/seeder_kit /opt/hermes-webui/seeder_kit")
    install_idx = text.index("uv pip install --python /opt/hermes/.venv/bin/python -e /opt/hermes-webui/wrapper")
    assert copy_idx < install_idx, (
        "backend/seeder_kit must be COPY'd BEFORE the wrapper's `uv pip install -e` "
        "step runs, or the seeder-kit dependency path won't exist yet."
    )


def test_installs_seeder_kit_as_its_own_step_before_wrapper() -> None:
    """`uv pip install -e <dir>` (non-project/non-workspace mode) cannot
    resolve a RELATIVE `file://../seeder_kit` URL declared inside a
    package's own pyproject.toml metadata — confirmed live, reproduced in
    a disposable container, fails even with a correct cwd. The fix is a
    SEPARATE, EARLIER `uv pip install -e .../seeder_kit` step so
    `seeder-kit` is already a real installed package by the time the
    wrapper's own install resolves its plain-name (no `file://` URL)
    dependency on it."""
    text = _dockerfile_text()
    seeder_kit_install = "uv pip install --python /opt/hermes/.venv/bin/python -e /opt/hermes-webui/seeder_kit"
    wrapper_install = "uv pip install --python /opt/hermes/.venv/bin/python -e /opt/hermes-webui/wrapper"
    assert seeder_kit_install in text, (
        "Dockerfile must install seeder_kit as its own explicit step — "
        "installing the wrapper alone is not enough; its pyproject.toml "
        "depends on the plain name 'seeder-kit', not a file:// URL, so "
        "nothing resolves it unless this step runs first."
    )
    assert text.index(seeder_kit_install) < text.index(wrapper_install), (
        "seeder_kit must be installed BEFORE the wrapper, or the wrapper's "
        "dependency resolution fails needing a 'seeder-kit' package that "
        "doesn't exist in the venv yet."
    )


def test_wrapper_pyproject_does_not_use_relative_file_url_for_seeder_kit() -> None:
    """Regression guard for the exact bug this whole chain traces back to:
    `seeder-kit @ file://../seeder_kit` in wrapper/pyproject.toml breaks
    `uv pip install -e` in Docker (relative file:// URL, no working
    directory to resolve against) — confirmed live. Must stay a plain
    name; the sibling checkout gets installed as its own explicit step
    (see test_installs_seeder_kit_as_its_own_step_before_wrapper above)."""
    pyproject_text = (Path(__file__).parent.parent / "wrapper" / "pyproject.toml").read_text(
        encoding="utf-8"
    )
    # Check the actual `dependencies = [...]` list, not the whole file —
    # the surrounding comment explaining THIS fix legitimately mentions
    # the old broken `file://../seeder_kit` pattern as prose, which a
    # naive whole-file substring check would misflag as still declared.
    deps_match = re.search(r"dependencies\s*=\s*\[(.*?)\]", pyproject_text, re.S)
    assert deps_match, "could not find a dependencies = [...] list in wrapper/pyproject.toml"
    deps_block = deps_match.group(1)
    dependency_lines = [
        line.split("#", 1)[0].strip()
        for line in deps_block.splitlines()
        if line.split("#", 1)[0].strip()
    ]
    assert not any("file://../seeder_kit" in line for line in dependency_lines), (
        "wrapper/pyproject.toml's dependencies list must not declare seeder-kit "
        "as a relative file:// URL — `uv pip install -e <dir>` cannot resolve "
        "it (confirmed live: 'relative path without a working directory')."
    )
    assert any(line == '"seeder-kit",' for line in dependency_lines), (
        "wrapper/pyproject.toml's dependencies list must contain the plain "
        "'seeder-kit' entry (satisfied by installing it as its own separate "
        "step first — see Dockerfile), not a file:// URL of any kind."
    )


def test_copies_seeder_content_tree() -> None:
    text = _dockerfile_text()
    assert "COPY backend/seeder /opt/hermes-webui/seeder" in text, (
        "Dockerfile must COPY backend/seeder — "
        "features/agent_seeder/service.py's _default_seeder_root() resolves "
        "<wrapper-root>/../seeder at RUNTIME; without this COPY the directory "
        "doesn't exist in the built image at all, so every seed-apply call "
        "finds zero agents (or, on an image built before agent-seeder existed, "
        "the request falls through to the proxied catch-all entirely)."
    )


def test_seeder_dirs_are_siblings_of_wrapper_in_final_layout() -> None:
    """`/opt/hermes-webui/{upstream,seeder_kit,seeder,wrapper}` must all be
    COPY'd to the SAME parent directory — the wrapper's own path arithmetic
    (`Path(__file__).resolve().parents[4].parent / "seeder"`) assumes this
    exact sibling layout, matching how upstream/wrapper already relate."""
    text = _dockerfile_text()
    destinations = dict(
        re.findall(r"COPY backend/(\S+) (/opt/hermes-webui/\S+)", text)
    )
    assert destinations.get("upstream") == "/opt/hermes-webui/upstream"
    assert destinations.get("seeder_kit") == "/opt/hermes-webui/seeder_kit"
    assert destinations.get("seeder") == "/opt/hermes-webui/seeder"
    assert destinations.get("wrapper") == "/opt/hermes-webui/wrapper"
    parents = {Path(dest).parent for dest in destinations.values()}
    assert parents == {Path("/opt/hermes-webui")}, (
        f"expected every COPY destination to share the parent /opt/hermes-webui, "
        f"got distinct parents: {parents}"
    )


def _run_all() -> int:
    failures = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run_all() else 0)
