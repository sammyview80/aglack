# Checkpoint 3 — read this first in a new session

Continues from `CHECKPOINT.md`/`CHECKPOINT1.md` (moved into this same
`checkpoints/` folder). This file covers everything done in the session
after `CHECKPOINT.md` was last updated — three real, live-tested fixes
plus a structural refactor. **Nothing in this file is committed except
the first CSRF fix** — see "Repository / commit state" below before
assuming any of this is on disk in a fresh clone.

## What this project is

Unchanged from `CHECKPOINT.md` — Rust gateway (control plane) in front of
per-tenant Docker containers running Hermes WebUI + wrapper. Read
`CHECKPOINT.md` first for the full architecture picture; this file only
adds what changed since.

## Repository / commit state

- Commit `2b09b79` (`fix(gateway): allow both frontend + gateway origins
  for wrapper CSRF`) is the ONLY part of this session's work actually
  committed.
- Everything else below — the second CSRF round, the container.rs/
  route.rs/handler.py structural refactor, and the
  workspace-default-path config-driven fix — is **uncommitted working-
  tree state** as of this checkpoint. `git status --short` in
  `rust_gateway/` and `backend/wrapper/` shows the real diff; do not
  assume a fresh `git clone` has any of it.
- `rust_gateway/.env` is gitignored and was hand-edited this session
  (added `WORKSPACE_DEFAULT_PATH=/workspace/default`) — a fresh checkout
  needs `cp .env.example .env` and both new-since-`CHECKPOINT.md` vars
  filled in (`WORKSPACE_DEFAULT_PATH` — see below; `wrapper_allowed_origins`-
  fed vars are computed by the gateway itself, not hand-set).

## 1. CSRF "Cross-origin mismatch" fix — two real rounds

**Symptom**: onboarding finish screen (both the React rebuild and
upstream's own native onboarding UI, served through the `hermes-webui`
proxy route) showed `"Cross-origin mismatch - check reverse proxy
headers"` on `setup`/`complete`/`settings` POSTs.

**Root cause chain** (fully traced, not guessed): upstream's
`api/routes.py:_check_same_origin_browser_request` rejects a request
when the browser's `Origin` header doesn't match the request's `Host`
header. `rust_gateway`'s `proxy::forward_to` strips the incoming `Host`
(correct — reqwest sets the real target) but forwards `Origin`
unchanged, so any request reaching a workspace's wrapper through this
gateway naturally has a browser `Origin` that disagrees with the
container's own `Host`. Wrapper-side, `transport/handler.py`'s (now
`transport/origin_alignment.py`'s — see refactor below)
`align_loopback_proxy_host()` exists specifically to rewrite `Host` to
match a loopback `Origin` before upstream's check runs, gated on the
`HERMES_WEBUI_ALLOWED_ORIGINS` env var.

**Round 1** (commit `2b09b79`): `HERMES_WEBUI_ALLOWED_ORIGINS` was never
set anywhere — not in `.env`, `.env.example`, nor the container boot
script — so `align_loopback_proxy_host()` was permanently inert. Fixed
by setting it in the boot script to a single hardcoded value
(`http://localhost:5173`).

**Round 2** (uncommitted): a REAL captured browser request (user's own
curl, with real cookies) showed `Origin: http://127.0.0.1:8080` — the
gateway's own published address, not Vite's — still 403ing, because the
round-1 fix only allowlisted the Vite dev-server origin. Fixed properly:
`DockerCliLauncher` now takes `allowed_origins: String` as a real
constructor parameter (not a hardcoded string in `boot_script.rs`);
`GatewayConfig::wrapper_allowed_origins()` (new method in `config.rs`)
builds it from BOTH `frontend_origin` AND `http://{listen_addr}`
(the gateway's own real address), deduplicated. Threaded through
`bin/rust_gateway.rs`'s real `main()`.

**Verified live, both rounds** — not just code-read: real container
launched via real `POST /workspaces`, real boot script inspected on disk
inside the running container, real POST replayed with the browser's
exact captured headers → real `200`/`400` (past CSRF) instead of `403`.
Negative control: same exact request against an intentionally-unfixed
wrapper instance inside the same real container → real `403` with the
exact reported string, byte for byte.

**A real mistake made and fixed mid-session**: while testing, `mv
data/gateway.db data/gateway.db.old-...` was used to get a clean test DB
without ever restoring it before killing the gateway process — this
wiped the frontend's visible workspace list (4 real workspaces) even
though the underlying Docker containers were untouched. Recovered by
restoring the renamed-away original `gateway.db`. **Lesson for next
session**: never swap `rust_gateway/data/gateway.db` for a scratch file
without restoring it in the same breath, even mid-debugging.

## 2. Structural refactor — container.rs, route.rs, handler.py

Pure move/reorg, zero behavior change, done AFTER the CSRF fixes above
(so the CSRF fix's own file, `container.rs`'s `boot_script`-adjacent
code, moved as part of this too). Verified with the full test suite
before and after every step — see "Test counts" below.

**`rust_gateway/src/workspaces/container.rs`** (was 1209 lines, 8 mixed
responsibilities) → folder module `workspaces/container/`:
- `mod.rs` — `ContainerLauncher` trait, `LaunchedContainer`,
  `ContainerState`, re-exports
- `docker_launcher.rs` — `DockerCliLauncher` + its `ContainerLauncher`
  impl (the real `docker` CLI launcher)
- `boot_script.rs` — `wrapper_boot_script`/`deliver_boot_script` (the
  CSRF-fix env vars AND the workspace-default-path fix below both live
  here)
- `desktop.rs` — `desktop_subpath`/`desktop_subfolder_env_arg`
- `health.rs` — wrapper/desktop readiness polling + one-shot health
  checks (`wait_for_wrapper_ready`, `wait_for_desktop_ready`,
  `check_wrapper_health`, `check_desktop_health`)
- `inspect.rs` — `docker inspect` JSON parsing
- `docker_cli.rs` — `run_docker`/`pick_free_port` shared primitives
- `fake_launcher.rs` — `FakeLauncher` (`#[cfg(test)]` Docker-free test
  double)

**`rust_gateway/src/workspaces/route.rs`** (was 962 lines, 4 unrelated
HTTP handlers) → folder module `workspaces/route/`:
- `mod.rs` — `WorkspacesState` only (shared by all four handlers)
- `create.rs` — `POST /workspaces`
- `list.rs` — `GET /workspaces`
- `delete.rs` — `DELETE /workspaces/:id`
- `diagnose.rs` — `POST /workspaces/:id/diagnose`

**`backend/wrapper/.../transport/handler.py`** (was 336 lines, 4 mixed
concerns) → `handler.py` (now `FakeHandler` + `drain()` only) plus three
new sibling files:
- `headers.py` — `headers_from_raw`/`normalize_buffered_body_headers`
- `origin_alignment.py` — `_is_loopback_host`/`align_loopback_proxy_host`
  (the CSRF-alignment fix from section 1 above)
- `stdlib_stubs.py` — `TLSStub`/`NullConnection`/`AsyncBridgeWriter`

`handler.py` re-exports all of the above (`__all__` list) so `app.py`
and every existing test kept importing from one place — zero import-line
changes needed anywhere outside `transport/`.

**Deliberately left alone**: `desktop_proxy.rs`/`hermes_webui_proxy.rs`/
`onboarding_proxy.rs` (520/221/310 lines) — their shared logic already
lives in `resolve.rs` + `proxy::forward_to`; remaining duplication is
thin per-route registration boilerplate, not worth adding indirection
for.

Both `rust_gateway/AGENTS.md` and `backend/wrapper/AGENTS.md` structure
sections updated to match the new layout (the rust_gateway one was
already stale before this session — didn't mention `workspaces/` at
all).

## 3. Workspace-default-path fix — config-driven, not hardcoded

**Ask**: the default agent's workspace should be `/workspace/default`
(not upstream's fallback of `~/workspace` under the boot script's
`HOME=/config`, i.e. `/config/workspace` — the exact path visible in the
onboarding UI before this fix).

**First pass was wrong** — hardcoded `/workspace/default` directly as a
literal string inside `wrapper_boot_script()`'s `format!()`, violating
`rust_gateway/AGENTS.md` rule #2 ("no hardcoded host/port/URL — every
address through `config.rs`"). Caught by direct user feedback, not
self-review.

**Real fix**: new required env var `WORKSPACE_DEFAULT_PATH` (fails
process startup with a clear error if unset — matches the existing
`FRONTEND_ORIGIN`/`GATEWAY_HOST` convention exactly, no default
fallback). Threaded: `config.rs`'s `GatewayConfig.workspace_default_path`
→ `bin/rust_gateway.rs`'s real `main()` → `DockerCliLauncher::new()`'s
third constructor parameter → `deliver_boot_script()` →
`wrapper_boot_script(allowed_origins, workspace_default_path)`. The
boot script's `mkdir -p <path>`, `chown -R abc:abc <path>`, and
`export HERMES_WEBUI_DEFAULT_WORKSPACE=<path>` all use the parameter —
zero hardcoded path string left in Rust source.

**Real permission issue found and fixed live**: `/` is not writable by
`abc` (uid 911) in the base image — confirmed via `docker exec -u abc
... mkdir /workspace` → `Permission denied`. The `mkdir -p <path> &&
chown -R abc:abc <path>` pair must run as ROOT, before the `su -s
/bin/sh abc -c '...'` block — same pattern already used for
`/config/.hermes`, applied here for the first time to an arbitrary
configured path (not a hardcoded one), so `mkdir -p` creates every
missing parent regardless of how deep the configured path is.

**Verified live**: real container relaunch with the fixed binary → real
`docker exec cat .../hermes-webui-wrapper-boot.sh` on the running
container shows the exact configured path in all three places → real
`GET .../onboarding/status` on that running wrapper reports
`"default_workspace": "/workspace/default"`. Negative control: temporarily
removed `WORKSPACE_DEFAULT_PATH` from `.env` → real process start failure
with `missing required environment variable WORKSPACE_DEFAULT_PATH (see
rust_gateway/.env.example)`, exactly matching the existing required-var
convention's error shape.

## A real detour this session: per-profile workspace (reverted)

Before landing on the fix above, a different, bigger feature was built
and then explicitly reverted: `hermano/backend` (the ORIGINAL project,
NOT this `revamp` repo — a sibling checkout) got a
`_write_workspace_default_to_config()` helper in `api/profiles.py` so
every NEWLY CREATED Hermes profile got its own `/workspace/<profile_name>`
by default, via a new `HERMES_WEBUI_PROFILE_WORKSPACE_ROOT` env var. This
was a real, live-tested, working implementation (7 passing regression
tests, negative-control-proven) — but it solved a different problem than
what was actually asked ("just want to set the default workspace path
for default agent"), so it was fully reverted (`git checkout --
api/profiles.py .env.example README.md` + delete the new test file) and
`hermano/backend` is back to its pre-session state. **Do not re-add this
without a fresh ask** — if per-profile (not per-workspace-container)
defaults are wanted later, the mechanism (write into the new profile's
`config.yaml` `workspace` key at `create_profile_api()` time) is fully
designed and was proven to work; it just isn't live anywhere.

## Test counts (all real, all green at end of session)

- `rust_gateway`: `cargo test` → **84/84** (83 pre-refactor + 1 new
  dedicated `workspace_default_path`-verbatim-passthrough test).
  `cargo clippy --all-targets` → zero warnings.
- `backend/wrapper`: `pytest` → **35/35** (31 original + 4 new
  `align_loopback_proxy_host` tests added during round-1 CSRF fix — this
  function had ZERO test coverage before this session, confirmed by
  grep).
- Every fix in this checkpoint has a real negative control performed
  (temporarily reverted, confirmed the test/request genuinely fails with
  the right error, restored) — not just "tests pass," an actual
  fail-before/pass-after proof for each one.

## Known gaps / not done this session

- The 3 workspace containers that existed BEFORE the CSRF round-2 fix
  landed (created by the pre-fix binary) still carry the OLD boot script
  and will 403 on a direct-gateway-origin browser request until
  relaunched (`DELETE` + `POST` under the same name). User explicitly
  chose to leave them as-is rather than relaunch.
- None of section 1/2/3's work is committed except `2b09b79`. Run
  `git status --short` in `rust_gateway/` and `backend/wrapper/` before
  trusting any file state in a fresh session — do not assume this
  checkpoint's described state matches `git log`.
- `rust_gateway/.env` (gitignored, real local file) needs
  `WORKSPACE_DEFAULT_PATH=/workspace/default` added manually in any
  fresh checkout — `.env.example` documents it but nothing copies `.env`
  automatically.
