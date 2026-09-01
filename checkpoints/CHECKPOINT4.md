# Checkpoint 4 — read this first in a new session

Continues from `CHECKPOINT3.md`. This session built the whole
seed/mode-selection feature from zero: a standalone `seeder_kit` library,
a `seeder/` content tree, wrapper native routes to apply it, a
`rust_gateway` proxy route so the frontend can reach it, a real
mode-selection screen wired into the post-onboarding flow, a real Docker
build fix, and a cleanup refactor across the wrapper's native-route layer.
Read `CHECKPOINT.md`/`CHECKPOINT3.md` first for the base architecture;
this file only adds what changed since.

## What this project is

Unchanged — Rust gateway (control plane) in front of per-tenant Docker
containers running Hermes WebUI + wrapper.

## Repository / commit state

Everything in this checkpoint is committed, grouped by feature/fix, in
this session (see commit log below for exact hashes/messages). A
pre-existing chat/threads-shell UI (24 frontend files) was already staged
in the index from an earlier, unrelated session before this one started —
it is committed too (explicit instruction: "stage all... commit for all
files"), as its own separate commit, since none of that code was written
or reviewed in this session.

`ai-website-cloner-template/` (an unrelated scratch project at the repo
root) is now gitignored — it was untracked noise in `git status`, never
part of this repo's own work.

## 1. `seeder_kit` — new standalone library (`backend/seeder_kit/`)

A framework-agnostic Python package, own `pyproject.toml`, own test suite
(38 tests, 0.1s, zero dependencies beyond the standard library). Turns a
plain folder tree into working MCP tools/skills for an agent:

- `tree.py` — `parse_tree(root, mode)` / `available_modes(root)`. Reads a
  mode-scoped folder layout (`modes/<mode>/agents/<Name>/...`) into
  `SeederTree`/`AgentSpec` dataclasses. Pure read, no side effects.
- `discovery.py` — `discover_tools_in_dirs(dirs)`. Imports every `.py`
  file, validates `TOOL_NAME`/`TOOL_DESCRIPTION`/`TOOL_INPUT_SCHEMA`/
  `handle`, raises `ToolDiscoveryError` on any duplicate name or malformed
  module. No `mcp` import — usable for pure validation.
- `skills.py` — `copy_skill_dirs()`. Copies `<name>/SKILL.md` folders.
- `mcp_config.py` — `build_mcp_server_entry()`. Builds the `mcp_servers:`
  config.yaml entry pointing at `runner.py`.
- `runner.py` — the actual stdio MCP server (needs the optional `[mcp]`
  extra). This is the piece that makes "drop a `.py` file in a folder" a
  real MCP tool at all — MCP hosts can only launch whole server
  *processes*, never a single file.

Zero Hermes/wrapper knowledge anywhere in this package — see its own
`README.md` for the full module map and design principles.

## 2. `seeder/` — the actual content tree (`backend/seeder/`)

```
seeder/
  tools/update_soul.py              global tool, every mode/agent gets it
  skills/tickoff_agent/SKILL.md     global skill
  modes/
    simple/agents/PM/               the only mode with real content today
      soul.md, agent.md, tools/, skills/task_assign/SKILL.md
```

Mode-scoped from the start (`modes/<mode>/agents/...`) — adding a second
real mode (Creator/Company) is purely additive: populate
`modes/<mode>/agents/...`, no code changes anywhere. See its own
`README.md` for the full contract (why `agent.md` maps to a WORKSPACE-level
AGENTS.md not a profile-level one — this pinned upstream checkout has no
per-profile AGENTS.md concept at all; why profile names get lowercased
from the human-readable folder name).

## 3. Wrapper native routes — `agent_config` + `agent_seeder`

Two new native FastAPI features in `backend/wrapper`, following the
existing `features/onboarding/` reference pattern:

- **`agent_config`** (`GET/PUT /api/wrapper/v1/agent-config/{name}/soul`,
  `.../agents-md`) — always-overwrite SOUL.md + workspace AGENTS.md for a
  named profile (no skip-if-exists guard, unlike upstream's own
  `org_set_agent_soul`-class tools in a LATER snapshot this checkout
  doesn't have).
- **`agent_seeder`** (`GET /api/wrapper/v1/agent-seeder/modes`,
  `POST .../{mode}/apply[/{agent_name}]`) — thin Hermes-specific glue that
  parses `seeder/` via `seeder_kit.parse_tree`, then calls
  `api.profiles.create_profile_api` + `agent_config.service` +
  `seeder_kit.copy_skill_dirs`/`discover_tools_in_dirs`/
  `build_mcp_server_entry` to actually create/update real profiles.
  Idempotent (never re-creates or destroys an existing profile); mode is a
  required URL path segment; an unknown/empty mode returns
  `{"applied": []}`, never an error.

`HERMES_SEEDER_ROOT` env var overrides the seeder tree location (defaults
to the sibling `seeder/` directory, same convention as
`HERMES_WEBUI_UPSTREAM`).

## 4. Wrapper cleanup refactor — shared error/yaml/route chokepoints

Done AFTER the features above, zero behavior change (65/65 wrapper tests
green before and after):

- `features/errors.py` (new) — `FeatureError` base class. The three
  previously-duplicated identical error classes (`OnboardingError`/
  `AgentConfigError`/`AgentSeederError`) are now one-line subclasses.
- `api/envelope.py` — new `service_call()` helper: the ONE
  threadpool-hop + `FeatureError`→error-envelope mapping every native
  route handler uses. Deleted the 3 duplicated per-router `_call` copies.
- `features/profile_yaml.py` (new) — `load_profile_config`/
  `save_profile_config`. The one read/write path for a profile's
  `config.yaml`; killed 2 duplicated `yaml.safe_load`+fail-closed blocks.
- `config.py` — `resolve_seeder_root()` (the `HERMES_SEEDER_ROOT` env
  override) + `_wrapper_project_root()` as the one place sibling-directory
  path arithmetic exists (both `upstream/` and `seeder/` defaults derive
  from it now, instead of each file re-counting `Path(__file__).parents[N]`).

## 5. `backend/workspace-image/Dockerfile` — real build fix, verified live

**Bug found live**: clicking "Apply mode" in the browser produced
`{"error": "Cross-origin mismatch - check reverse proxy headers"}` — an
upstream CSRF error, from a route that should never reach upstream's CSRF
check at all (native FastAPI routes bypass it entirely). Root-caused to
TWO stacked Dockerfile bugs:

1. `Dockerfile` never `COPY`'d `backend/seeder_kit`/`backend/seeder` into
   the image — a container built from it has no `agent_seeder`/
   `agent_config` routes, so requests fall through to the proxied
   catch-all, which DOES run upstream's CSRF check.
2. Even after adding the COPY lines, `uv pip install -e /opt/hermes-webui/wrapper`
   failed outright: `wrapper/pyproject.toml` declared
   `seeder-kit @ file://../seeder_kit` — a RELATIVE `file://` URL, which
   `uv pip install -e <dir>` (non-project mode) cannot resolve from inside
   a package's own metadata, even with a correct working directory
   (reproduced live in a disposable container to confirm).

**Fix**: `wrapper/pyproject.toml` now depends on the plain name
`"seeder-kit"` (no URL). `Dockerfile` installs `seeder_kit` as its own
separate, earlier `uv pip install -e` step, before installing the wrapper.

**Verified for real**: reproduced the exact `uv` failure in a disposable
Alpine container; confirmed the two-step fix in the same container; ran
the ACTUAL full `docker build` (`hermes-workspace:dev`, succeeded,
2.9GB); ran the ACTUAL built image and confirmed `seeder_kit`/
`agent_seeder`/`agent_config` all import cleanly and
`/opt/hermes-webui/seeder` exists exactly where runtime code expects it.

`backend/workspace-image/test_dockerfile_seeder_content.py` (new,
standalone, no `docker build` needed) — 5 static-content regression
tests; confirmed to fail against the pre-fix Dockerfile, pass after.

## 6. `rust_gateway` — new agent-seeder proxy route

`workspaces/agent_seeder_proxy.rs` (new) — `ANY /workspaces/:id/agent-seeder/*path`,
structurally identical to `onboarding_proxy.rs` (same root/wildcard route
pair, same `resolve_ready_workspace` + `forward_to` pattern). Wired into
`app.rs` via the existing `register_workspace_proxy_pair` helper — zero
new abstraction needed. 5 new tests + the router's own
`every_proxy_feature_prefix_is_reachable_through_the_real_router` test
extended to cover it (now checks FOUR proxy features, not three).
`cargo test`: 91/91.

## 7. Frontend — mode-selection screen + fixed post-create navigation

**New feature** (`features/agent-seeder/`):
- `api.ts`/`types.ts` — calls `${gatewayUrl()}/workspaces/:id/agent-seeder/...`
  only (never the wrapper directly, per this project's own rule).
- `modes.ts` — the `MODES` catalog (`id`/`label`/`description`/optional
  `run`). Adding Creator/Company later is a data-table entry, not a new
  code branch.
- `components/mode-select.tsx` — one generic `runMode()` dispatch, zero
  per-mode `if` branches.
- `pages/mode-select-page.tsx` — new `/mode/:workspaceId` route.

**Real navigation bug found and fixed**: creating a workspace (both the
synchronous-ready path and the async-then-ready path) redirected straight
to the dashboard (`/`), completely skipping onboarding. Same bug existed
a second time in `mode-select-page.tsx` (finishing mode selection sent
the user back to `/create` instead of `/`). Fixed all three:
`create-workspace-page.tsx`, `creating-workspace-page.tsx`,
`mode-select-page.tsx`. Full corrected flow now: **create → onboarding
(model setup) → mode select → dashboard**. Documented as a load-bearing
navigation contract in `frontend/AGENTS.md` so it doesn't regress again.

**Cleanup**: `lib/workspace-errors.ts` (new) — `GATEWAY_WORKSPACE_ERRORS` +
`isInvalidWorkspace()`, replacing two duplicated copies in
`onboarding-wizard.tsx` and `mode-select.tsx`.

## Known gaps / not done this session

- No auth gate on any of the new native wrapper routes
  (`agent-config`/`agent-seeder`) — documented explicitly in
  `wrapper/AGENTS.md`'s "Known current gap" section. `agent-seeder` in
  particular can create/rewrite profiles in one call and now has a real
  UI caller — treat as at least as sensitive as onboarding's own mutation
  endpoints.
- Creator/Company modes are UI-visible but have no backend content
  (`seeder/modes/creator|company/` don't exist yet) — `MODES` in
  `modes.ts` marks them unavailable (no `run`) on purpose.
- `trigger_agent`/`trigger_kanban`-style cross-agent tools were
  deliberately NOT built — this pinned upstream checkout has no
  cross-session trigger mechanism and no plain-function kanban API to
  wrap; building them would mean inventing whole subsystems out of scope
  for this session.
- No Docker available in the sandboxed dev environment this session ran
  in for most of the work — the real Docker build/run verification
  (section 5) was done via direct user collaboration (user ran
  `docker build`, agent then got shell access to `docker` once the user
  confirmed Docker Desktop was healthy).

## Test counts (all real, all green at end of session)

- `backend/wrapper`: `pytest` → **65/65**.
- `backend/seeder_kit`: `pytest` → **38/38** (standalone, no upstream
  checkout needed).
- `backend/workspace-image/test_dockerfile_seeder_content.py` → **5/5**
  (standalone script, no test runner wired in yet).
- `rust_gateway`: `cargo test` → **91/91**.
- `frontend`: `npm run build` → clean, zero TypeScript errors.
- Additionally verified via real live processes (not just unit tests):
  real wrapper + real gateway as live processes on real ports, a fake-ready
  workspace row seeded via the gateway's own `WorkspaceStore` API, real
  HTTP requests through the full `gateway → wrapper → api.profiles` chain,
  including the mode-scoped URL shape and the `HERMES_SEEDER_ROOT`
  override.
</content>
