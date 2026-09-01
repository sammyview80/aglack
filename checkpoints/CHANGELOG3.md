# Changelog 3

Everything changed this session, in commit order. See `CHECKPOINT3.md` in
this same folder for the full narrative/root-cause detail behind each
entry; this file is the terse commit-by-commit record.

## 2026-09-01

### Fixed

- **CSRF "Cross-origin mismatch" rejected legitimate onboarding requests,
  round 1.** `HERMES_WEBUI_ALLOWED_ORIGINS` (the env var
  `transport/origin_alignment.py`'s `align_loopback_proxy_host()` needs to
  rewrite a proxied request's `Host` to match a loopback browser `Origin`
  before upstream's CSRF check runs) was never set anywhere — not in
  `.env`, `.env.example`, nor the container boot script — so the fix
  already in wrapper code was permanently inert. `rust_gateway`'s
  `container.rs` boot script now sets it.
  (`rust_gateway/src/workspaces/container.rs`,
  `backend/wrapper/.env`, `backend/wrapper/.env.example`,
  `backend/wrapper/tests/test_transport.py`)

- **CSRF "Cross-origin mismatch," round 2.** Round 1's fix hardcoded a
  single allowed origin (the Vite dev server), which missed a real,
  independently-confirmed deployment shape: a browser hitting the
  gateway's own published address directly (`Origin:
  http://127.0.0.1:8080`). `GatewayConfig::wrapper_allowed_origins()`
  (new) now builds the full set from both `frontend_origin` and the
  gateway's own `listen_addr`, deduplicated; `DockerCliLauncher` takes it
  as a real constructor parameter instead of a baked-in string.
  (`rust_gateway/src/config.rs`,
  `rust_gateway/src/workspaces/container/docker_launcher.rs`,
  `rust_gateway/src/workspaces/container/boot_script.rs`,
  `rust_gateway/src/bin/rust_gateway.rs`, `rust_gateway/src/app.rs`)

- **Default agent workspace resolved to `/config/workspace` instead of a
  sensible path.** `HERMES_WEBUI_DEFAULT_WORKSPACE` (upstream's own env
  var) was never set by the container boot script, so upstream's
  fallback chain resolved to `~/workspace` under the script's
  `HOME=/config`. New required env var `WORKSPACE_DEFAULT_PATH`
  (default value `/workspace/default` in `.env`/`.env.example`) is
  threaded through `GatewayConfig` → `DockerCliLauncher` → the boot
  script, which also now `mkdir -p`s and `chown`s the directory as root
  before dropping to the `abc` user (verified live: `/` is not writable
  by `abc`, uid 911, in the base image — only a pre-created, chowned
  directory works inside the `abc`-run block).
  (`rust_gateway/src/config.rs`,
  `rust_gateway/src/workspaces/container/docker_launcher.rs`,
  `rust_gateway/src/workspaces/container/boot_script.rs`,
  `rust_gateway/src/bin/rust_gateway.rs`, `rust_gateway/src/app.rs`,
  `rust_gateway/.env`, `rust_gateway/.env.example`)

- **`HERMES_FRONTEND_ORIGIN` was still hardcoded in the boot script**
  after the two fixes above — the same class of bug, missed in the first
  pass. `DockerCliLauncher` now takes `frontend_origin` as a 4th
  constructor parameter (built from the same `GatewayConfig.frontend_origin`
  the gateway's own CORS layer already uses); the boot script has zero
  hardcoded URLs/paths left.
  (`rust_gateway/src/workspaces/container/docker_launcher.rs`,
  `rust_gateway/src/workspaces/container/boot_script.rs`,
  `rust_gateway/src/bin/rust_gateway.rs`, `rust_gateway/src/app.rs`)

### Refactored

- **`rust_gateway/src/workspaces/container.rs`** (1209 lines, 8 mixed
  responsibilities) split into `workspaces/container/{mod, docker_launcher,
  boot_script, desktop, health, inspect, docker_cli, fake_launcher}.rs`.
  Zero behavior change — same 8→85 tests pass before/after each step.
- **`rust_gateway/src/workspaces/route.rs`** (962 lines, 4 unrelated HTTP
  handlers) split into `workspaces/route/{mod, create, list, delete,
  diagnose}.rs`.
- **`backend/wrapper/.../transport/handler.py`** (336 lines, 4 mixed
  concerns) split: `handler.py` now holds only `FakeHandler`/`drain()`;
  new siblings `headers.py`, `origin_alignment.py`, `stdlib_stubs.py`.
  `handler.py` re-exports everything (`__all__`) so no import line
  anywhere else needed to change.
- `rust_gateway/AGENTS.md` and `backend/wrapper/AGENTS.md` structure
  sections updated to match (the rust_gateway one was stale before this
  session too — never mentioned `workspaces/` at all).

### Reverted (not part of the final change set)

- A per-new-Hermes-profile workspace default (`HERMES_WEBUI_PROFILE_WORKSPACE_ROOT`,
  `_write_workspace_default_to_config()` in `hermano/backend`'s
  `api/profiles.py`) was built, fully tested (7 passing tests), then
  reverted after clarifying the actual ask was the single default-agent
  workspace path above, not per-profile provisioning. `hermano/backend`
  is back to its pre-session state — nothing from this line of work is
  present there.

### Docs

- `checkpoints/` folder created; `CHECKPOINT.md`/`CHECKPOINT1.md` copied
  in from repo root (originals left in place); `CHECKPOINT3.md` added
  covering this session in full narrative form.
