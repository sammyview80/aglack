#!/usr/bin/env bash
# One-shot setup + run for this repo: rust_gateway, frontend, and the dev
# routing stack (test_backend stand-in) — everything run.sh needs, done
# for you first if missing.
#
#   ./bootstrap.sh
#
# Idempotent: safe to re-run. Copies .env files only if absent (never
# overwrites), installs frontend deps only if node_modules is missing,
# then hands off to run.sh for the actual run.
#
# Does NOT build backend/workspace-image's Docker image or start a real
# workspace container — see run.sh's own header for why, and README.md's
# "Real containers" section for that separate step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v cargo >/dev/null 2>&1 && [ -x "$HOME/.cargo/bin/cargo" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

echo "bootstrap.sh: checking prerequisites..."
missing=()
command -v cargo >/dev/null 2>&1 || missing+=("Rust/cargo (https://rustup.rs)")
command -v npm >/dev/null 2>&1 || missing+=("Node.js/npm (https://nodejs.org)")
command -v docker >/dev/null 2>&1 || missing+=("Docker (only required for real workspace containers, not this dev run)")
if [ "${#missing[@]}" -gt 0 ]; then
  echo "bootstrap.sh: missing prerequisites:" >&2
  for m in "${missing[@]}"; do echo "  - $m" >&2; done
  # Docker is not required for the dev routing stack run.sh starts, so
  # only fail closed on cargo/npm being absent.
  command -v cargo >/dev/null 2>&1 || exit 1
  command -v npm >/dev/null 2>&1 || exit 1
fi

if [ ! -f "$ROOT/.env.shared" ]; then
  echo "bootstrap.sh: creating .env.shared from .env.shared.example..."
  cp "$ROOT/.env.shared.example" "$ROOT/.env.shared"
fi

if [ ! -f "$ROOT/rust_gateway/.env" ]; then
  echo "bootstrap.sh: creating rust_gateway/.env from rust_gateway/.env.example..."
  cp "$ROOT/rust_gateway/.env.example" "$ROOT/rust_gateway/.env"
fi

if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "bootstrap.sh: installing frontend dependencies (npm install)..."
  (cd "$ROOT/frontend" && npm install)
fi

echo "bootstrap.sh: setup done. Handing off to run.sh..."
echo ""
exec "$ROOT/run.sh"
