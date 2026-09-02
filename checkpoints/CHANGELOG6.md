# Changelog 6

Everything changed this session. See `CHECKPOINT6.md` in this same folder
for the full narrative/root-cause detail behind each entry; this file is
the terse record.

**Nothing in this session was committed** — every entry below is
uncommitted working-tree state.

## 2026-09-02 (continued from Changelog 5)

### Added

- **Per-agent chat history — wrapper.** New native feature
  `features/agent_history/service.py` + router `api/v1/agent_history.py`
  (mounted in `api/router.py`), prefix `/api/wrapper/v1/agent-history`:
  `GET /agents`, `GET /agents/{name}/sessions`,
  `GET /agents/{name}/sessions/{session_id}/messages`. An "agent" is a
  Hermes profile. Pure reads — never calls `set_request_profile` or
  `switch_profile`, so no process/thread-global state is mutated.
  Sessions are attributed with upstream's own `_profiles_match` (handles
  default/renamed-root aliasing and legacy untagged rows). Session rows
  are projected from upstream's 40+-field `Session.compact()` down to
  exactly 5 keys (`session_id`, `title`, `message_count`, `updated_at`,
  `last_message_at`); transcripts load only per-session on click.
  Cross-agent isolation enforced: a session whose profile tag does not
  match the requested agent returns 404. Pagination limit default 50 /
  hard cap 200; negative or non-integer limit/offset → 400 in the shared
  envelope (routes take limit/offset as raw strings so FastAPI never
  emits a raw non-enveloped 422). No `schemas.py` — all GETs, no request
  body.
  (`backend/wrapper/src/hermes_webui_wrapper/features/agent_history/`,
  `.../api/v1/agent_history.py`, `.../api/router.py`,
  `backend/wrapper/tests/v1/test_agent_history.py`,
  `backend/wrapper/AGENTS.md`)

- **Per-agent chat history — gateway.** Fifth per-workspace proxy
  namespace `ANY /workspaces/:id/agent-history/*path`: a thin
  root+wildcard handler pair delegating to
  `wrapper_prefix_proxy::forward_to_wrapper_namespace`, registered via
  `register_workspace_proxy_pair`. Plan doc added as required by that
  directory's AGENTS.md.
  (`rust_gateway/src/workspaces/agent_history_proxy.rs`,
  `rust_gateway/src/workspaces/mod.rs`, `rust_gateway/src/app.rs`,
  `rust_gateway/docs/agent-history-plan.md`, `rust_gateway/AGENTS.md`)

- **Per-agent chat history — frontend.** New feature
  `src/features/agent-history/` (`api.ts`, `types.ts`,
  `components/agent-history-panel.tsx`, `components/relative-time.ts`).
  The AUDIENCE panel in `threads-shell.tsx` now renders REAL seeded
  agents instead of the hardcoded `PLACEHOLDER_AUDIENCE` list of 22 fake
  avatars: click an agent → its session list, click a session → its
  messages, with manual refresh and back/close. Freshness is deliberately
  fresh-on-open + manual refresh — no polling, no websockets, no timers.
  snake_case→camelCase remap lives in the feature's `api.ts`.
  (`frontend/src/features/agent-history/`,
  `frontend/src/components/threads-shell.tsx`,
  `frontend/src/styles/threads-app.css`, `frontend/AGENTS.md`)

### Fixed

- **`list_profiles_api()` would have hidden every real agent.** The first
  `list_agents` implementation used upstream `list_profiles_api()`, whose
  `except ImportError: return [_default_profile_dict()]` fallback silently
  returns only a synthetic `default` row when `hermes_cli` is not
  importable — and it is not importable in the wrapper venv. The endpoint
  would have returned only `default` and never listed a seeded agent.
  Caught by a failing test. `list_agents` now enumerates the profiles
  directory from the filesystem, matching the reasoning
  `features/agent_config/service.py` already documents for the same trap.
  (`backend/wrapper/src/hermes_webui_wrapper/features/agent_history/service.py`)

- **Invalid/traversal-shaped profile names returned 200.** Found in
  review: `get_hermes_home_for_profile()` deliberately falls back to the
  BASE Hermes home for an invalid name, so `home.is_dir()` was true and a
  bogus name was accepted as the root profile. Names are now validated
  against upstream's own `_PROFILE_ID_RE` BEFORE the home lookup.
  (same file)

- **Raw non-enveloped 422 on malformed pagination.** `limit=bad` produced
  FastAPI's own `{"detail": ...}` instead of the shared envelope,
  violating the wrapper's envelope rule. Routes now accept `limit`/
  `offset` as raw strings and parse them in the service, so bad input
  becomes an enveloped 400. (`.../api/v1/agent_history.py`, service.py)

- **P1 stale-request race in the history panel.** Switching agents fast,
  double-refreshing, closing the panel, or changing workspace could let a
  superseded in-flight response overwrite current state or fire a stale
  toast. Every fetch is now guarded by a per-request-id generation ref
  checked before every `.then`/`.catch`/`.finally`, bumped on workspace
  change, agent switch, session switch, back, and close.
  (`frontend/src/features/agent-history/components/agent-history-panel.tsx`)

- **Feature was unreachable below 1120px** (`display:none` on the audience
  panel), then — after the first responsive fix — **the drawer could not
  be dismissed** (it covered its own toggle, with no close control,
  backdrop, or Escape handler). Now an off-canvas drawer with all three
  dismissal affordances; desktop ≥1120px layout unchanged.
  (`frontend/src/styles/threads-app.css`,
  `frontend/src/components/threads-shell.tsx`)

- **No retry when the agent list itself failed to load** — the user was
  stuck in an error state. Retry control added.
  (`agent-history-panel.tsx`)

- **Dead code:** unused `features/agent_history/schemas.py` deleted (all
  three routes are GETs with no request body).

### Verified (real end-to-end, no fakes)

- Real `docker build`; real gateway binary with the real
  `DockerCliLauncher` on an isolated port; real `POST /workspaces` →
  running container; real Simple-mode seeding; real HTTP through
  gateway → container-wrapper → upstream.
- `GET /agent-history/agents` → `[default]` before seeding, `[default, pm]`
  after — this is what proves the `list_profiles_api` fix inside a
  container that DOES have `hermes_cli`.
- Two real sessions created under two different profiles via `docker exec`:
  each agent listed only its own session, `pm`'s transcript returned
  correctly, and BOTH cross-agent reads returned 404 with no data leaked.
- Error paths through the full chain: unknown agent 404, unknown workspace
  404, `limit=bad` → enveloped 400, negative limit → enveloped 400,
  `limit=9999` → capped at 200, offset paging correct.
- Measured: ~2–3ms per call end-to-end; projected session list 198 bytes
  vs 1118 bytes for upstream's raw `/api/sessions` (~5.6x smaller with
  only two sessions).
- Teardown removed only this session's container and test image; two
  containers from a separate unrelated session were left untouched.

### Measured, disproved, reverted

- **`list_sessions` lineage-skip optimization: reverted, it was slower.**
  Passing `include_lineage_metadata=False` to upstream `all_sessions()`
  looked like a clear win (we project away every lineage field, and
  upstream's own sidebar passes `False`), but benchmarking against real
  sessions plus a real `state.db` measured it SLOWER at every size:
  0.70x @100, 0.60x @300, 0.79x @800, 0.69x @2400 sessions (up to
  -21.2 ms/call). The flag picks between two state.db strategies, not
  between doing and skipping work: `True` caps lineage enrichment at
  top-300, `False` reads state.db for every row uncapped. The "4.9s"
  figure in upstream's docstring describes an older uncapped
  implementation. Reverted to plain `all_sessions()`, with the measured
  numbers recorded in a comment so it is not retried. Both tests written
  for the flag were deleted with it.
  (`backend/wrapper/src/hermes_webui_wrapper/features/agent_history/service.py`,
  `backend/wrapper/tests/v1/test_agent_history.py`)

- **`list_agents` needed no optimization** — measured 0.06ms @5 profiles,
  0.28ms @50, 1.0ms @200: one `iterdir()`, no file reads, no state.db, no
  `hermes_cli`. A cache would add staleness for no gain. Unchanged.

### Test counts

- `backend/wrapper`: 69 → **85**.
- `rust_gateway`: 96 → **103**.
- `backend/seeder_kit`: **38** (unchanged).
- `backend/workspace-image`: **5** (unchanged).
- `frontend`: `npm run build` clean, zero TypeScript errors.

### Docs

- `checkpoints/CHECKPOINT6.md` added.
- `backend/wrapper/AGENTS.md`, `frontend/AGENTS.md`,
  `rust_gateway/AGENTS.md` updated (structure trees, new "Agent History
  API" section, and agent-history added to the known no-auth-gate section
  — noted as read-only, unlike the mutating routes).
</content>
