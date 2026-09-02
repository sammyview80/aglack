"""Static-content + patch-logic regression test for
`patch_kasmvnc_hide_lsbar.py` — no `docker build` involved (same
constraint `test_dockerfile_seeder_content.py` documents: none of this
repo's automated test runs have a `docker` binary available). Mirrors
`test_kasmvnc_hide_control_bar_patch.py`'s own structure exactly — see
that file's module doc for the general approach this follows.

Run directly:

    python3 backend/workspace-image/test_kasmvnc_hide_lsbar_patch.py

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
PATCH_SCRIPT = WORKSPACE_IMAGE_DIR / "patch_kasmvnc_hide_lsbar.py"


def _dockerfile_text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def _load_patch_module():
    """Import the real script as a module (not a copy-pasted re-declaration
    of its constants) so this test fails the moment OLD_BLOCK/NEW_BLOCK
    actually drift, not just when someone remembers to update a second
    copy."""
    spec = importlib.util.spec_from_file_location("patch_kasmvnc_hide_lsbar", PATCH_SCRIPT)
    assert spec and spec.loader, f"could not load spec for {PATCH_SCRIPT}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_dockerfile_copies_and_runs_the_patch_script() -> None:
    text = _dockerfile_text()
    assert (
        "COPY backend/workspace-image/patch_kasmvnc_hide_lsbar.py "
        "/tmp/patch_kasmvnc_hide_lsbar.py" in text
    ), "Dockerfile must COPY patch_kasmvnc_hide_lsbar.py into the build, or it never runs."
    assert "RUN python3 /tmp/patch_kasmvnc_hide_lsbar.py" in text, (
        "Dockerfile must RUN patch_kasmvnc_hide_lsbar.py during the build — "
        "copying it alone does nothing."
    )


def test_dockerfile_runs_lsbar_patch_after_control_bar_patch() -> None:
    """Order doesn't functionally matter here (the two patches touch
    different files), but keeping the lsbar patch's Dockerfile block
    directly after the control-bar patch's block (both operating on the
    same `kclient` shell) is the documented, reviewable ordering — this
    guards against someone splitting them apart across unrelated
    Dockerfile sections in a future edit."""
    text = _dockerfile_text()
    control_bar_run_idx = text.index("RUN python3 /tmp/patch_kasmvnc_hide_control_bar.py")
    lsbar_run_idx = text.index("RUN python3 /tmp/patch_kasmvnc_hide_lsbar.py")
    assert control_bar_run_idx < lsbar_run_idx


def test_patch_makes_control_open_case_a_noop() -> None:
    """Proves the real script's own OLD_BLOCK/NEW_BLOCK round-trip against
    a fixture matching the exact `control_open` case block confirmed live
    against the built image (see the patch script's own module doc)."""
    module = _load_patch_module()

    fixture = f"""// Parse messages from KasmVNC
var eventMethod = window.addEventListener ? "addEventListener" : "attachEvent";
var eventer = window[eventMethod];
var messageEvent = eventMethod == "attachEvent" ? "onmessage" : "message";
eventer(messageEvent,function(e) {{
  if (event.data && event.data.action) {{
    switch (event.data.action) {{
{module.OLD_BLOCK}
      case 'control_close':
        closeToggle('#lsbar');
        break;
      case 'fullscreen':
        fullscreen();
        break;
    }}
  }}
}},false);
"""

    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "kclient.js"
        target.write_text(fixture, encoding="utf-8")

        original_target_file = module.TARGET_FILE
        module.TARGET_FILE = str(target)
        try:
            exit_code = module.main()
        finally:
            module.TARGET_FILE = original_target_file

        assert exit_code == 0, "patch script must exit 0 against a fixture matching the real script"
        patched = target.read_text(encoding="utf-8")
        assert "openToggle('#lsbar')" not in patched, (
            "patched file must no longer call openToggle('#lsbar') from the "
            "control_open case"
        )
        assert "case 'control_open':" in patched, "the control_open case label itself must survive"
        # The OTHER cases must be completely untouched — this is a
        # targeted single-case body edit, not a wholesale rewrite that
        # could silently break control_close or fullscreen.
        assert "case 'control_close':" in patched
        assert "closeToggle('#lsbar');" in patched
        assert "case 'fullscreen':" in patched
        assert "fullscreen();" in patched


def test_patch_fails_closed_when_target_block_is_missing() -> None:
    """The whole point of the fail-closed design: if the base image's
    script ever changes this block, the script must exit non-zero and
    change NOTHING, not silently no-op while a build appears to
    succeed."""
    module = _load_patch_module()

    fixture = "// some unrelated script content\nfunction foo() {}\n"

    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "kclient.js"
        target.write_text(fixture, encoding="utf-8")

        original_target_file = module.TARGET_FILE
        module.TARGET_FILE = str(target)
        try:
            exit_code = module.main()
        finally:
            module.TARGET_FILE = original_target_file

        assert exit_code != 0, "patch script must fail closed when the expected block is not found"
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
