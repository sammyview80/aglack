"""Static-content regression test for the default IceWM wallpaper baked
into `Dockerfile` — no `docker build` involved (same constraint
`test_dockerfile_seeder_content.py` documents). Asserts the wallpaper
asset exists, is copied into the image, and lands in
`/etc/icewm/prefoverride` — NOT `/usr/share/icewm/preferences` — which
matters because IceWM's own config precedence
(`PrivConfDir=/config/.icewm` > `CFGDIR=/etc/icewm` >
`LIBDIR=/usr/share/icewm`, confirmed live via `icewm --directories`
inside a built container) means writing to the wrong file either gets
silently overridden by a workspace's own per-user config, or by
whatever IceWM theme is active.

Run directly:

    python3 backend/workspace-image/test_dockerfile_wallpaper.py

Or via pytest:

    python3 -m pytest backend/workspace-image
"""
from __future__ import annotations

import sys
from pathlib import Path

WORKSPACE_IMAGE_DIR = Path(__file__).parent
DOCKERFILE = WORKSPACE_IMAGE_DIR / "Dockerfile"
WALLPAPER_ASSET = WORKSPACE_IMAGE_DIR / "assets" / "wallpaper.png"


def _dockerfile_text() -> str:
    return DOCKERFILE.read_text(encoding="utf-8")


def test_wallpaper_asset_exists_in_repo() -> None:
    assert WALLPAPER_ASSET.is_file(), (
        f"{WALLPAPER_ASSET} must exist — the Dockerfile COPYs this exact "
        f"path into the image; a missing file fails the build, not silently "
        f"skips the wallpaper."
    )
    # A real PNG, not an empty/placeholder file — first 8 bytes are the
    # fixed PNG signature (0x89 P N G \r \n 0x1a \n).
    with WALLPAPER_ASSET.open("rb") as f:
        signature = f.read(8)
    assert signature == b"\x89PNG\r\n\x1a\n", (
        f"{WALLPAPER_ASSET} does not start with the PNG file signature — "
        f"not a real PNG (or corrupted)."
    )


def test_dockerfile_copies_wallpaper_asset() -> None:
    text = _dockerfile_text()
    assert (
        "COPY backend/workspace-image/assets/wallpaper.png "
        "/usr/share/backgrounds/hermes-wallpaper.png" in text
    ), "Dockerfile must COPY the wallpaper asset into the image."


def test_dockerfile_writes_prefoverride_not_bare_preferences() -> None:
    """The whole point of using `prefoverride`: it is the ONLY IceWM config
    file guaranteed to win over both a selected theme's own background
    setting and (for NEW workspaces with no prior /config/.icewm of their
    own) the base image's bundled `/usr/share/icewm/preferences`
    defaults. Writing to `/usr/share/icewm/preferences` instead would be
    silently overridden by any theme that sets its own wallpaper."""
    text = _dockerfile_text()
    assert "/etc/icewm/prefoverride" in text, (
        "Dockerfile must write the wallpaper config to /etc/icewm/prefoverride "
        "— see this test's own module doc for why /usr/share/icewm/preferences "
        "is the wrong file (theme prefs are read AFTER it and can override it)."
    )


def test_dockerfile_prefoverride_sets_the_three_required_keys() -> None:
    text = _dockerfile_text()
    assert 'DesktopBackgroundImage="/usr/share/backgrounds/hermes-wallpaper.png"' in text
    assert "DesktopBackgroundScaled=1" in text
    assert "DesktopBackgroundCenter=0" in text


def test_dockerfile_wallpaper_block_runs_before_final_asset_copies() -> None:
    """Not load-bearing for correctness (this block doesn't depend on
    /opt/hermes or /opt/hermes-webui existing), but keeps it grouped with
    the other KasmVNC/kclient patches immediately above it rather than
    scattered — a reviewer reading top-to-bottom sees all base-image
    customizations together."""
    text = _dockerfile_text()
    wallpaper_idx = text.index("COPY backend/workspace-image/assets/wallpaper.png")
    hermes_copy_idx = text.index("COPY --from=builder /opt/hermes /opt/hermes")
    assert wallpaper_idx < hermes_copy_idx


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
