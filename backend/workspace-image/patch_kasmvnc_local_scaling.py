#!/usr/bin/env python3
"""Patch the base webtop image's `kclient` EJS template so its embedded
KasmVNC iframe uses LOCAL client-side scaling instead of remote server
resize — NOT anything in this repo's own code otherwise. Same established
pattern as `patch_kasmvnc_hide_control_bar.py`/`patch_kasmvnc_lastactiveat.py`
(byte-for-byte match, fail-closed, patched at image build time): see
those scripts' own module docs for the full rationale.

## MUST run AFTER patch_kasmvnc_hide_control_bar.py in the Dockerfile

Both scripts patch the exact same iframe `src=` line in
`/kclient/public/index.html` — this script's `OLD_LINE` is deliberately
the control-bar patch's own `NEW_LINE` (i.e. the ALREADY-patched state,
`show_control_bar=` already emptied), not the pristine base-image
original. Running this script first (or the control-bar patch not having
run at all) will make this script's own occurrence-count check fail
closed with 0 matches — that is the correct, intended failure mode if
the Dockerfile's ordering is ever changed, not a bug to work around by
loosening this script's own match.

## The problem (real, requested tradeoff)

`resize=remote` (KasmVNC's default noVNC resize mode) makes the SERVER
render at whatever resolution the connecting client's viewport reports,
so opening this desktop on e.g. a 2K/4K monitor makes the real Xvnc
server jump to a correspondingly huge internal resolution — directly
undoing this image's own fixed, deliberately small
`-geometry 1024x576 -FrameRate 15` resource-efficiency profile (see
`patch_kasmvnc_resource_efficiency.py`), since that server-side geometry
is no longer actually fixed once a client connects.

`resize=scale` (the alternative built into KasmVNC/noVNC) keeps the
SERVER's rendered resolution genuinely fixed at whatever `-geometry` was
launched with, and instead scales that fixed-size image up/down
CLIENT-side to fit the viewer's window — real, accepted tradeoff: the
desktop can look visually soft/blurry when stretched across a much
larger viewer window, in exchange for the server's own actual memory/CPU
footprint never growing past the fixed profile regardless of what
monitor or window size a human happens to view it from.

## Fail-closed by design

Same discipline as every other patch script in this file: if the base
image (or `patch_kasmvnc_hide_control_bar.py`'s own output) ever changes
this exact line, the string this script searches for will no longer
match byte-for-byte, and this script exits non-zero — failing the Docker
build loudly rather than silently keeping `resize=remote` while looking
like the fix was applied.
"""

import sys

TARGET_FILE = "/kclient/public/index.html"

# The ALREADY-control-bar-patched state of this line (see this script's
# own module doc for why) — byte-for-byte match, deliberately the full
# iframe src attribute rather than just the one query param, so a
# partial/coincidental match elsewhere in the file cannot trigger a
# false-positive replacement.
OLD_LINE = (
    '    <iframe class="vnc" src="vnc/index.html?autoconnect=1&resize=remote'
    '&clipboard_up=true&clipboard_down=true&clipboard_seamless=true'
    '&show_control_bar=<% if(path){ %><%- path -%><% } %>"></iframe>'
)

NEW_LINE = (
    '    <iframe class="vnc" src="vnc/index.html?autoconnect=1&resize=scale'
    '&clipboard_up=true&clipboard_down=true&clipboard_seamless=true'
    '&show_control_bar=<% if(path){ %><%- path -%><% } %>"></iframe>'
)


def main() -> int:
    with open(TARGET_FILE, "r", encoding="utf-8") as f:
        content = f.read()

    occurrences = content.count(OLD_LINE)
    if occurrences != 1:
        print(
            f"local-scaling patch FAILED: expected exactly 1 occurrence of the "
            f"known (already control-bar-patched) iframe line in {TARGET_FILE}, "
            f"found {occurrences}. Either the base image's kclient template has "
            f"changed since this patch was written, or the Dockerfile's patch "
            f"ORDER changed (this script must run AFTER "
            f"patch_kasmvnc_hide_control_bar.py — see this script's own module "
            f"doc) -- re-verify the real current template, re-derive the exact "
            f"line to match, and update this script before rebuilding.",
            file=sys.stderr,
        )
        return 1

    patched = content.replace(OLD_LINE, NEW_LINE)
    with open(TARGET_FILE, "w", encoding="utf-8") as f:
        f.write(patched)

    print(f"local-scaling patch applied to {TARGET_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
