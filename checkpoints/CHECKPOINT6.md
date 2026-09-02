# Checkpoint 6 — read this first in a new session

Continues from `CHECKPOINT5.md`. This session added **per-agent chat
history**: clicking an agent in the AUDIENCE panel now lists that agent's
real sessions, and clicking a session shows its transcript. Read
`CHECKPOINT.md` → `CHECKPOINT3.md` → `CHECKPOINT4.md` → `CHECKPOINT5.md`
first for the base architecture; this file only adds what changed since.

## What this project is

Unchanged — Rust gateway (control plane) in front of per-tenant Docker
containers running Hermes WebUI + wrapper.

## Repository state — IMPORTANT, differs from CHECKPOINT5's claim

`CHECKPOINT5.md` said the working tree was clean. It is **not** clean now,
and was not when this session started. Before this session's work there was
already one commit past checkpoint 5 (`8e79773` Aglack branding / chat
workspace rail / dashboard polish) plus uncommitted in-flight work that is
**not this session's** and was deliberately left alone:

- `?? backend/seeder/modes/company/` + `?? backend/seeder/skills/org-*` —
  a Company-mode seeder tree (CEO/PM/CFO/Builder/Persona/Librarian and
  their skills). Untracked and **untested**: no suite covers those
  `SKILL.md`/`agent.md` files, and nothing has verified they parse through
  `seeder_kit` or apply against a real container. Treat as unverified.
- `?? frontend/src/components/random-avatar.tsx`, `?? frontend/src/lib/avatar.ts` —
  an avatar generator that nothing imports (flagged as dead code by review;
  left untouched because it is pre-existing, unrelated work).
- Modified `rust_gateway` list/delete routes + frontend workspace files —
  the `?health=skip` feature (below), also pre-existing.

Everything from THIS session is likewise uncommitted (no commits were made).

## Pre-existing feature found already in the tree: `?health=skip`

`GET /workspaces?health=skip` returns a pure DB projection with
`healthy: null` on every row instead of running the live per-row
health-check fanout; an unknown `health` value fails closed with
`400 invalid_health_mode` rather than silently defaulting to live. The
frontend's workspace rail uses it to list real workspaces. `healthy`
became `boolean | null` end-to-end. Complete and tested — not this
session's work, but it is what took the gateway from 93 to 96 tests.

## 1. Per-agent chat history (this session's feature)

**The gap**: the AUDIENCE panel rendered `PLACEHOLDER_AUDIENCE` — 22 fake
avatars with no identity and no click handler. There was nothing to click,
and no history API anywhere: the wrapper had no history feature, the
gateway had no history route.

**What was verified before designing** (this drove every decision):

- Upstream already has a full session API and a serious session-list cache
  (`api/route_session_list_cache.py`: TTL, per-profile scoping, in-flight
  coalescing, LRU, invalidation versioning, plus a deliberately longer 45s
  TTL while streaming to avoid rebuild storms — see its comments citing
  real perf incidents). **Reuse it; do not build a second cache.**
- Agents ARE Hermes profiles (the seeder creates one profile per agent).
- Sessions are NOT stored per-profile. They live in one shared store and
  each row carries a `profile` tag; untagged legacy rows are backfilled to
  `"default"` by `all_sessions()` itself. Attribution is therefore a
  filter, not a directory lookup.
- Because of that, **no profile switching is needed at all**. The original
  worry — that per-agent reads would have to mutate the process-global
  active profile and race between tabs — does not apply. Nothing in this
  feature calls `set_request_profile` or `switch_profile`.

### Wrapper — new native feature `features/agent_history/`

`api/v1/agent_history.py`, prefix `/api/wrapper/v1/agent-history`:

- `GET /agents`
- `GET /agents/{name}/sessions?limit=&offset=`
- `GET /agents/{name}/sessions/{session_id}/messages?limit=&offset=`

Design points that matter:

- **Speed is a projection, not a cache.** Upstream `Session.compact()`
  returns 40+ fields per session; the list is projected to exactly 5
  (`session_id`, `title`, `message_count`, `updated_at`, `last_message_at`).
  Transcripts are never included in the list — they load per-session on
  click. A test asserts the exact key set so a future upstream field
  cannot silently leak into the payload.
- **Cross-agent isolation is enforced server-side**: `Session.load()` then
  `_profiles_match()`; a session whose profile tag does not match the
  requested agent returns 404. One agent cannot read another's transcript
  by guessing a session id.
- Attribution uses upstream's own `_profiles_match`, not a string compare,
  so a renamed root profile and legacy untagged rows behave correctly.
- Pagination: limit default 50, hard cap 200; negative or non-integer
  limit/offset → 400 **in the shared envelope** (routes accept them as raw
  strings so FastAPI never emits a raw non-enveloped 422).
- No `schemas.py` — every route is a GET with no request body.

### Gateway — fifth proxy namespace

`workspaces/agent_history_proxy.rs`: a thin root+wildcard handler pair
delegating to `wrapper_prefix_proxy::forward_to_wrapper_namespace`,
registered in `mod.rs` + `app.rs` exactly like the other four. Plan doc at
`docs/agent-history-plan.md` (required by that directory's AGENTS.md).

### Frontend — `features/agent-history/`

Real agents replace `PLACEHOLDER_AUDIENCE`. Click agent → session list;
click session → messages; manual refresh; back/close. Freshness is
**fresh-on-open + manual refresh — no polling, no websockets, no timers**
(deliberate). Every fetch is guarded by a per-request-id generation ref
checked before every `.then`/`.catch`/`.finally`, bumped on workspace
change, agent switch, session switch, back, and close. At ≤1120px the
panel is a dismissible off-canvas drawer (close button + backdrop +
Escape).

## 2. Two real bugs the process caught

**`list_profiles_api()` returns default-only without `hermes_cli`.** The
first implementation listed agents via upstream `list_profiles_api()`. Its
`except ImportError: return [_default_profile_dict()]` fallback silently
hides every real profile when `hermes_cli` is not importable — and it is
NOT importable in the wrapper venv. The endpoint would have returned only
`default` and never listed a seeded agent: the entire point of the route.
A failing test caught it; `list_agents` now enumerates the profiles
directory from the filesystem. `features/agent_config/service.py` already
documented this exact trap for the same reason — the fix follows it.

**Invalid profile names returned 200.** Review found that
`get_hermes_home_for_profile()` deliberately falls back to the BASE home
for a traversal-shaped/invalid name, so `home.is_dir()` was true and a
bogus name was accepted as the root profile. The name is now validated
against upstream's own `_PROFILE_ID_RE` BEFORE the home lookup.

## 3. An "optimization" that was measured, disproved, and reverted

A follow-up asked to optimize profile listing. Two things were examined:

**`list_agents` was already optimal — measured, left alone.** One
`iterdir()`, no file reads, no state.db, no `hermes_cli`: 0.06ms at 5
profiles, 0.28ms at 50, 1.0ms at 200. Adding a cache would buy nothing and
introduce staleness. No change made.

**`list_sessions` "optimization" was WRONG and was reverted.** The premise
looked airtight: `all_sessions()` defaults to
`include_lineage_metadata=True`, we project away every lineage field, and
upstream's own `_enrich_sidebar_lineage_metadata` docstring says
"`/api/sessions` was spending 4.9s on lineage_metadata across 2400+ rows."
Upstream's own sidebar passes `False`. It was implemented, tested, and
green.

Then it was benchmarked against real sessions on disk plus a real
`state.db` (with the exact columns `read_session_lineage_metadata`
requires — without that file the lineage reader returns `{}` immediately
and the benchmark measures nothing, which is the trap the first benchmark
attempt fell into):

```
sessions=100    0.70x   (-0.7 ms/call)
sessions=300    0.60x   (-3.0 ms/call)
sessions=800    0.79x   (-5.6 ms/call)
sessions=2400   0.69x   (-21.2 ms/call)
```

**Slower at every size.** Reason, from reading both branches: the flag
selects between two different state.db strategies, not between "do work"
and "skip work". `True` runs `_enrich_sidebar_lineage_metadata`, which
CAPS its lookup to the top-N most recent rows (`HERMES_WEBUI_LINEAGE_TOP_N`,
default 300). `False` runs `_apply_sidebar_state_db_overrides`, which reads
state.db for **every** row uncapped. The quoted "4.9s" describes an older
uncapped implementation that has since been capped — it does not describe
current behavior.

Reverted; `list_sessions` calls plain `all_sessions()`. A short comment in
the function records the measured numbers so nobody re-attempts it.

Lesson, same shape as CHECKPOINT5's: a plausible optimization backed by an
upstream comment still has to be measured in the regime it claims to
improve. Both tests written for the flag were deleted with it — a passing
test proved only that the flag was passed, never that it was faster.

## 4. Verification (real, no fakes)

Real `docker build`, real gateway binary with the real `DockerCliLauncher`
on an isolated port, real `POST /workspaces` → running container, real
seeding, then real HTTP through gateway → wrapper → upstream:

- `GET /agent-history/agents` before seeding → `[default]`; after seeding
  Simple mode → `[default, pm]`. This is also what proves the
  `list_profiles_api` fix in a container that DOES have `hermes_cli`.
- Two real sessions created via `docker exec` under two different profiles
  (`pm`, `default`), then: each agent's list showed only its own session;
  `pm`'s transcript returned correctly; **both** cross-agent reads
  (`default`→pm's session, `pm`→default's session) returned 404 with no
  data leaked.
- Error paths through the full chain: unknown agent 404, unknown workspace
  `workspace_not_found` 404, `limit=bad` → enveloped 400, negative limit →
  enveloped 400, `limit=9999` → capped at 200, offset paging correct.
- **Measured**, not claimed: ~2–3ms per call end-to-end; the projected
  session list was 198 bytes vs 1118 bytes for upstream's raw
  `/api/sessions` — ~5.6x smaller with only two sessions, and the gap
  widens with real history since 35+ fields per session are dropped.

Teardown removed only this session's container and test image. The two
containers belonging to a separate, unrelated session were left running
untouched (same discipline as CHECKPOINT5).

## Test counts (all green at end of session)

- `backend/wrapper`: **85/85** (69 → 85; 16 new).
- `backend/seeder_kit`: **38/38**.
- `backend/workspace-image`: **5/5**.
- `rust_gateway`: **103/103** (96 → 103; 7 new).
- `frontend`: `npm run build` clean, zero TypeScript errors.

## Process note

All code went through the claude-codex-pipeline required by the root
`AGENTS.md` (Claude authors, Codex validates read-only, never self-approves).
Codex found the invalid-profile-name hole, a raw-422 envelope violation,
dead `schemas.py`, a **P1 stale-request race** in the panel, an
unreachable-below-1120px bug, a missing retry, the missing gateway plan
doc, and then a P1 undismissable drawer introduced by the responsive fix
itself. All were fixed and re-verified.

Note: `codex exec review --uncommitted` in this CLI version (0.151.0)
rejects a custom prompt; use `codex exec --skip-git-repo-check` with the
files/diff inlined instead.

## Known gaps / not done this session

- **No auth gate** on `agent-history` (same pre-existing gap as
  `agent-config`/`agent-seeder`/`onboarding`). It is READ-ONLY and mutates
  nothing, but without a gate any caller can read every agent's transcripts
  for a workspace. Documented in `wrapper/AGENTS.md`.
- **Nothing is committed.** This session made no commits; the tree also
  still holds the unrelated pre-existing work listed above.
- The Company-mode seeder tree remains untracked and unverified.
- History is read-only: no rename/delete/move of sessions.
- No SSE/live streaming. Upstream has `/api/session/stream` and
  `/api/sessions/events` if live updates are ever wanted; that is real work
  through the proxy, not a small change.
- The frontend was verified by `npm run build` + the API it calls being
  proven end-to-end — **not** by a real browser click through
  `/mode/:workspaceId` (same gap CHECKPOINT5 noted for its own work).
- Tooling note: `cargo` lives at `~/.cargo/bin` (not on PATH by default);
  `docker` is at `/Applications/Docker.app/Contents/Resources/bin`; wrapper
  tests need `.venv/bin/python`, not system python (no `seeder_kit` there).
</content>
