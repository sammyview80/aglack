#!/usr/bin/env python3
"""Patch the base webtop image's `kclient` client script so its own
File-Manager/Enable-Audio/Enable-Microphone bar (`#lsbar`) never
auto-opens — NOT anything in this repo's own code otherwise. Companion
to `patch_kasmvnc_hide_control_bar.py`; see that script's own module doc
for the established pattern this follows (fail-closed byte match, patch
during image build, delete once the base image fixes it upstream).

## The problem (confirmed live against the built image)

`/kclient/public/index.html` — the same EJS shell
`patch_kasmvnc_hide_control_bar.py` patches — also renders a separate,
outer `#lsbar` bar (three icons: File Manager, Enable Audio, Enable
Microphone; `id="fileButton"`/`"audioButton"`/`"micButton"` in that
template). `/kclient/public/css/kclient.css` sets `#lsbar { display:
none; }` by default — it is NOT always-visible CSS-wise, and is not a
hover-triggered element either (an earlier, WRONG assumption).

The real trigger, confirmed by reading `/kclient/public/js/kclient.js`
directly: it listens for a `postMessage` from whatever frame embeds
this page, and opens `#lsbar` on `{action: 'control_open'}`:

    eventer(messageEvent, function(e) {
      if (event.data && event.data.action) {
        switch (event.data.action) {
          case 'control_open':
            openToggle('#lsbar');
            break;
          ...

KasmVNC's OWN `ui.js` — the iframe THIS shell itself embeds, not
something this repo's frontend controls — sends exactly that message
unconditionally as part of its `openControlbar()` init call (see
`patch_kasmvnc_hide_control_bar.py`'s own module doc: `openControlbar()`
already runs unguarded on every page load):

    if (WebUtil.isInsideKasmVDI()) {
        parent.postMessage({ action: 'control_open', value: '...' }, '*');
    }

`isInsideKasmVDI()` is `window.self !== window.top` — true for any
iframe embed, always true here. So `#lsbar` auto-opens on every real
connection, regardless of `show_control_bar` (that param only affects
KasmVNC's OWN bar, patched separately) and regardless of any hover
state. No query parameter or config var gates this message on the
sender side, and there is no way to intercept it from OUTSIDE this
`kclient.js` file (the message travels iframe -> its own parent
document, which is exactly `kclient.js`'s own page — not something a
frontend embedding the OUTER shell in yet another iframe can suppress).

## The fix

Make the `control_open` case a no-op — the listener still exists (so
`control_close` and `fullscreen` keep working, and nothing else in this
file that depends on the switch statement's shape breaks), it simply no
longer calls `openToggle('#lsbar')`. The bar stays permanently closed
(`display: none` from its own CSS default) since nothing ever opens it;
File Manager/Enable Audio/Enable Microphone become unreachable through
this bar as a direct consequence (there is no OTHER way to reach them in
this shell — `#lsbar`'s icons were the only entry point) rather than a
separate feature-removal decision.

## Fail-closed by design

If the base image ever changes this exact script (a webtop/kclient
version bump), the string this script searches for will no longer match
byte-for-byte, and this script exits non-zero — failing the Docker build
loudly rather than silently leaving the auto-open behavior in place
while looking like the fix was applied.
"""

import sys

TARGET_FILE = "/kclient/public/js/kclient.js"

# Byte-for-byte match of the real, currently-shipped script (verified
# against a real built image — see this file's own module doc).
# Deliberately includes the full switch-case body (case label through
# break), not just the one call, so a partial/coincidental match
# elsewhere in the file cannot trigger a false-positive replacement.
OLD_BLOCK = """      case 'control_open':
        openToggle('#lsbar');
        break;"""

# The fix: the case label and its `break` stay (so the switch statement's
# shape and the OTHER cases — control_close, fullscreen — are completely
# untouched), only the `openToggle('#lsbar')` call itself is removed.
NEW_BLOCK = """      case 'control_open':
        // Deliberately a no-op — see patch_kasmvnc_hide_lsbar.py's own
        // module doc. KasmVNC's own ui.js sends this message
        // unconditionally on every connect; #lsbar (File Manager/Enable
        // Audio/Enable Microphone) must never auto-open in response.
        break;"""


def main() -> int:
    with open(TARGET_FILE, "r", encoding="utf-8") as f:
        content = f.read()

    occurrences = content.count(OLD_BLOCK)
    if occurrences != 1:
        print(
            f"hide-lsbar patch FAILED: expected exactly 1 occurrence of the "
            f"known control_open case block in {TARGET_FILE}, found "
            f"{occurrences}. The base image's kclient script has changed "
            f"since this patch was written (see this script's own module "
            f"doc) -- re-verify #lsbar still auto-opens, re-derive the exact "
            f"block to match, and update this script before rebuilding.",
            file=sys.stderr,
        )
        return 1

    patched = content.replace(OLD_BLOCK, NEW_BLOCK)
    with open(TARGET_FILE, "w", encoding="utf-8") as f:
        f.write(patched)

    print(f"hide-lsbar patch applied to {TARGET_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
