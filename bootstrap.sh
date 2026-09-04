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

# ── Required secrets check (rust_gateway/.env) ──────────────────────────────
# GATEWAY_ADMIN_PASSWORD_HASH, GATEWAY_TOKEN_ENCRYPTION_KEY, and
# OPENCONNECTOR_ADMIN_TOKEN are all required-with-no-fallback (see
# rust_gateway/src/config.rs) — a missing one currently fails cargo run with
# a raw config error instead of an actionable message from here. Checked
# every run, not just on first .env creation, so a value emptied later is
# still caught.
GATEWAY_ENV="$ROOT/rust_gateway/.env"

# Reads the current value of KEY=... from $GATEWAY_ENV, empty string if the
# key is absent or has no value after "=".
env_value() {
  local key="$1"
  grep -E "^${key}=" "$GATEWAY_ENV" 2>/dev/null | tail -n1 | cut -d'=' -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

if [ -f "$GATEWAY_ENV" ]; then
  if [ -z "$(env_value GATEWAY_TOKEN_ENCRYPTION_KEY)" ]; then
    echo "bootstrap.sh: GATEWAY_TOKEN_ENCRYPTION_KEY is empty — generating one (openssl rand -base64 32)..."
    generated_key="$(openssl rand -base64 32)"
    if grep -q "^GATEWAY_TOKEN_ENCRYPTION_KEY=" "$GATEWAY_ENV"; then
      # Portable in-place edit: write to a temp file, then replace — avoids
      # relying on `sed -i`'s BSD-vs-GNU flag differences.
      awk -v val="$generated_key" -F'=' 'BEGIN{OFS="="} $1=="GATEWAY_TOKEN_ENCRYPTION_KEY"{$0="GATEWAY_TOKEN_ENCRYPTION_KEY="val} {print}' "$GATEWAY_ENV" > "$GATEWAY_ENV.tmp"
      mv "$GATEWAY_ENV.tmp" "$GATEWAY_ENV"
    else
      echo "GATEWAY_TOKEN_ENCRYPTION_KEY=$generated_key" >> "$GATEWAY_ENV"
    fi
    echo "bootstrap.sh: wrote a generated GATEWAY_TOKEN_ENCRYPTION_KEY into rust_gateway/.env."
  fi

  if [ -z "$(env_value OPENCONNECTOR_ADMIN_TOKEN)" ] || [ "$(env_value OPENCONNECTOR_ADMIN_TOKEN)" = "your-openconnector-admin-token" ]; then
    echo "" >&2
    echo "bootstrap.sh: OPENCONNECTOR_ADMIN_TOKEN is empty/default in rust_gateway/.env." >&2
    echo "  OpenConnector is a remote instance hosted elsewhere — this value is issued" >&2
    echo "  by whoever hosts it, bootstrap.sh cannot generate one for you (unlike" >&2
    echo "  GATEWAY_TOKEN_ENCRYPTION_KEY above, this is not a value this gateway" >&2
    echo "  invents on its own; it must match the real admin token that instance" >&2
    echo "  actually accepts)." >&2
    echo "" >&2
    echo "  Get the real admin-scoped API token from your OpenConnector host, then" >&2
    echo "  paste it as OPENCONNECTOR_ADMIN_TOKEN in rust_gateway/.env (and set" >&2
    echo "  OPENCONNECTOR_URL there too), and re-run ./bootstrap.sh. See" >&2
    echo "  rust_gateway/.env.example's OPENCONNECTOR_ADMIN_TOKEN comment for why it" >&2
    echo "  must be the admin/management credential, not a narrower runtime token." >&2
    exit 1
  fi

  if [ -z "$(env_value GATEWAY_ADMIN_PASSWORD_HASH)" ]; then
    echo "" >&2
    echo "bootstrap.sh: GATEWAY_ADMIN_PASSWORD_HASH is empty in rust_gateway/.env." >&2
    echo "  This requires a real password choice — bootstrap.sh cannot generate it" >&2
    echo "  for you. Run:" >&2
    echo "" >&2
    echo "    cd rust_gateway && cargo run --bin rust_gateway -- --hash-password 'your password'" >&2
    echo "" >&2
    echo "  then paste the full \$argon2id\$... output as GATEWAY_ADMIN_PASSWORD_HASH in" >&2
    echo "  rust_gateway/.env, and re-run ./bootstrap.sh." >&2
    exit 1
  fi
fi

echo "bootstrap.sh: setup done. Handing off to run.sh..."
echo ""
exec "$ROOT/run.sh"
