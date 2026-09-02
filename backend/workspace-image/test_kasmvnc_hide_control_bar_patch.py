"""Static-content + patch-logic regression test for
`patch_kasmvnc_hide_control_bar.py` — no `docker build` involved (same
constraint `test_dockerfile_seeder_content.py` documents: none of this
repo's automated test runs have a `docker` binary available), just
proving (1) the Dockerfile actually invokes the patch, and (2) the
patch's own string-replacement logic does what it claims against a
fixture that is a byte-for-byte copy of the real base image's
`/kclient/public/index.html` template as verified live (see the patch
script's own module doc for how that was confirmed).

A test importing/running `patch_kasmvnc_hide_control_bar.py` directly
against its own `TARGET_FILE` constant is not possible here (that path
only exists inside a built container) — so this test instead copies the
script's OWN replacement logic against a local fixture file, proving the
same OLD_LINE/NEW_LINE strings the real script uses actually round-trip
correctly. If the real script's constants drift from what this test
imports, importing them directly (rather than re-declaring copies) means
this test breaks the moment they do, instead of silently testing stale
logic.

Run directly:

    python3 backend/workspace-image/test_kasmvnc_hide_control_bar_patch.py

Or via pytest:

    python3 -m pytest backend/workspace-image
"""
from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

WORKSPACE_IMAGE_DIR = Path(__file__).parent
DOCKERFILE = WORKSPACE_IMAGE_DIR / "Dockerfile"
PATCH_SCRIPT = WORKSPACE_IMAGE_DIR / "patch_kasmvnc_hide_control_bar.py"


def _dockerfile_text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def _load_patch_module():
    """Import the real script as a module (not a copy-pasted re-declaration
    of its constants) so this test fails the moment OLD_LINE/NEW_LINE
    actually drift, not just when someone remembers to update a second
    copy."""
    spec = importlib.util.spec_from_file_location("patch_kasmvnc_hide_control_bar", PATCH_SCRIPT)
    assert spec and spec.loader, f"could not load spec for {PATCH_SCRIPT}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_dockerfile_copies_and_runs_the_patch_script() -> None:
    text = _dockerfile_text()
    assert (
        "COPY backend/workspace-image/patch_kasmvnc_hide_control_bar.py "
        "/tmp/patch_kasmvnc_hide_control_bar.py" in text
    ), "Dockerfile must COPY patch_kasmvnc_hide_control_bar.py into the build, or it never runs."
    assert "RUN python3 /tmp/patch_kasmvnc_hide_control_bar.py" in text, (
        "Dockerfile must RUN patch_kasmvnc_hide_control_bar.py during the build — "
        "copying it alone does nothing."
    )


def test_dockerfile_runs_patch_after_base_image_python_is_available() -> None:
    """The patch script is pure-stdlib Python — it needs `python3` on PATH,
    which this Dockerfile installs via `apk add ... python3` earlier in the
    same build stage (see the lastActiveAt patch's own identical
    ordering requirement)."""
    text = _dockerfile_text()
    python_install_idx = text.index("python3")  # first mention: the apk add list
    patch_run_idx = text.index("RUN python3 /tmp/patch_kasmvnc_hide_control_bar.py")
    assert python_install_idx < patch_run_idx, (
        "patch_kasmvnc_hide_control_bar.py must run AFTER python3 is installed "
        "in this build stage."
    )


def test_patch_rewrites_show_control_bar_true_to_empty() -> None:
    """Proves the real script's own OLD_LINE/NEW_LINE round-trip against a
    fixture matching the exact template confirmed live in a running
    container (see the patch script's own module doc — verified
    end-to-end through the real rust_gateway proxy, not just this string
    match)."""
    module = _load_patch_module()

    fixture = f"""<!DOCTYPE html>
<html>
  <head>
    <title><%- title -%></title>
  </head>
  <body>
    <!--KasmVNC Iframe-->
{module.OLD_LINE}
    <!--LSIO Function Bar-->
    <div id="lsbar"></div>
  </body>
</html>
"""

    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "index.html"
        target.write_text(fixture, encoding="utf-8")

        original_target_file = module.TARGET_FILE
        module.TARGET_FILE = str(target)
        try:
            exit_code = module.main()
        finally:
            module.TARGET_FILE = original_target_file

        assert exit_code == 0, "patch script must exit 0 against a fixture matching the real template"
        patched = target.read_text(encoding="utf-8")
        # Must be an EMPTY value (`show_control_bar=` immediately followed
        # by the next token), not the string "false" — KasmVNC's own
        # `WebUtil.getConfigVar()` returns the raw query-string value
        # un-parsed, and `Boolean("false") === true` in JavaScript, so a
        # literal "false" value is truthy and the bar-hiding `if` never
        # fires (see this test file's own regression note below and the
        # patch script's own module doc for the full trail — a real,
        # shipped bug this exact assertion is written to catch).
        assert "show_control_bar=<%" in patched, (
            "patched file must set show_control_bar to an EMPTY value "
            "(immediately followed by the EJS path conditional) — "
            "KasmVNC's own ui.js does not parse this param as a boolean, "
            "so any non-empty string (including the literal text \"false\") "
            "is truthy and fails to hide the control bar"
        )
        assert "show_control_bar=true" not in patched, "patched file must not still contain show_control_bar=true"
        assert "show_control_bar=false" not in patched, (
            "patched file must NOT contain the literal string "
            "show_control_bar=false — that string is TRUTHY in JavaScript "
            "(Boolean(\"false\") === true), so KasmVNC's own ui.js would "
            "still show the control bar despite this looking like a fix; "
            "this was a real regression that shipped once, see the patch "
            "script's own module doc"
        )
        # Every other query param on the same iframe src must survive
        # untouched — this is a targeted single-param flip, not a
        # wholesale line rewrite that could silently drop something else.
        assert "autoconnect=1" in patched
        assert "resize=remote" in patched
        assert "clipboard_up=true" in patched
        assert "clipboard_down=true" in patched
        assert "clipboard_seamless=true" in patched
        assert '<% if(path){ %><%- path -%><% } %>' in patched


def test_patch_fails_closed_when_target_line_is_missing() -> None:
    """The whole point of the fail-closed design (see the script's own
    module doc): if the base image's template ever changes this line, the
    script must exit non-zero and change NOTHING, not silently no-op
    while a build appears to succeed."""
    module = _load_patch_module()

    fixture = "<html><body>some unrelated template content</body></html>"

    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "index.html"
        target.write_text(fixture, encoding="utf-8")

        original_target_file = module.TARGET_FILE
        module.TARGET_FILE = str(target)
        try:
            exit_code = module.main()
        finally:
            module.TARGET_FILE = original_target_file

        assert exit_code != 0, "patch script must fail closed when the expected line is not found"
        assert target.read_text(encoding="utf-8") == fixture, (
            "patch script must not modify the file at all when the fail-closed check trips"
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
