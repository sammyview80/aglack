#!/usr/bin/env bash
# Run every service in this repo together for local dev, from one command.
#
#   ./run.sh
#
# Starts (in the background, this terminal stays free):
#   1. rust_gateway's test_backend  — throwaway "okay" stand-in for a real
#      wrapper container (see rust_gateway/src/bin/test_backend.rs).
#   2. rust_gateway itself           — forwards to test_backend above.
#   3. frontend (vite dev server)    — the React app.
#
# Logs for each service stream to logs/<service>.log (gitignored) AND to
# this terminal, prefixed with the service name, so you can see everything
# at once without hunting through separate terminal tabs.
#
# Ctrl+C stops all three cleanly (no orphaned background processes left
# holding ports open for the next run).
#
# Does NOT start/build backend/workspace-image's Docker image or any real
# workspace container — that is a separate, explicit step (see
# backend/workspace-image/Dockerfile and rust_gateway/.env's
# WORKSPACE_IMAGE_TAG) since it is slow and not needed for routing-only dev.
#
# OpenConnector is a remote, already-hosted instance this repo never
# starts — see rust_gateway/.env.example's OPENCONNECTOR_URL comment.
set -euo pipefail

if [ "$#" -gt 0 ]; then
  echo "run.sh: unknown argument: $1" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

# Rust needs cargo/rustc on PATH. rustup installs to ~/.cargo/bin but does
# not always add it to a non-interactive shell's PATH — add it defensively
# rather than requiring every developer to fix their shell profile first.
if ! command -v cargo >/dev/null 2>&1 && [ -x "$HOME/.cargo/bin/cargo" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "run.sh: cargo not found. Install Rust (https://rustup.rs) first." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "run.sh: npm not found. Install Node.js first." >&2
  exit 1
fi

if [ ! -f "$ROOT/rust_gateway/.env" ]; then
  echo "run.sh: rust_gateway/.env is missing. Run:" >&2
  echo "  cp rust_gateway/.env.example rust_gateway/.env" >&2
  exit 1
fi
if [ ! -f "$ROOT/.env.shared" ]; then
  echo "run.sh: .env.shared is missing. Run:" >&2
  echo "  cp .env.shared.example .env.shared" >&2
  exit 1
fi

if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "run.sh: frontend dependencies are not installed. Run:" >&2
  echo "  (cd frontend && npm install)" >&2
  exit 1
fi

# One shared color-prefixed tee so all three logs are readable interleaved
# in this terminal, not just buried in their own files.
tail_prefixed() {
  local label="$1"
  local logfile="$2"
  tail -n +1 -f "$logfile" 2>/dev/null | sed -u "s/^/[$label] /" &
  TAIL_PIDS+=("$!")
}

PIDS=()
TAIL_PIDS=()

cleanup() {
  echo ""
  echo "run.sh: stopping all services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  for pid in "${TAIL_PIDS[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  wait >/dev/null 2>&1 || true
  echo "run.sh: stopped."
}
trap cleanup EXIT INT TERM

echo "run.sh: starting test_backend (throwaway stand-in for a real wrapper)..."
(cd "$ROOT/rust_gateway" && cargo run --bin test_backend) > "$LOG_DIR/test_backend.log" 2>&1 &
PIDS+=("$!")

echo "run.sh: starting rust_gateway..."
(cd "$ROOT/rust_gateway" && cargo run --bin rust_gateway) > "$LOG_DIR/rust_gateway.log" 2>&1 &
PIDS+=("$!")

echo "run.sh: starting frontend (vite dev server)..."
(cd "$ROOT/frontend" && npm run dev) > "$LOG_DIR/frontend.log" 2>&1 &
PIDS+=("$!")

# Give cargo a moment to at least start compiling before we start tailing,
# so the first lines of real output aren't missed by tail -f's startup race.
sleep 1

tail_prefixed "test_backend" "$LOG_DIR/test_backend.log"
tail_prefixed "rust_gateway" "$LOG_DIR/rust_gateway.log"
tail_prefixed "frontend" "$LOG_DIR/frontend.log"

echo ""
echo "run.sh: all services starting. Logs: $LOG_DIR/*.log. Press Ctrl+C to stop everything."
echo ""

wait "${PIDS[@]}"
