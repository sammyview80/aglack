#!/usr/bin/env python3
"""Patch the base webtop image's `kclient` EJS template so its embedded
KasmVNC iframe defaults to a hidden control bar — NOT anything in this
repo's own code otherwise. Companion to `patch_kasmvnc_lastactiveat.py`;
see that script's own module doc for the established pattern this
follows (fail-closed byte match, patch during image build, delete once
the base image fixes it upstream).

## The problem (confirmed live against a real running container)

`rust_gateway`'s desktop proxy (`/workspaces/:id/desktop/`) serves
`/kclient/public/index.html` — NOT raw KasmVNC directly. That template
hardcodes its inner KasmVNC iframe's `src` with `show_control_bar=true`
literally in the markup:

    <iframe class="vnc" src="vnc/index.html?autoconnect=1&resize=remote
      &clipboard_up=true&clipboard_down=true&clipboard_seamless=true
      &show_control_bar=true<% if(path){ %><%- path -%><% } %>"></iframe>

Confirmed this is an EJS template (`<%- title -%>`, `<% if(path){ %>`),
rendered server-side by `kclient`'s own Node process inside the
container — it does NOT read the outer request's own query string at
any layer (verified: identical rendered body across different outer
query strings hitting `/workspaces/:id/desktop/?...`). So a caller-side
`show_control_bar=` URL param (see `desktopUrl()` in
`frontend/src/features/workspace/api.ts`) has zero effect on this path;
it only matters for a caller embedding KasmVNC's own `vnc/index.html`
directly, bypassing this shell.

KasmVNC's own `ui.js` additionally calls `UI.openControlbar()`
unconditionally during page init — that call has NO `show_control_bar`
guard around it at all (confirmed by reading the real fetched `ui.js`
directly, not assumed). The actual mechanism that hides the bar lives
elsewhere, further down `UI.updateVisualState()`'s Kasm-VDI-specific
block (only reached because `isInsideKasmVDI()` is `window.self !==
window.top`, true for any iframe embed — which this always is):

    if (! WebUtil.getConfigVar('show_control_bar')) {
        document.getElementById('noVNC_control_bar_anchor')
            .setAttribute('style', 'display: none');
    }

`WebUtil.getConfigVar()` returns the RAW query-string value as a string
— it does NOT parse `"true"`/`"false"` into JS booleans. A first, wrong
version of this patch set the value to the literal string `"false"`,
which is a NON-EMPTY string and therefore truthy in JavaScript
(`Boolean("false") === true`) — `!"false"` is `false`, so the `if` body
above never runs and `display:none` is never applied. That version
shipped, was live-tested by fetching the RENDERED HTML and confirming it
contained the string `show_control_bar=false`, and that check passed —
but confirming the STRING is present is not the same as confirming
`ui.js` treats it as falsy once actually executed in a browser; that
gap is exactly why it did not fix anything. The correct value is an
EMPTY string (`show_control_bar=`, param present with nothing after
`=`, not merely omitted) — `getConfigVar()` then returns `""`, which
IS falsy, so `!""` is `true` and the bar is actually hidden.

## Fail-closed by design

If the base image ever changes this exact template (a webtop/kclient
version bump), the string this script searches for will no longer match
byte-for-byte, and this script exits non-zero — failing the Docker build
loudly rather than silently leaving the control bar shown while looking
like the fix was applied. Re-derive the exact block and update this
script before rebuilding; do not weaken the match to "contains
show_control_bar=true" (that could rewrite an unrelated future
occurrence of the same substring elsewhere in the template).
"""

import sys

TARGET_FILE = "/kclient/public/index.html"

# Byte-for-byte match of the real, currently-shipped template (verified
# against a real running container — see this file's own module doc).
# Deliberately includes the full iframe src attribute, not just the one
# query param, so a partial/coincidental match elsewhere in the file
# cannot trigger a false-positive replacement.
OLD_LINE = (
    '    <iframe class="vnc" src="vnc/index.html?autoconnect=1&resize=remote'
    '&clipboard_up=true&clipboard_down=true&clipboard_seamless=true'
    '&show_control_bar=true<% if(path){ %><%- path -%><% } %>"></iframe>'
)

NEW_LINE = (
    '    <iframe class="vnc" src="vnc/index.html?autoconnect=1&resize=remote'
    '&clipboard_up=true&clipboard_down=true&clipboard_seamless=true'
    '&show_control_bar=<% if(path){ %><%- path -%><% } %>"></iframe>'
)


def main() -> int:
    with open(TARGET_FILE, "r", encoding="utf-8") as f:
        content = f.read()

    occurrences = content.count(OLD_LINE)
    if occurrences != 1:
        print(
            f"hide-control-bar patch FAILED: expected exactly 1 occurrence of "
            f"the known iframe line in {TARGET_FILE}, found {occurrences}. The "
            f"base image's kclient template has changed since this patch was "
            f"written (see this script's own module doc) -- re-verify the "
            f"control bar still shows by default, re-derive the exact line to "
            f"match, and update this script before rebuilding.",
            file=sys.stderr,
        )
        return 1

    patched = content.replace(OLD_LINE, NEW_LINE)
    with open(TARGET_FILE, "w", encoding="utf-8") as f:
        f.write(patched)

    print(f"hide-control-bar patch applied to {TARGET_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
