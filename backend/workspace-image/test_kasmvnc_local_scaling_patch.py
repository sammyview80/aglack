"""Static-content + patch-logic regression test for
`patch_kasmvnc_local_scaling.py` — same convention as
`test_kasmvnc_hide_control_bar_patch.py` (no `docker build`, imports the
real script as a module rather than re-declaring its constants, proves
Dockerfile wiring + fail-closed behavior + a real fixture round-trip).

Run directly:

    python3 backend/workspace-image/test_kasmvnc_local_scaling_patch.py

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
PATCH_SCRIPT = WORKSPACE_IMAGE_DIR / "patch_kasmvnc_local_scaling.py"


def _dockerfile_text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def _load_patch_module():
    spec = importlib.util.spec_from_file_location("patch_kasmvnc_local_scaling", PATCH_SCRIPT)
    assert spec and spec.loader, f"could not load spec for {PATCH_SCRIPT}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_dockerfile_copies_and_runs_the_patch_script() -> None:
    text = _dockerfile_text()
    assert (
        "COPY backend/workspace-image/patch_kasmvnc_local_scaling.py "
        "/tmp/patch_kasmvnc_local_scaling.py" in text
    ), "Dockerfile must COPY patch_kasmvnc_local_scaling.py into the build, or it never runs."
    assert "RUN python3 /tmp/patch_kasmvnc_local_scaling.py" in text, (
        "Dockerfile must RUN patch_kasmvnc_local_scaling.py during the build — "
        "copying it alone does nothing."
    )


def test_dockerfile_runs_this_patch_after_the_control_bar_patch() -> None:
    """Both scripts patch the SAME iframe line in the same file — this
    one's OLD_LINE is deliberately the control-bar patch's own already-
    patched output (see this patch's own module doc). Running out of
    order would make this script's fail-closed check trip on every real
    build."""
    text = _dockerfile_text()
    control_bar_run_idx = text.index("RUN python3 /tmp/patch_kasmvnc_hide_control_bar.py")
    local_scaling_run_idx = text.index("RUN python3 /tmp/patch_kasmvnc_local_scaling.py")
    assert control_bar_run_idx < local_scaling_run_idx, (
        "patch_kasmvnc_local_scaling.py must run AFTER patch_kasmvnc_hide_control_bar.py"
    )


def test_patch_rewrites_resize_remote_to_scale() -> None:
    """Proves the real script's own OLD_LINE/NEW_LINE round-trip against a
    fixture matching the exact template state AFTER
    patch_kasmvnc_hide_control_bar.py has already run (its own OLD_LINE
    is that patch's NEW_LINE — see this patch's module doc)."""
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
        assert "resize=scale" in patched, "patched file must set resize=scale"
        assert "resize=remote" not in patched, "patched file must not still contain resize=remote"
        # Every other query param on the same iframe src must survive
        # untouched — this is a targeted single-param flip, not a
        # wholesale line rewrite that could silently drop something else.
        assert "autoconnect=1" in patched
        assert "clipboard_up=true" in patched
        assert "clipboard_down=true" in patched
        assert "clipboard_seamless=true" in patched
        assert "show_control_bar=<%" in patched, (
            "the control-bar patch's own already-emptied show_control_bar value "
            "must survive this patch untouched"
        )
        assert '<% if(path){ %><%- path -%><% } %>' in patched


def test_patch_fails_closed_when_target_line_is_missing() -> None:
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


def test_patch_fails_closed_against_the_unpatched_pristine_template() -> None:
    """Adversarial ordering check: if the control-bar patch's OWN OLD_LINE
    (still `show_control_bar=true`) is what this script sees (e.g. the
    control-bar patch was skipped/failed silently), this script must
    ALSO fail closed, not partially match and produce a nonsensical
    `resize=scale` + `show_control_bar=true` combination."""
    module = _load_patch_module()

    pristine_line = (
        '    <iframe class="vnc" src="vnc/index.html?autoconnect=1&resize=remote'
        '&clipboard_up=true&clipboard_down=true&clipboard_seamless=true'
        '&show_control_bar=true<% if(path){ %><%- path -%><% } %>"></iframe>'
    )
    fixture = f"<html><body>{pristine_line}</body></html>"

    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "index.html"
        target.write_text(fixture, encoding="utf-8")

        original_target_file = module.TARGET_FILE
        module.TARGET_FILE = str(target)
        try:
            exit_code = module.main()
        finally:
            module.TARGET_FILE = original_target_file

        assert exit_code != 0, (
            "patch script must fail closed against the PRISTINE (not yet "
            "control-bar-patched) template, not partially match"
        )
        assert target.read_text(encoding="utf-8") == fixture


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
