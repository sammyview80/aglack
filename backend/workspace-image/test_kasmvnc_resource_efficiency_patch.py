"""Static-content + patch-logic regression test for
`patch_kasmvnc_resource_efficiency.py` — same convention as
`test_kasmvnc_hide_control_bar_patch.py` (no `docker build`, imports the
real script as a module rather than re-declaring its constants, proves
Dockerfile wiring + fail-closed behavior + a real fixture round-trip).

Run directly:

    python3 backend/workspace-image/test_kasmvnc_resource_efficiency_patch.py

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
PATCH_SCRIPT = WORKSPACE_IMAGE_DIR / "patch_kasmvnc_resource_efficiency.py"


def _dockerfile_text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def _load_patch_module():
    spec = importlib.util.spec_from_file_location(
        "patch_kasmvnc_resource_efficiency", PATCH_SCRIPT
    )
    assert spec and spec.loader, f"could not load spec for {PATCH_SCRIPT}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_dockerfile_copies_and_runs_the_patch_script() -> None:
    text = _dockerfile_text()
    assert (
        "COPY backend/workspace-image/patch_kasmvnc_resource_efficiency.py "
        "/tmp/patch_kasmvnc_resource_efficiency.py" in text
    ), "Dockerfile must COPY patch_kasmvnc_resource_efficiency.py into the build, or it never runs."
    assert "RUN python3 /tmp/patch_kasmvnc_resource_efficiency.py" in text, (
        "Dockerfile must RUN patch_kasmvnc_resource_efficiency.py during the build — "
        "copying it alone does nothing."
    )


def test_patch_rewrites_geometry_and_framerate_without_depth() -> None:
    """Proves the real script's own OLD_BLOCK/NEW_BLOCK round-trip against
    a fixture matching the exact svc-kasmvnc run script confirmed live in
    a running container (see the patch script's own module doc)."""
    module = _load_patch_module()

    fixture = f"""#!/usr/bin/with-contenv bash

if ls /dev/dri/renderD* 1> /dev/null 2>&1 && [ -z ${{DISABLE_DRI+x}} ] && ! which nvidia-smi; then
  HW3D="-hw3d"
fi
if [ -z ${{DRINODE+x}} ]; then
  DRINODE="/dev/dri/renderD128"
fi

exec s6-setuidgid abc \\
  /usr/local/bin/Xvnc $DISPLAY \\
    ${{HW3D}} \\
    -PublicIP 127.0.0.1 \\
    -drinode ${{DRINODE}} \\
    -disableBasicAuth \\
{module.OLD_BLOCK}    -RectThreads 0 \\
    -websocketPort 6901 \\
    -interface 0.0.0.0 \\
    -Log *:stdout:10
"""

    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "run"
        target.write_text(fixture, encoding="utf-8")

        original_target_file = module.TARGET_FILE
        module.TARGET_FILE = str(target)
        try:
            exit_code = module.main()
        finally:
            module.TARGET_FILE = original_target_file

        assert exit_code == 0, "patch script must exit 0 against a fixture matching the real script"
        patched = target.read_text(encoding="utf-8")
        assert "-geometry 1024x576 \\" in patched, "patched file must set the reduced geometry"
        assert "-geometry 1024x768" not in patched, "patched file must not still contain the old geometry"
        assert "-FrameRate 15 \\" in patched, "patched file must cap the frame rate at 15"
        # Regression guard: `-depth 16` made Xvnc SIGBUS on every websocket
        # client connection in a real workspace (see the patch script's
        # module doc). The profile must never add any -depth flag.
        assert "-depth" not in patched, (
            "patched file must not add a -depth flag — -depth 16 crashed Xvnc with "
            "SIGBUS on every client connection"
        )
        assert "-depth" not in module.NEW_BLOCK, "NEW_BLOCK must not reintroduce a -depth flag"
        # Every other launch flag must survive untouched — this is a
        # targeted block replacement, not a wholesale script rewrite.
        assert "-PublicIP 127.0.0.1" in patched
        assert "-disableBasicAuth" in patched
        assert "-sslOnly 0" in patched
        assert "-RectThreads 0" in patched
        assert "-websocketPort 6901" in patched
        assert "-interface 0.0.0.0" in patched
        assert "${HW3D}" in patched
        assert "${DRINODE}" in patched


def test_patch_fails_closed_when_target_block_is_missing() -> None:
    """The whole point of the fail-closed design: if the base image's
    launch script ever changes this block, the script must exit non-zero
    and change NOTHING, not silently no-op while a build appears to
    succeed."""
    module = _load_patch_module()

    fixture = "#!/usr/bin/with-contenv bash\nexec s6-setuidgid abc /usr/local/bin/Xvnc $DISPLAY\n"

    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "run"
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
