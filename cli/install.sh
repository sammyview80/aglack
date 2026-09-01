#!/usr/bin/env sh
# aglack CLI installer.
#
#   curl -fsSL <raw-url-to-this-file> | sh
#
# What this does:
#   1. Clones (or updates, if already cloned) this private repo to
#      ~/.aglack/src via SSH — this repo is PRIVATE, so an unauthenticated
#      "curl a raw file" install of the CLI's own source is not possible;
#      your existing git/SSH access to the repo is what authenticates
#      this step (same as any `git clone` you already run).
#   2. Symlinks cli/aglack from that checkout to a directory on your PATH
#      (tries, in order: $AGLACK_BIN_DIR, ~/.local/bin, /usr/local/bin).
#
# Re-running this script is safe (updates the checkout, re-links the CLI).
#
# Env overrides:
#   AGLACK_REPO      git remote to clone (default: the SSH URL below)
#   AGLACK_SRC_DIR   where to clone/update the checkout (default: ~/.aglack/src)
#   AGLACK_BIN_DIR   where to link the `aglack` binary (default: first of
#                    ~/.local/bin / /usr/local/bin that exists or can be made)
set -eu

REPO="${AGLACK_REPO:-git@github.com:sammyview80/aglack.git}"
SRC_DIR="${AGLACK_SRC_DIR:-$HOME/.aglack/src}"
BRANCH="${AGLACK_BRANCH:-aglack}"

log() { printf 'aglack-install: %s\n' "$1"; }
die() { printf 'aglack-install: error: %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required but was not found on PATH."

if [ -d "$SRC_DIR/.git" ]; then
  log "existing checkout found at $SRC_DIR — updating..."
  git -C "$SRC_DIR" fetch origin "$BRANCH"
  git -C "$SRC_DIR" checkout "$BRANCH"
  git -C "$SRC_DIR" pull --ff-only origin "$BRANCH"
else
  log "cloning $REPO (branch $BRANCH) into $SRC_DIR..."
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --branch "$BRANCH" "$REPO" "$SRC_DIR"
fi

# This repo's root IS the project root (cli/ sits at the top level).
# cli/aglack auto-detects its project root from its OWN location (see
# cli/aglack's resolve_root()), so linking the file in-place is enough —
# no copying.
CLI_SRC="$SRC_DIR/cli/aglack"
[ -f "$CLI_SRC" ] || CLI_SRC="$SRC_DIR/revamp/cli/aglack"
[ -f "$CLI_SRC" ] || die "cli/aglack not found in checkout at $SRC_DIR (looked under cli/ and revamp/cli)."
chmod +x "$CLI_SRC"

pick_bin_dir() {
  if [ -n "${AGLACK_BIN_DIR:-}" ]; then
    echo "$AGLACK_BIN_DIR"
    return
  fi
  for d in "$HOME/.local/bin" "/usr/local/bin"; do
    if [ -d "$d" ] && [ -w "$d" ]; then
      echo "$d"
      return
    fi
  done
  # Neither exists yet — prefer the user-local one, create it.
  echo "$HOME/.local/bin"
}

BIN_DIR="$(pick_bin_dir)"
mkdir -p "$BIN_DIR"
ln -sf "$CLI_SRC" "$BIN_DIR/aglack"
log "linked aglack -> $CLI_SRC"
log "installed at $BIN_DIR/aglack"

case ":$PATH:" in
  *":$BIN_DIR:"*)
    log "done. Run: aglack help"
    ;;
  *)
    log "done, but $BIN_DIR is not on your PATH."
    log "Add this to your shell profile:"
    log "  export PATH=\"$BIN_DIR:\$PATH\""
    log "Then run: aglack help"
    ;;
esac
