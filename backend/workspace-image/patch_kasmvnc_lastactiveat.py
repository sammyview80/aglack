#!/usr/bin/env python3
"""Patch a real, confirmed bug in the base webtop image's bundled KasmVNC
client (kasmtech/noVNC v1.3.0's dist/main.bundle.js) — NOT anything in this
repo's own code. See ../../CHECKPOINT.md's "KasmVNC lastActiveAt crash"
section for the full research trail; summary below.

## The bug (confirmed live, three independent ways)

1. A real browser session hitting a real workspace's desktop showed:
   "Uncaught TypeError: Cannot read properties of undefined (reading
   'lastActiveAt')" at dist/main.bundle.js — reproduced on more than one
   freshly-launched workspace.
2. Read the exact source inside a live container
   (/usr/share/kasmvnc/www/dist/main.bundle.js): a `setInterval` (fired
   every 5s, for a keep-alive) reads `UI.rfb.lastActiveAt` and calls
   `UI.rfb.sendKey(...)` with NO guard on `UI.rfb` being defined —
   `UI.rfb` is set to `undefined` on disconnect elsewhere in the same
   file. If the interval's own tick fires in that window, it throws.
3. Confirmed the package version (`app/package.json`:
   "@kasmtech/novnc" "1.3.0") and fetched the REAL upstream source at
   that exact tag from https://github.com/kasmtech/noVNC — byte-for-byte
   identical to what's running, confirming no local drift. Bisected
   upstream's history between v1.3.0 and current master: commit
   402c0c59d62424ff110bad8f14682deec7d4c780 ("Bugfix/vnc 377 fix unclean
   disconnect reconnect", PR #201, merged 2026-07-16) rewrites this exact
   mechanism with a guarded, decoupled `kasmSessionLastActiveAt` variable
   — this fix is UNRELEASED: no tag newer than v1.3.0 exists as of this
   writing (kasmtech/noVNC's own tags list confirms v1.3.0 is latest).

## Why a surgical patch here, not porting the full upstream commit

Upstream's real fix (402c0c59d6) is 185+ lines across app/ui.js,
core/rfb.js, and index.html — it also adds bounded auto-reconnect retries,
VDI-specific reconnect-without-reload behavior, and new user-facing
settings (Reconnect Retries). None of that is needed to fix the crash;
porting it wholesale would be a much larger, harder-to-verify change for
a bug whose actual defect is "one unguarded property read." This patches
only that: wraps the interval body in `if (UI.rfb) { ... }`, matching the
minimal shape upstream's OWN earlier, smaller attempt at this bug class
used (commit 6a8e7349b1, "fix idle disconnect") before the full rewrite
landed. If kasmtech ever tags a release containing 402c0c59d6, delete
this patch step and bump BASE_IMAGE instead — see the Dockerfile's own
comment above where this script is invoked.

## Why dist/main.bundle.js, not app/ui.js

app/ui.js is the original (unminified but webpack-bundled-from) source;
dist/main.bundle.js is the actual pre-built artifact the browser loads
(confirmed: the real crash's stack trace names main.bundle.js, and the
base image ships no node_modules/webpack/npm to rebuild dist/ from
app/ui.js at build time — confirmed live, `which npm webpack` finds
nothing in a running container). Patching app/ui.js alone would change
nothing a browser ever executes.

## Fail-closed by design

If the base image ever changes this exact code (a KasmVNC version bump,
or kasmtech shipping the real fix and this patch becoming redundant/
conflicting), the string this script searches for will no longer match
byte-for-byte, and this script exits non-zero — failing the Docker build
loudly rather than silently leaving the old, broken code in place while
looking like the fix was applied. See the Dockerfile comment for why a
failed build here is the correct signal for "someone must re-check this
patch," not something to catch and ignore.
"""

import sys

TARGET_FILE = "/usr/share/kasmvnc/www/dist/main.bundle.js"

# Byte-for-byte match of the real, currently-shipped v1.3.0 code (verified
# against a real running container — see this file's own module doc).
# Deliberately includes the full setInterval callback body, not just the
# unguarded line, so a partial/coincidental match elsewhere in the bundle
# cannot trigger a false-positive replacement.
OLD_BLOCK = """      UI._sessionTimeoutInterval = setInterval(function () {
        var timeSinceLastActivityInS = (Date.now() - UI.rfb.lastActiveAt) / 1000;
        var idleDisconnectInS = 1200; //20 minute default 

        if (Number.isFinite(parseFloat(UI.rfb.idleDisconnect))) {
          idleDisconnectInS = parseFloat(UI.rfb.idleDisconnect) * 60;
        }

        if (timeSinceLastActivityInS > idleDisconnectInS) {
          parent.postMessage({
            action: 'idle_session_timeout',
            value: 'Idle session timeout exceeded'
          }, '*');
        } else {
          //send keep-alive
          UI.rfb.sendKey(1, null, false);
        }
      }, 5000);"""

# The fix: every UI.rfb access moved inside a single `if (UI.rfb)` guard —
# the whole callback becomes a no-op tick (skip, try again in 5s) once
# UI.rfb has been cleared by a disconnect, instead of throwing. This is
# the smallest change that removes the unguarded read; it does not
# attempt to port upstream's decoupled kasmSessionLastActiveAt variable
# (see module doc for why that fuller rewrite is out of scope here).
NEW_BLOCK = """      UI._sessionTimeoutInterval = setInterval(function () {
        if (!UI.rfb) {
          return;
        }

        var timeSinceLastActivityInS = (Date.now() - UI.rfb.lastActiveAt) / 1000;
        var idleDisconnectInS = 1200; //20 minute default 

        if (Number.isFinite(parseFloat(UI.rfb.idleDisconnect))) {
          idleDisconnectInS = parseFloat(UI.rfb.idleDisconnect) * 60;
        }

        if (timeSinceLastActivityInS > idleDisconnectInS) {
          parent.postMessage({
            action: 'idle_session_timeout',
            value: 'Idle session timeout exceeded'
          }, '*');
        } else {
          //send keep-alive
          UI.rfb.sendKey(1, null, false);
        }
      }, 5000);"""


def main() -> int:
    with open(TARGET_FILE, "r", encoding="utf-8") as f:
        content = f.read()

    occurrences = content.count(OLD_BLOCK)
    if occurrences != 1:
        print(
            f"lastActiveAt patch FAILED: expected exactly 1 occurrence of the "
            f"known-bad block in {TARGET_FILE}, found {occurrences}. The base "
            f"image's KasmVNC bundle has changed since this patch was written "
            f"(see this script's own module doc) -- re-verify the crash still "
            f"exists, re-derive the exact block to match, and update this "
            f"script before rebuilding.",
            file=sys.stderr,
        )
        return 1

    patched = content.replace(OLD_BLOCK, NEW_BLOCK)
    with open(TARGET_FILE, "w", encoding="utf-8") as f:
        f.write(patched)

    print(f"lastActiveAt patch applied to {TARGET_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
