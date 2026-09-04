#!/usr/bin/env python3
"""Patch the base webtop image's Xvnc launch script (`/etc/s6-overlay/
s6-rc.d/svc-kasmvnc/run`) for a real, requested resource-efficiency
profile — NOT anything in this repo's own code otherwise. Same
established pattern as `patch_kasmvnc_hide_control_bar.py`/
`patch_kasmvnc_lastactiveat.py` (byte-for-byte match, fail-closed,
patched at image build time): see those scripts' own module docs for the
full rationale of why this approach, not a runtime override.

## Why this matters

This workspace container runs on a real, constrained deployment target
(explicitly sized around 4GB total RAM) with three real consumers
competing for the same memory: the Hermes agent runtime, the KasmVNC
virtual desktop (Xvnc + its own X11 rendering), and — the newest
consumer, added this session — a real, VISIBLE (non-headless) Chromium
instance per agent (`browser_manager.py`) with its own GPU process. The
base image's own defaults (1024x768 default geometry via the `-geometry`
flag already present, but no frame-rate cap at all) were
tuned for a general-purpose desktop, not a memory-constrained,
agent-driven one.

## Real values applied, and why

- `-geometry 1024x576` (was `1024x768`): matches the requested efficiency
  profile. Deliberately NOT lower (e.g. 960x540) — many real sites switch
  to a tablet/mobile layout below roughly 1024px wide, which materially
  changes page structure and makes browser-automation selectors/flows
  less reliable; 1024 is the floor that keeps desktop-layout sites
  desktop-layout.
- `-FrameRate 15` (new): caps KasmVNC's own maximum screen-update rate.
  Lower CPU/bandwidth cost for encoding frames nobody is necessarily
  watching in real time (an agent's browser session, not a human actively
  interacting) — 15fps is smooth enough for a human to watch it live
  when they DO open the desktop tab, without paying for 30-60fps encoding
  the rest of the time.

## Deliberately NOT `-depth 16` (verified crash regression)

An earlier revision of this profile also added `-depth 16` to halve the
framebuffer's per-pixel footprint. Verified in a real running workspace:
with `-depth 16`, Xvnc crashed with SIGBUS immediately on EVERY websocket
client connection (the desktop tab never rendered). Removing only the
`-depth 16` flag and restarting Xvnc kept it stable, so the flag alone is
the cause. KasmVNC's own WebSocket/WebP encoding path assumes its default
(24/32-bit) framebuffer layout; do not re-add `-depth 16` without
re-verifying against a real client connection. The base script sets no
depth flag, so leaving it out keeps Xvnc's own built-in default.

Deliberately NOT changed here: `-hw3d`/`-drinode` GPU passthrough
detection (orthogonal to this efficiency profile — leaving the base
image's own conditional logic for whether a real GPU device is mounted
untouched), `-AlwaysShared`/`-disableBasicAuth`/`-SecurityTypes None`/the
CORS headers (pre-existing, unrelated to resource use), `-websocketPort`
(a real network-topology value the rest of this codebase already depends
on at its current value — `rust_gateway`'s desktop proxy dials 6901
directly, see `workspaces/proxy/desktop_proxy.rs`).

## Fail-closed by design

Same discipline as every other patch script in this file: if the base
image ever changes this exact script (a webtop/KasmVNC version bump),
the string this script searches for will no longer match byte-for-byte,
and this script exits non-zero — failing the Docker build loudly rather
than silently keeping the OLD (unpatched, unoptimized) launch flags
while looking like the fix was applied. Re-derive the exact block and
update this script before rebuilding.
"""

import sys

TARGET_FILE = "/etc/s6-overlay/s6-rc.d/svc-kasmvnc/run"

# Byte-for-byte match of the real, currently-shipped launch invocation
# (verified against a real running container). The `-geometry 1024x768`
# segment is the one line actually being replaced; the surrounding lines
# are included in the match so a coincidental partial match elsewhere in
# the file cannot trigger a false-positive replacement.
OLD_BLOCK = (
    "    -http-header Cross-Origin-Embedder-Policy=require-corp \\\n"
    "    -http-header Cross-Origin-Opener-Policy=same-origin \\\n"
    "    -geometry 1024x768 \\\n"
    "    -sslOnly 0 \\\n"
)

NEW_BLOCK = (
    "    -http-header Cross-Origin-Embedder-Policy=require-corp \\\n"
    "    -http-header Cross-Origin-Opener-Policy=same-origin \\\n"
    "    -geometry 1024x576 \\\n"
    "    -FrameRate 15 \\\n"
    "    -sslOnly 0 \\\n"
)


def main() -> int:
    with open(TARGET_FILE, "r", encoding="utf-8") as f:
        content = f.read()

    occurrences = content.count(OLD_BLOCK)
    if occurrences != 1:
        print(
            f"resource-efficiency patch FAILED: expected exactly 1 occurrence of "
            f"the known Xvnc launch block in {TARGET_FILE}, found {occurrences}. "
            f"The base image's svc-kasmvnc run script has changed since this "
            f"patch was written (see this script's own module doc) -- re-verify "
            f"the real current launch flags, re-derive the exact block to match, "
            f"and update this script before rebuilding.",
            file=sys.stderr,
        )
        return 1

    patched = content.replace(OLD_BLOCK, NEW_BLOCK)
    with open(TARGET_FILE, "w", encoding="utf-8") as f:
        f.write(patched)

    print(f"resource-efficiency patch applied to {TARGET_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
