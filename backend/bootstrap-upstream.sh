#!/usr/bin/env bash
# Create backend/upstream/ at the exact pinned Hermes WebUI commit.
#
# backend/upstream/ is a pinned third-party checkout and is deliberately
# git-ignored (see ../.gitignore), so a fresh clone of this repository has an
# empty backend/upstream/ and the wrapper cannot run. This script materializes
# it from the public upstream repository over HTTPS — no credentials, token, or
# SSH key required.
#
# Behavior (idempotent, never destructive):
#   * missing            -> clone over HTTPS, check out the pinned SHA
#   * present @ pinned   -> report "already correct" and exit 0, change nothing
#   * present @ other    -> report the mismatch and exit non-zero. This script
#                           NEVER resets, checks out over, or deletes an
#                           existing checkout; moving an existing pin is a
#                           deliberate act (see UPSTREAM.md, "Safely updating
#                           the pinned commit").
#
# Usage:
#   ./backend/bootstrap-upstream.sh
#
# Env overrides:
#   UPSTREAM_REPO   clone URL (default: the public HTTPS URL below)
set -euo pipefail

PINNED_SHA="e168b67e4278df618d1cab61fdb3a8dc55b29a81"
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/nesquena/hermes-webui.git}"

# Derive paths from this script's own location, never $PWD, so the script works
# no matter which directory it is invoked from.
BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM_DIR="$BACKEND_DIR/upstream"

log()  { printf 'bootstrap-upstream: %s\n' "$1"; }
die()  { printf 'bootstrap-upstream: error: %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required but was not found on PATH."

# --- Case 1 + 2: a checkout already exists. Read only; never mutate it. ---
if [ -e "$UPSTREAM_DIR" ]; then
  [ -d "$UPSTREAM_DIR/.git" ] || die \
    "$UPSTREAM_DIR exists but is not a git repository. Inspect and remove it by hand, then re-run."

  CURRENT="$(git -C "$UPSTREAM_DIR" rev-parse HEAD)"

  if [ "$CURRENT" = "$PINNED_SHA" ]; then
    log "backend/upstream already exists at the pinned commit ($PINNED_SHA) — nothing to do."
    exit 0
  fi

  printf 'bootstrap-upstream: error: %s\n' \
    "backend/upstream exists but is at the WRONG commit." >&2
  printf '  expected (pinned): %s\n' "$PINNED_SHA" >&2
  printf '  actual (HEAD):     %s\n' "$CURRENT" >&2
  printf '%s\n' \
    "Refusing to reset it — an existing checkout is never silently rewritten." >&2
  printf '%s\n' \
    "Either move it aside and re-run this script, or follow UPSTREAM.md's" >&2
  printf '%s\n' \
    "'Safely updating the pinned commit' procedure if the pin should change." >&2
  exit 1
fi

# --- Case 3: nothing there yet. Clone and pin. ---
log "backend/upstream is missing — cloning $UPSTREAM_REPO ..."
mkdir -p "$(dirname "$UPSTREAM_DIR")"
git clone --quiet "$UPSTREAM_REPO" "$UPSTREAM_DIR" \
  || die "clone failed: could not fetch $UPSTREAM_REPO"

log "checking out pinned commit $PINNED_SHA ..."
git -C "$UPSTREAM_DIR" checkout --quiet "$PINNED_SHA" \
  || die "pinned commit $PINNED_SHA not found in $UPSTREAM_REPO (upstream history rewritten?)"

# --- Verify: HEAD must be exactly the pin, or fail loudly. ---
RESULT="$(git -C "$UPSTREAM_DIR" rev-parse HEAD)"
if [ "$RESULT" != "$PINNED_SHA" ]; then
  printf 'bootstrap-upstream: error: %s\n' "pin verification FAILED after checkout." >&2
  printf '  expected: %s\n' "$PINNED_SHA" >&2
  printf '  actual:   %s\n' "$RESULT" >&2
  exit 1
fi

log "verified: backend/upstream HEAD is $RESULT"
log "done. Treat backend/upstream as a read-only vendored dependency (see UPSTREAM.md)."
