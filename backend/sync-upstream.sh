#!/usr/bin/env bash
# One-command check for a newer Hermes WebUI upstream commit than the one
# currently pinned. See UPSTREAM.md for the full "why" and the manual
# procedure this script automates the read-only, information-gathering
# part of.
#
# This script NEVER changes the pinned commit itself. It only:
#   1. Fetches origin (does not merge/checkout anything).
#   2. Reports whether backend/upstream is on a stale, ahead, or diverged
#      commit relative to origin's default branch.
#   3. If newer commits exist, prints the commit list so you can review
#      them before deciding to update.
#
# Actually adopting a new commit is a deliberate, separate action — see
# "Safely updating the pinned commit" in UPSTREAM.md for the required
# steps (test against the candidate commit BEFORE replacing the pin).
#
# Usage:
#   ./sync-upstream.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM_DIR="$ROOT/upstream"

if [ ! -d "$UPSTREAM_DIR/.git" ]; then
  echo "sync-upstream.sh: backend/upstream is missing or not a git repo." >&2
  echo "Create it first with the bootstrap script (clones over HTTPS and pins" >&2
  echo "the exact upstream commit — see UPSTREAM.md):" >&2
  echo "  ./backend/bootstrap-upstream.sh" >&2
  echo "" >&2
  echo "Or manually:" >&2
  echo "  git clone https://github.com/nesquena/hermes-webui.git backend/upstream" >&2
  exit 1
fi

echo "Fetching origin (read-only — no merge, no checkout)..."
git -C "$UPSTREAM_DIR" fetch origin --quiet

CURRENT="$(git -C "$UPSTREAM_DIR" rev-parse HEAD)"
DEFAULT_BRANCH="$(git -C "$UPSTREAM_DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo master)"
LATEST="$(git -C "$UPSTREAM_DIR" rev-parse "origin/$DEFAULT_BRANCH")"

echo ""
echo "Currently pinned:      $CURRENT"
echo "Latest on origin/$DEFAULT_BRANCH: $LATEST"
echo ""

if [ "$CURRENT" = "$LATEST" ]; then
  echo "Up to date — the pinned commit already matches upstream's latest."
  exit 0
fi

BEHIND_COUNT="$(git -C "$UPSTREAM_DIR" rev-list --count "$CURRENT..$LATEST")"
echo "$BEHIND_COUNT commit(s) newer than the pinned commit are available:"
echo ""
git -C "$UPSTREAM_DIR" log --oneline "$CURRENT..$LATEST"
echo ""
echo "This script has NOT changed anything — backend/upstream is still on"
echo "the pinned commit ($CURRENT)."
echo ""
echo "To adopt a newer commit, follow UPSTREAM.md's 'Safely updating the"
echo "pinned commit' procedure (test against a scratch clone of the"
echo "candidate commit BEFORE replacing this pin) — do not just"
echo "'git -C backend/upstream pull' and move on, that skips the required"
echo "wrapper test-suite verification step."
