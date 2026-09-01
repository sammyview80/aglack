# Checkpoint 5 — read this first in a new session

Continues from `CHECKPOINT4.md`. This session added a per-agent
workspace-creation feature, then ran the deepest real end-to-end test
possible (real Docker, real gateway, real container, real HTTP through
the whole chain — no fakes anywhere) and found a genuine bug that every
unit test had missed. Read `CHECKPOINT.md` → `CHECKPOINT3.md` →
`CHECKPOINT4.md` first for the base architecture and prior features; this
file only adds what changed since.

## What this project is

Unchanged — Rust gateway (control plane) in front of per-tenant Docker
containers running Hermes WebUI + wrapper.

## Repository / commit state

Everything in this checkpoint is committed:
- `9ae801c` `feat(wrapper): auto-create a real per-agent workspace on seed`
- `b925abb` `fix(gateway): chown /workspace parent, not just default, for per-agent dirs`

Working tree is clean (`git status --short` empty) as of this checkpoint.

## 1. Per-agent workspace auto-creation (`feat(wrapper)`, commit `9ae801c`)

**The gap**: `create_profile_api` never sets a workspace for a newly
created Hermes profile. Every seeded agent's `agent.md` silently skipped
writing `AGENTS.md` (`agent_md_updated: false` /
`agent_md_skipped_reason`) until a workspace was configured by hand —
true since the agent-seeder feature was first built in `CHECKPOINT4.md`'s
session, only now fixed at the source.

**The fix**:
- `config.py`: new `resolve_agent_workspaces_root()` — derives the
  per-agent workspaces root from `HERMES_WEBUI_DEFAULT_WORKSPACE`'s own
  PARENT directory (the env var the real container's boot script sets to
  `/workspace/default`), never a second independently-hardcoded
  `/workspace` default. Fails closed (`RuntimeError`) when that env var
  is unset — matches this project's existing required-config convention
  (see `Settings.from_env()`'s `HERMES_FRONTEND_ORIGIN` check for the
  same pattern).
- `features/agent_seeder/service.py`: new `_ensure_agent_workspace`, run
  right after profile creation, before soul/agent-instructions. For a
  newly created profile with no workspace configured yet, creates a real
  `<root>/<agent-slug>/` directory (e.g. `/workspace/pm`, a sibling of
  `/workspace/default`) and writes it into that profile's `config.yaml`
  as `workspace`. Never overwrites an already-configured workspace —
  same "never clobber what's already set" rule every other seeder step
  follows. Outside a real container (env var unset), this is a soft
  no-op — `agent.md` then falls back to the pre-existing graceful skip
  path, not a hard failure of the whole apply.

69/69 wrapper tests green (5 new). Docs updated in `seeder/README.md`,
`wrapper/AGENTS.md`, `.env.example`.

## 2. Real end-to-end test (no fakes) found a genuine bug

Ran the deepest possible verification: real `rust_gateway` binary with
its REAL `DockerCliLauncher` (not `FakeLauncher`), pointed at a freshly
rebuilt `hermes-workspace:dev` image, driving the actual
`POST /workspaces` → real `docker create`/`docker start` → a genuinely
running container — then real HTTP through the full chain
(`gateway → container's wrapper → upstream api.profiles → real
filesystem`), exactly as a real browser session would.

**Result**: `POST /workspaces/:id/agent-seeder/simple/apply` failed with
`agent_seeder_workspace_create_failed` /
`"[Errno 13] Permission denied: '/workspace/pm'"` — a bug the entire
unit-test suite (67 wrapper tests, 91 gateway tests, all green) had
completely missed, because none of them exercise a real container's
actual filesystem permissions.

**Root cause, confirmed live via `docker exec`**: the container boot
script's `chown -R abc:abc {workspace_default_path}` (see
`boot_script.rs`) only ever chowned the LEAF directory
(`/workspace/default`), never its parent (`/workspace`) — `/workspace`
itself stayed `drwxr-xr-x root root`. `_ensure_agent_workspace` (section
1 above) needs to `mkdir` a SIBLING directory under that parent, as
`abc` — impossible with the parent still root-owned.

**Why the existing test didn't catch it**: `boot_script.rs` already had
an assertion `script.contains("chown -R abc:abc /workspace")` with a
comment claiming this proved `/workspace` gets chowned — but
`.contains()` on that substring is ALSO true for the actual (buggy)
output `chown -R abc:abc /workspace/default`, since the shorter string is
a literal prefix of the longer one. The test had been silently
non-discriminating since it was first written (see `CHANGELOG3.md`) —
this session replaced it with an exact line-match assertion.

**Fix** (`fix(gateway)`, commit `b925abb`): new
`workspace_chown_target(workspace_default_path)` in `boot_script.rs` —
computes the PARENT directory to chown (e.g. `/workspace` for
`/workspace/default`), falling back to the path itself only if the
parent would resolve to the filesystem root `/` (never chown `/`). The
`mkdir` target is unchanged (still the original leaf path); only the
`chown` target changed.

**Re-verified for real after the fix** (fresh gateway binary rebuild,
fresh container, not the same one the bug was found in): `docker exec`
confirmed `/workspace` is now `abc:abc`-owned; the real
`POST .../agent-seeder/simple/apply` call succeeded —
`workspace_created: "/workspace/pm"`, `agent_md_updated: true`; `docker
exec cat` confirmed `/workspace/pm/AGENTS.md`,
`/config/.hermes/profiles/pm/config.yaml` (`workspace: /workspace/pm`),
`/config/.hermes/profiles/pm/SOUL.md`, and the seeded skills all
genuinely exist on the real container's filesystem; a second apply call
confirmed idempotency (`profile_created: false`, no repeated
`workspace_created`).

93/93 rust_gateway tests green (2 new direct unit tests for
`workspace_chown_target` plus the corrected exact-match assertion).

## Lesson for future sessions

Every unit test suite in this repo (wrapper, seeder_kit, gateway) can be
100% green and a real container can still be broken, because unit tests
mock or fake the exact boundary (real container filesystem permissions,
in this case) where the bug actually lived. When a change touches
anything the container's boot script sets up (env vars, directory
ownership, mounted paths), a real `docker build` + real
`POST /workspaces` + `docker exec` verification is not optional
extra-credit — it is how this exact bug was found. `FakeLauncher`-based
gateway tests and standalone-wrapper-process smoke tests (both used
extensively in `CHECKPOINT4.md`'s session) are valuable and fast, but do
not exercise container filesystem permissions at all — they are not a
substitute for the real thing when the real thing is available.

## Known gaps / not done this session

- Same gaps as `CHECKPOINT4.md`: no auth gate on `agent-config`/
  `agent-seeder`; Creator/Company modes still have no backend content;
  no `trigger_agent`/`trigger_kanban`-style tools (out of scope, no
  backing mechanism in this pinned upstream checkout).
- The real end-to-end test in section 2 used manually-crafted `curl`
  calls against the gateway's real HTTP API, not an actual browser
  click through the frontend's `/mode/:workspaceId` screen — the
  frontend code path itself (React component → `apiFetch` →
  gatewayUrl()) was not exercised by a real browser in this session,
  only its equivalent HTTP shape.
- Every OTHER pre-existing test container / gateway process found
  running in this environment during cleanup (belonging to a separate,
  unrelated session) was deliberately left untouched — only this
  session's own test processes/containers were created and torn down.

## Test counts (all real, all green at end of session)

- `backend/wrapper`: `pytest` → **69/69**.
- `backend/seeder_kit`: `pytest` → **38/38**.
- `backend/workspace-image/test_dockerfile_seeder_content.py` → **5/5**.
- `rust_gateway`: `cargo test` → **93/93**.
- `frontend`: `npm run build` → clean, zero TypeScript errors.
- Real end-to-end (no fakes): real `docker build` of `hermes-workspace:dev`;
  real gateway binary with real `DockerCliLauncher`; a genuinely running
  Docker container created via the real `POST /workspaces` API; real
  HTTP `POST .../agent-seeder/simple/apply` through the full
  gateway → container-wrapper → upstream chain; every claimed artifact
  (`/workspace/pm`, its `AGENTS.md`, the profile's `config.yaml`/`SOUL.md`,
  seeded skills) verified via `docker exec` directly against the real
  container filesystem, not inferred from the HTTP response alone;
  idempotent re-apply verified the same way.
</content>
