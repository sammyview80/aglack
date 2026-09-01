# Changelog 4

Everything changed this session, in commit order. See `CHECKPOINT4.md` in
this same folder for the full narrative/root-cause detail behind each
entry; this file is the terse commit-by-commit record.

## 2026-09-02

### Added

- **`backend/seeder_kit`, a new standalone library.** Turns a folder tree
  into working MCP tools/skills: `tree.py` (mode-scoped parser),
  `discovery.py` (fail-loud tool validation, zero `mcp` dependency),
  `skills.py` (skill-folder copy), `mcp_config.py` (config.yaml entry
  builder), `runner.py` (the actual stdio MCP server — MCP hosts can only
  launch whole server processes, never a single file, so this is the
  aggregator that makes per-tool `.py` files possible at all). Own
  `pyproject.toml`, own 38-test suite, zero Hermes/wrapper knowledge.
  (`backend/seeder_kit/`)

- **`backend/seeder`, the actual seed content.** Mode-scoped from the
  start (`modes/<mode>/agents/<Name>/{soul.md, agent.md, tools/, skills/}`)
  — adding Creator/Company later is purely additive content, no code
  changes. First real content: `modes/simple/agents/PM/` + a global
  `update_soul` tool + a global `tickoff_agent` skill.
  (`backend/seeder/`)

- **Wrapper native routes: `agent_config` + `agent_seeder`.**
  `GET/PUT /api/wrapper/v1/agent-config/{name}/soul|agents-md` —
  always-overwrite SOUL.md + workspace-level AGENTS.md for a named
  profile. `GET /api/wrapper/v1/agent-seeder/modes`,
  `POST .../{mode}/apply[/{agent_name}]` — applies `seeder/`'s content to
  real Hermes profiles via `api.profiles.create_profile_api` +
  `seeder_kit`. Idempotent; unknown/empty mode returns `{"applied": []}`,
  never an error.
  (`backend/wrapper/src/hermes_webui_wrapper/features/agent_config/`,
  `.../features/agent_seeder/`, `.../api/v1/agent_config.py`,
  `.../api/v1/agent_seeder.py`, `backend/wrapper/tests/v1/test_agent_config.py`,
  `.../test_agent_seeder.py`)

- **`rust_gateway` agent-seeder proxy route.**
  `ANY /workspaces/:id/agent-seeder/*path`, structurally identical to
  `onboarding_proxy.rs`, wired via the existing
  `register_workspace_proxy_pair` helper. 5 new tests; the router-coverage
  test extended from three to four proxy features.
  (`rust_gateway/src/workspaces/agent_seeder_proxy.rs`,
  `rust_gateway/src/app.rs`, `rust_gateway/src/workspaces/mod.rs`)

- **Frontend mode-selection screen.** New `/mode/:workspaceId` route —
  `features/agent-seeder/` (api/types/modes-catalog/component). `modes.ts`
  is a data table (`id`/`label`/`description`/optional `run`); the
  component has zero per-mode branching, so adding Creator/Company later
  is one table entry, not a code change.
  (`frontend/src/features/agent-seeder/`, `frontend/src/pages/mode-select-page.tsx`,
  `frontend/src/app/router.tsx`)

- `backend/workspace-image/test_dockerfile_seeder_content.py` — 5
  standalone static-content regression tests for the Dockerfile fix below
  (confirmed to fail before, pass after).

### Fixed

- **"Apply mode" returned upstream's own CSRF error
  (`Cross-origin mismatch - check reverse proxy headers`)**, from a native
  FastAPI route that should never reach upstream's CSRF check at all.
  Root cause, two stacked Dockerfile bugs: (1) `backend/seeder_kit`/
  `backend/seeder` were never `COPY`'d into the workspace image, so a
  built container has no `agent_seeder`/`agent_config` routes and the
  request silently falls through to the proxied catch-all, which DOES run
  upstream's CSRF check; (2) even after adding the COPY lines,
  `uv pip install -e` failed outright — `wrapper/pyproject.toml`'s
  `seeder-kit @ file://../seeder_kit` is a RELATIVE `file://` URL, which
  `uv pip install -e <dir>` cannot resolve from inside a package's own
  metadata (confirmed live by reproducing the exact failure in a
  disposable container). Fixed: `pyproject.toml` now depends on the plain
  name `"seeder-kit"`; `Dockerfile` installs it as its own separate,
  earlier step before the wrapper. Verified with a real, full
  `docker build` + a real run of the built image.
  (`backend/workspace-image/Dockerfile`, `backend/wrapper/pyproject.toml`)

- **New workspace skipped onboarding entirely, landing straight on the
  dashboard.** Three separate navigation bugs, same root cause pattern
  (skip straight to `/` instead of the next required step):
  `create-workspace-page.tsx` (sync-ready create → `/` instead of
  `/onboarding/:id`), `creating-workspace-page.tsx` (async-then-ready →
  same bug), `mode-select-page.tsx` (finish → `/create` instead of `/`).
  Full corrected flow: create → onboarding → mode select → dashboard.
  (`frontend/src/pages/create-workspace-page.tsx`,
  `frontend/src/pages/creating-workspace-page.tsx`,
  `frontend/src/pages/mode-select-page.tsx`, `frontend/AGENTS.md`)

### Refactored

- **Wrapper native-route layer: killed 3 duplicated error classes, 3
  duplicated route `_call` helpers, 2 duplicated yaml load/fail-closed
  blocks, and repeated `Path(__file__).parents[N]` arithmetic.** New
  `features/errors.py` (`FeatureError` base — `OnboardingError`/
  `AgentConfigError`/`AgentSeederError` are now one-line subclasses), new
  `api/envelope.py::service_call()` (the one threadpool+error-mapping
  helper every router now uses), new `features/profile_yaml.py`
  (`load_profile_config`/`save_profile_config`), new
  `config.py::resolve_seeder_root()` (`HERMES_SEEDER_ROOT` env override,
  documented in `.env.example`). Zero behavior change — 65/65 wrapper
  tests green before and after.
  (`backend/wrapper/src/hermes_webui_wrapper/features/errors.py`,
  `.../features/profile_yaml.py`, `.../api/envelope.py`, `.../config.py`,
  `.../api/v1/onboarding.py`, `.../api/v1/agent_config.py`,
  `.../api/v1/agent_seeder.py`, `.../features/onboarding/service.py`,
  `.../features/agent_config/service.py`, `.../features/agent_seeder/service.py`,
  `backend/wrapper/.env.example`)

- **Frontend: killed 2 duplicated gateway-error-message maps +
  `isInvalidWorkspace` predicates.** New `lib/workspace-errors.ts`
  (`GATEWAY_WORKSPACE_ERRORS` + `isInvalidWorkspace()`), spread into each
  feature's own error map instead of re-declared per feature.
  (`frontend/src/lib/workspace-errors.ts`,
  `frontend/src/features/onboarding/components/onboarding-wizard.tsx`,
  `frontend/src/features/agent-seeder/components/mode-select.tsx`)

### Docs

- `rust_gateway/AGENTS.md` structure section updated for the fourth proxy
  feature; `backend/wrapper/AGENTS.md` updated for the new features +
  shared chokepoints + a stronger "no auth gate" warning now that
  `agent-seeder` has a real UI caller; `frontend/AGENTS.md` updated for
  the new screen/route + the fixed navigation contract; `backend/seeder/README.md`
  and `backend/seeder_kit/README.md` written from scratch.
- `.gitignore` — `ai-website-cloner-template/` (unrelated scratch project
  at the repo root) is now ignored.
- `checkpoints/CHECKPOINT4.md` added covering this session in full
  narrative form.

### Also committed this session (not authored this session)

- A pre-existing chat/threads-shell UI (24 frontend files — `app-shell.tsx`,
  `chat-shell.tsx`, `console-shell.tsx`, `slack-workspace-shell.tsx`,
  `threads-shell.tsx`, `workspace-chat.tsx`/`workspace-chat-page.tsx`,
  theme/brand/style updates, `page-fallback.tsx`, `button.tsx`/`input.tsx`
  additions) was already staged in the index from an earlier, unrelated
  session before this one started. Committed as its own separate commit
  per explicit instruction to stage and commit everything — not reviewed
  or authored as part of this session's work.
</content>
