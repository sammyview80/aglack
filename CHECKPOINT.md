# Checkpoint — read this first in a new session

This file exists so a fresh agent session (or you) can resume exactly
where things stand, without re-reading prior chat history. It is
organized BY SUBSYSTEM (not chronologically by session) and reflects
VERIFIED, tested state — not plans, not assumptions. Where something is
explicitly unfinished, it's labeled "NOT YET BUILT," not glossed over.

A prior chronological version of this file (5 stacked "session update"
sections, ~930 lines) was consolidated into this one during a refactor
pass — every verified fact from that version is preserved below, just
reorganized. If you need the exact session-by-session narrative for some
reason, it's in this file's git history.

## What this project is

A revamp of an existing Hermes WebUI-based product into a scalable,
multi-tenant SaaS shape:

```
Rust gateway (stateful control plane: auth/billing/tenant registry, future)
       │
       ▼
per-tenant Docker container (webtop desktop + Hermes Agent + Hermes WebUI)
```

Full target architecture and open questions:
`backend/wrapper/docs/rust-gateway-architecture.md` — the "why" behind the
whole shape (Stage 1/2/3 scaling plan, container lifecycle questions,
etc.). This checkpoint is "what exists and is tested right now"; that doc
is "where it's going."

## Repository state

- Location: `/Users/saman/Documents/personal/hermano/revamp/`
- Git: 3 commits, no remote configured, nothing pushed anywhere (explicit
  user choice — commit locally only, for now). Ask before ever pushing.
- Sibling to the ORIGINAL, separate project at
  `/Users/saman/Documents/personal/hermano/backend` and
  `/Users/saman/Documents/personal/hermano/frontend` — untouched by this
  work except as a read-only reference (e.g. the original
  `_server_workspace_boot_command` boot-script pattern, the original
  create-workspace UI). Do not confuse the two — `revamp/` is the new one.

## Architecture at a glance

```
revamp/
├── CHECKPOINT.md              ← this file
├── .env.shared / .env.shared.example
├── run.sh                     ← starts gateway+test_backend+frontend together
├── backend/
│   ├── UPSTREAM.md            ← pin provenance + update procedure
│   ├── upstream/               ← untouched pinned clone of nesquena/hermes-webui
│   │                             (gitignored from this repo)
│   ├── workspace-image/Dockerfile  ← multi-stage: webtop + Hermes Agent + wrapper
│   └── wrapper/                ← FastAPI wrapper, runs upstream in-process
│       ├── AGENTS.md            ← READ FIRST for wrapper work
│       └── src/hermes_webui_wrapper/  (app.py, config.py, upstream.py,
│                                        runtime.py, transport/, api/, features/)
├── rust_gateway/                ← Rust/axum gateway
│   ├── AGENTS.md                ← READ FIRST for rust_gateway work
│   ├── migrations/              0001_workspace_creations, 0002_add_host_port,
│   │                             0003_add_desktop_port
│   └── src/
│       ├── config.rs             (THE ONLY place env vars are read)
│       ├── app.rs                (route table, CORS, router-registration helper)
│       ├── response.rs           (shared {ok,data}/{ok,error} envelope)
│       ├── db/mod.rs             (SQLite connect + auto-migrate)
│       ├── proxy/{mod.rs,forward.rs}   (byte-level forwarding, shared by
│       │                                the fixed-backend AND per-workspace paths)
│       └── workspaces/
│           ├── mod.rs             create_workspace: the one idempotency decision point
│           ├── route.rs           POST /workspaces
│           ├── store.rs           SQLite persistence (idempotency + ports)
│           ├── container.rs       ContainerLauncher trait; DockerCliLauncher = real
│           ├── resolve.rs         shared workspace_id → ready-ports validation
│           ├── onboarding_proxy.rs    /workspaces/:id/onboarding/*
│           ├── hermes_webui_proxy.rs  /workspaces/:id/hermes-webui/*
│           ├── desktop_proxy.rs       /workspaces/:id/desktop/* (+ real WS relay)
│           └── test_support.rs    shared test-only setup helpers (#[cfg(test)])
└── frontend/                     ← Vite + React 19 + TypeScript
    └── src/
        ├── app/{app.tsx,router.tsx,providers.tsx,error-boundary.tsx,toaster.tsx}
        ├── features/{workspace,onboarding,theme}/
        ├── pages/{create-workspace-page,creating-workspace-page,onboarding-page,not-found-page}.tsx
        ├── components/{ui/*, brand-mark, form-field, page-fallback, ...}
        └── lib/{api.ts, env.ts, handle-error.ts, utils.ts}
```

## rust_gateway — what's built and verified

**`cargo test`: 74/74 passing.** Run from `rust_gateway/`:
```bash
export PATH="$HOME/.cargo/bin:$PATH"   # cargo not on default PATH on this machine
cargo test
```

### `POST /workspaces`

Body: `{ "name": "my-workspace", "password": "optional" }` — matches the
original project's frontend contract. `password` accepted but unused
(no auth built yet). No `kind` field (explicitly removed per user
instruction).

**Idempotency:** workspace `name` IS the idempotency key.
- Same name, previous attempt `status: ready` → **409
  `workspace_name_taken`** (a name collision, not a retry — deliberately
  reversed from an earlier "silently return the existing result" design,
  per direct user request. A caller has no way to tell "you got your own
  workspace back" from "you got someone else's" otherwise).
- Same name, previous attempt `status: creating` or `status: failed` →
  RETRIES using the same `workspace_id` (regression test:
  `a_key_whose_launch_failed_is_retried_on_the_next_call_with_the_same_key`).

**Response envelope** (`src/response.rs`), used by every route this
gateway itself produces JSON for (NOT the catch-all `proxy::forward`,
which relays an upstream body verbatim):
```
success: { "ok": true, "data": <T> }
error:   { "ok": false, "error": { "code": "...", "message": "..." } }
```

### `GET /workspaces` — list, with a live health check per row

Plan doc: `docs/list-workspaces-plan.md`. Response:
`{ ok: true, data: { workspaces: [{ workspace_id, name, status, healthy,
host_port, desktop_port, created_at }], limit, offset } }`.

`WorkspaceStore::list` is one SQL query — `SELECT ... ORDER BY created_at
DESC, rowid DESC LIMIT ? OFFSET ?` — `rowid` is the tie-break because
`created_at` (unix seconds as a string, see `store.rs`'s `chrono_now`)
only has second resolution and rows created within the same second would
otherwise have no defined order.

**`status` vs `healthy` — two different questions, deliberately kept
separate:** `status` is the DB's last-written value from `mark_ready`/
`mark_failed` (stale-but-free). `healthy` is a REAL, live check run on
every single `GET /workspaces` call, against every `status == Ready` row:
`container.rs`'s `check_wrapper_health` hits that row's recorded
`host_port`'s `/api/wrapper/v1/health` once (2s timeout,
`HEALTH_CHECK_TIMEOUT` in `route.rs`), and all `Ready` rows are checked
CONCURRENTLY via one `tokio::task::JoinSet` task per row (`route.rs`'s
`check_health_and_build_list_items`) — the request's added latency is
bounded by one timeout, not `rows_checked × timeout`. `Creating`/`Failed`
rows are never checked (no port to check) and are always `healthy: false`.
A `Ready` row whose container has since crashed/hung also reports
`healthy: false` — `status` alone would still (wrongly) say "ready"
forever in that case.

This was a deliberate, direct-instruction reversal of this endpoint's
original design (see `docs/list-workspaces-plan.md`'s "Earlier draft"
note): the first version was a pure DB projection with zero network
calls, matching the wrapper's own "optimized" native-route pattern.
Product decision overrode that — the dashboard mockup's "N healthy"
count and per-row status must reflect real container health, not a
stale DB column, and the cost (one HTTP round trip per `Ready` workspace,
every list call, capped at 2s tail latency by concurrency) was judged
acceptable at this project's current scale (dev-stage, no auth, small
workspace counts). Revisit if that scale assumption stops holding.

Live end-to-end proof (not just unit tests): a real `rust_gateway`
process against a throwaway SQLite DB, with two `Ready` rows inserted
directly — one pointing at a real listener answering
`/api/wrapper/v1/health` with 200 (`healthy: true`), one pointing at a
port with nothing listening (`healthy: false`) — both correctly
distinguished through a real `curl` against the real running binary.

`name` is `idempotency_key` renamed at the type boundary
(`WorkspaceListItem`, a type distinct from `WorkspaceRecord`) — the raw
column name is an internal retry-mechanism detail, not something a caller
should see.

Pagination: `?limit=&offset=`, both optional. `offset` default 0; `limit`
default 50, silently clamped (not rejected) to a 200 max if a caller asks
for more — the response echoes back the `limit` actually used. A negative
`limit` or `offset` is rejected with `400 invalid_pagination` (a caller
bug, not a "too much" request). Registered on the same `/workspaces` path
as `POST /workspaces`, distinguished by HTTP method.

### `DELETE /workspaces/:id` — stop container, drop row

`delete_workspace` in `workspaces/mod.rs` is the one store+launcher pair
for teardown (mirrors `create_workspace`). Looks up by `workspace_id`,
`docker rm -f` when `container_name` is `Some` (missing container =
success), then `DELETE FROM workspace_creations`. Unknown id →
`404 workspace_not_found`. Docker failure → `502 workspace_delete_failed`,
row kept so retry works. CORS `allow_methods` includes DELETE.

### `POST /workspaces/:id/diagnose` — real diagnosis + auto-heal

Plan doc: `docs/diagnose-workspace-plan.md`. A POST (not GET — it can
mutate real infrastructure): real `docker inspect` state
(running/exit-code/OOM-killed) + live wrapper/desktop health checks
(same single-attempt checks `GET /workspaces` uses). If any of the three
signals is unhealthy, runs a real `docker stop` then `docker start`
(NOT `docker restart` — two explicit steps so a `stop` failure vs a
`start` failure is visible separately), waits for both services with the
SAME longer readiness polls `DockerCliLauncher::launch` itself uses (30s
wrapper / 15s desktop — a restarted container boots exactly as slowly as
a freshly created one), then reports the real post-heal state and
updates the store row (`mark_ready_by_workspace_id`/
`mark_failed_by_workspace_id` — new store methods keyed by
`workspace_id`, since diagnosis only has that, not the idempotency key).

Response: `{ workspace_id, before: {...}, action: "none"|"restarted"|
"restart_failed", after: {...} | null }`. `before`/`after` share one
shape: `container_running`, `container_exit_code`, `container_oom_killed`,
`wrapper_healthy`, `desktop_healthy`. `action: "none"` (already healthy,
never touched) has `after: null`; `"restart_failed"` (the stop/start
command itself errored) also has `after: null`; `"restarted"` always has
a real `after`, which may still show unhealthy — a restart that doesn't
fix things is a legitimate, honestly-reported outcome, not hidden behind
a generic failure.

Errors: unknown id → `404 workspace_not_found`; a workspace that never
launched a container (still `creating` or `failed` before any container
existed) → `409 workspace_no_container` (nothing to diagnose) — but a
`failed` workspace that DOES have a `container_name` (a previous launch
got far enough to create one, then failed) still proceeds to real
diagnosis, that's the useful case this exists for.

`ContainerLauncher` gained three new trait methods for this:
`inspect` (parses `docker inspect --format '{{json .State}}'`),
`stop`, `start_existing` (starts an EXISTING container — distinct from
`launch`, which `docker create`s a brand new one). `container.rs` also
gained `check_desktop_health` (same shape as the existing
`check_wrapper_health`) and made `wait_for_wrapper_ready`/
`wait_for_desktop_ready` `pub(crate)` so `diagnosis.rs` can reuse the
exact same readiness-polling logic `launch` already trusts, instead of
reinventing it. `diagnose_workspace` in the new `diagnosis.rs` module
takes a `DiagnosisTimeouts` parameter (not hardcoded constants) so tests
can use short timeouts against `FakeLauncher`'s fake ports without the
suite actually waiting the real 30s/15s — `DiagnosisTimeouts::
production()` is what the real route uses.

**Live end-to-end proof** (not just unit tests): a real `rust_gateway`
process, real `DockerCliLauncher`, a real throwaway container launched
via `POST /workspaces` (~5s to `Ready`) — diagnosed healthy
(`action: "none"`) — then genuinely `docker kill`ed (real `Running:
false`, `ExitCode: 137`) — diagnosed again, which correctly reported the
real crash in `before`, ran a real `docker stop`+`start` cycle, and
`after` showed the container really running again with both services
really answering (~4.3s round trip). The store row's ports were
confirmed unchanged across the restart (Docker doesn't reassign `-p`
mappings on stop/start). Cleaned up (`DELETE`, throwaway DB removed)
without touching this dev machine's real, separately-running workspace
containers/DB.

### Container launch (`DockerCliLauncher` in `container.rs`)

Real sequence, in order: `docker create` (publishes TWO host ports —
wrapper's 8787 and desktop's 3000, each picked via `pick_free_port`: bind
`127.0.0.1:0`, read back the OS-assigned port, drop the listener — small
accepted TOCTOU race, documented in the function) → `docker cp`s a
generated boot script into the not-yet-started container's
`/custom-cont-init.d/` (verified live: `docker cp` onto a created-not-
started container works, s6-overlay really executes it at boot — this
exact sequencing, cp BEFORE start, is required) → `docker start` → polls
the wrapper's `/api/wrapper/v1/health` (30s timeout) AND a light desktop
readiness check (15s timeout; desktop reliably comes up faster, ~2s vs
the wrapper's ~3.5–4.5s) → only then returns `Ready`.

The boot script (mirrors the ORIGINAL sibling project's own
`_server_workspace_boot_command` pattern): `setsid su -s /bin/sh abc -c
'...'`, sets `HOME=/config`, `HERMES_HOME=/config/.hermes`,
`HERMES_WEBUI_AGENT_DIR=/opt/hermes`, `HERMES_WRAPPER_HOST=0.0.0.0`,
`HERMES_WRAPPER_PORT=8787`, `HERMES_FRONTEND_ORIGIN=http://localhost:5173`,
runs `git config --global --add safe.directory /opt/hermes-webui/upstream`,
then `exec /opt/hermes/.venv/bin/hermes-webui-wrapper` (the AGENT's venv —
see "AIAgent not available" fix below for why).

Real bugs found ONLY by running this live (not guessable from reading
code), all now fixed:
1. `abc` can't `git rev-parse HEAD` the upstream checkout without the
   `safe.directory` line — root-owned at build time, `abc` is a different
   uid, git's dubious-ownership check blocks it, which
   `hermes_webui_wrapper.upstream._resolve_revision` silently swallowed
   into `"unknown"`, failing the wrapper's fail-closed pin check.
2. The wrapper's `config.py` requires `HERMES_FRONTEND_ORIGIN` to even
   construct `Settings` — missing it crashes uvicorn before it binds a
   port, same failure mode as #1.
3. `proxy::forward_to` forwarded method+body but never the original
   HEADERS — a JSON POST arrived with no `Content-Type`, and FastAPI
   rejected it outright (upstream's own stdlib JSON parsing happened to
   be lenient about this, masking the bug until the native onboarding
   routes existed to expose it). Fixed: headers now forwarded verbatim,
   skipping `Host`/`Content-Length` (recomputed for the real outgoing
   request).
4. **"AIAgent not available"** — the wrapper originally ran under its own
   separate venv, which could never `from run_agent import AIAgent`
   (that needs the agent's own compiled deps like `pydantic-core`, only
   present in `/opt/hermes/.venv`). Also, upstream's own agent
   auto-discovery checks `/opt/hermes-agent` (with the `-agent` suffix),
   never finding this image's actual `/opt/hermes`. Fixed at the
   Dockerfile level: the wrapper is now `uv pip install -e`'d directly
   into `/opt/hermes/.venv` INSIDE THE BUILDER STAGE (the final image has
   neither `pip` nor `uv` at all — confirmed live, `find / -iname uv`
   finds nothing — so this can only happen at image-build time). Verified
   during the real build that `fastapi`/`uvicorn`/`pyyaml`/`cryptography`
   were already present as the agent's own transitive deps — only the
   wrapper package itself was newly installed. Boot script updated to
   `exec /opt/hermes/.venv/bin/hermes-webui-wrapper` +
   `HERMES_WEBUI_AGENT_DIR=/opt/hermes`.

**Docker Desktop gotcha (infra, not code):** the daemon itself hung once
mid-session (`docker ps`/`docker version` timed out indefinitely) —
unrelated to this project, recovered by restarting Docker Desktop. If
`docker` commands hang forever, suspect the daemon before suspecting code.

**Still NOT built** in the launcher: named volumes for HERMES_HOME/
`/workspace` — container state does not survive `docker rm`. Everything
else originally listed as missing (port publishing, boot delivery,
readiness wait) is now done.

### Per-workspace proxy routes

Three routes, all sharing one validation chokepoint
(`workspaces/resolve.rs`'s `resolve_ready_workspace`): unknown
`workspace_id` → `404 workspace_not_found`; found but `status != Ready`
(covers both `creating` and `failed`) → `409 workspace_not_ready`; found,
`Ready`, but somehow missing a recorded port (should be impossible — see
`store.rs`'s `mark_ready` invariant below — handled anyway, fails closed)
→ `500 workspace_port_missing`.

- **`ANY /workspaces/:id/onboarding/*path`** — forwards to
  `http://127.0.0.1:<wrapper_port>/api/wrapper/v1/onboarding/<path>` (the
  wrapper's native onboarding namespace only).
- **`ANY /workspaces/:id/hermes-webui/*path`** — forwards to
  `http://127.0.0.1:<wrapper_port>/<path>`, UNRESTRICTED — the workspace's
  entire web app (wrapper's native routes AND everything it itself proxies
  into upstream Hermes WebUI).
- **`ANY /workspaces/:id/desktop/*path`** — forwards to the workspace's
  webtop desktop (nginx on container port 3000, fronting KasmVNC). Plain
  HTTP goes through the same `forward_to` byte-relay as the other two;
  `/websockify` (the actual VNC stream) is a REAL WebSocket, relayed via
  axum's `ws` feature (server/browser side) + `tokio-tungstenite` (client
  side, dialing the container). Verified with a genuine end-to-end test:
  a Python `websockets` client connected to
  `ws://127.0.0.1:8080/workspaces/<id>/desktop/websockify` and received
  the literal `b'RFB 003.008\n'` RFB/VNC handshake — real VNC bytes
  through the whole chain (browser → gateway relay → nginx → KasmVNC →
  back). Two real bugs found only by testing this live, both in
  `desktop_proxy.rs`'s `build_upstream_request` (found by reading the
  container's OWN log after each rejection, not guessed): KasmVNC's
  websockify requires an `Origin` header (not sent by `tokio-tungstenite`
  by default) AND a `Sec-WebSocket-Protocol: binary` negotiated
  subprotocol — both now set explicitly on the outbound handshake.

Each proxy route's own path-prefix behavior is genuinely different
(onboarding restricts to one namespace; hermes-webui doesn't restrict at
all; desktop branches on WS-vs-plain) — the shared validation is the only
part that's actually identical, and that's what `resolve.rs` extracts.

`app.rs`'s `register_workspace_proxy_pair` helper collapses each feature's
`.route(prefix + "/", root_handler)` + `.route(prefix + "/*path",
path_handler)` pair (needed because axum's `*path` wildcard doesn't match
a bare trailing-slash request) into one call per feature. A dedicated test
(`every_proxy_feature_prefix_is_reachable_through_the_real_router`) proves
all three features' prefixes are actually wired into the real router, not
just that their handler functions work in isolation.

### DB schema (`workspace_creations` table)

- `idempotency_key` (PK) — the caller-supplied `name`.
- `workspace_id` — UUID, generated fresh per row, looked up via
  `find_by_workspace_id` (a DIFFERENT value from `idempotency_key` — do
  not confuse the two).
- `status` — `creating` | `ready` | `failed`.
- `container_name`, `host_port` (wrapper's published port), `desktop_port`
  (desktop's published port) — all three set together, atomically, in
  `mark_ready`'s one UPDATE. A `Ready` row always has all three or none —
  every reader relies on this invariant rather than re-checking it.

`DATABASE_URL` in `.env.shared` is relative to wherever the PROCESS runs
from (`rust_gateway/`, since `cargo run` executes there), NOT the repo
root. Currently `sqlite://./data/gateway.db`. If you see
`rust_gateway/rust_gateway/data/...` appear, that's this exact bug
recurring. A stale sqlx migration checksum error can surface if a
migration file's CONTENTS are edited after being applied to some
now-orphaned db — clean up ALL `*.db*` files under `revamp/` if that
happens (`find revamp -name "*.db*"`).

### Config rule

**No hardcoded host/port/URL anywhere in `rust_gateway`** — every address
comes from `config.rs` (the only place `std::env::var` is called
directly), enforced by `rust_gateway/AGENTS.md` rule #2. Two-tier env
layering: `.env.shared` (repo root, cross-cutting) loads first, then each
service's own `.env` (can override).

### Dev-machine gotchas (may not apply elsewhere)

- `cargo`/`rustc` at `~/.cargo/bin/`, not on default PATH —
  `export PATH="$HOME/.cargo/bin:$PATH"` first.
- `docker` at `/opt/homebrew/bin/docker`, not on default PATH —
  `export PATH="/opt/homebrew/bin:$PATH"` first.
- Port 8787 was occupied by an unrelated process early on — `test_backend`
  uses 8797 instead. Local accommodation only, not a design decision.

## backend/wrapper — what's built and verified

**pytest: 31/31 passing.** Run from `backend/wrapper/`:
```bash
source .venv/bin/activate   # venv already exists, gitignored, recreate via:
# python3.11 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"
PYTHONPATH=src python -m pytest -q
```
Tests run against the REAL pinned upstream checkout (isolated tmp
`HERMES_HOME`), not mocks.

**Read `backend/wrapper/AGENTS.md` first** for the full rule set and the
exact steps to add another native feature. Summary here, not a duplicate.

### Two request paths coexist

1. **Proxied catch-all** (`app.py`'s `/{full_path:path}`, `transport/`) —
   every upstream endpoint not natively reimplemented. Replays upstream's
   raw stdlib `server.py` dispatch through a `FakeHandler` adapter.
2. **Native routes** (`api/v1/*.py` + `features/*/service.py`) — call
   upstream's plain `api.*` functions directly, no `FakeHandler`/thread/
   dispatch replay. "Optimized" claim is PROVEN, not asserted: a test
   monkeypatches `dispatch()` to raise if called, and the onboarding
   route still passes.

### `features/onboarding/` — chat-model onboarding (the only kind built)

`service.py` — thin functions calling upstream's `api.onboarding`/
`api.oauth` directly (lazy import, post-bootstrap, per the "never import
upstream at module level" rule). `OnboardingError` + `_wrap()` map plain
`ValueError`/`RuntimeError`/`KeyError` → 400/500/404, mirroring upstream
`api/routes.py`'s own per-endpoint mapping exactly.

`api/v1/onboarding.py` — 8 routes under `/api/wrapper/v1/onboarding`:
`GET /status`, `POST /setup`, `POST /setup/self-hosted`, `POST
/complete`, `POST /probe`, `POST /oauth/start`, `GET /oauth/poll`, `POST
/oauth/cancel`. Every upstream call goes through
`fastapi.concurrency.run_in_threadpool` (blocking file I/O / a live HTTP
probe — never awaited directly). 7 of the 8 handlers route through a
shared `_call(fn, *args)` helper (threadpool + `OnboardingError` →
`error()` + `success()`); `probe` stays hand-written since
`probe_provider_endpoint` never raises — its own `{"ok": bool, ...}`
result IS the success data, not something `_call`'s exception-mapping has
a role in.

`api/envelope.py` — same `{ok,data}`/`{ok,error}` shape as
`rust_gateway/src/response.rs`, deliberately, so the frontend parses both
backends identically.

**No auth gate** on these routes (explicit, current-scope decision) —
upstream gates onboarding mutations behind `_onboarding_gate_allows`
(local-network-or-authenticated); this wrapper has no session/login layer
at all yet, so porting an IP-based gate here would be a false sense of
security. Add real auth in front of this service before this matters
outside local dev.

### Scope: chat/text MODEL providers only

User initially asked for 5 onboarding kinds (model/image/video/web/
gateway). Research (grep across upstream) confirmed: upstream Hermes
WebUI/agent has NO concept of image/video/web-search/chat-gateway
*provider onboarding* — only chat/text model providers
(`_SUPPORTED_PROVIDER_SETUPS`: openrouter/anthropic/openai/ollama/
lmstudio/custom/gemini/deepseek/xiaomi/zai/nvidia/mistralai/x-ai) have a
real runtime consumer (`config.yaml`'s `model:` block). "Gateway" in
upstream means the Discord/Telegram/Slack chat bridge, NOT the Rust
gateway. User explicitly deferred image/video/web/gateway onboarding —
**do not build those without a fresh scoping conversation**: they need
(a) a concrete provider roster decision (never made — draft rosters only
discussed, not committed: OpenAI/Google/Stability for image, Runway/
Google-Veo/Kling for video, Tavily/Brave/SerpAPI for web, Discord/
Telegram/Slack for gateway) and (b) a storage decision (nothing in
upstream's `.env`/`config.yaml` would read those keys — reusing
upstream's file for wrapper-invented keys was explicitly discussed and
rejected as the default; a new wrapper-owned store was proposed, never
built).

## Real, live end-to-end verification (most recent full run)

1. `POST /workspaces` through `rust_gateway` → real Docker container → 
   `status: ready` (~4.5–10.7s depending on whether desktop-readiness
   checking was in place yet).
2. `docker port <container>` / `sqlite3 data/gateway.db "SELECT
   workspace_id, status, host_port, desktop_port FROM
   workspace_creations"` confirmed BOTH recorded ports exactly match
   Docker's real published mappings.
3. `GET /workspaces/<id>/onboarding/status` through the gateway → real
   onboarding status JSON from the real wrapper in the real container,
   showing `"hermes_found": true, "imports_ok": true, "missing_modules":
   []` (post the AIAgent fix) and `setup_state: "needs_provider"` (the
   correct state for a fresh, not-yet-onboarded workspace).
4. `GET /workspaces/<id>/hermes-webui/api/wrapper/v1/health` and
   `/desktop/` both returned real `200`s through the gateway.
5. A real WebSocket client connected through
   `ws://127.0.0.1:8080/workspaces/<id>/desktop/websockify` and received
   the real RFB/VNC handshake.
6. Unknown workspace id → real `404 workspace_not_found` on all three
   proxy routes, live.
7. A real onboarding `/setup` POST (openrouter provider + real API key)
   persisted correctly: `/config/.hermes/.env` had
   `OPENROUTER_API_KEY=...` at mode `0600` owned by `abc`,
   `/config/.hermes/config.yaml` had the right `provider`/`default`
   model, and the key itself was confirmed valid against OpenRouter's own
   `/models` endpoint (`200`). A subsequent chat request's `404 Provider
   returned error` for that specific free model was OpenRouter's own
   upstream-provider routing failure (confirmed: the model IS still
   listed in OpenRouter's catalog; a different free/paid variant of the
   same model family would likely work) — NOT a bug anywhere in this
   project's persistence or request path.
8. All test containers/processes/temp `*.db` files cleaned up after every
   verification run — nothing left running as of this checkpoint.

## Frontend — what's built and verified

New Vite + React 19 + TypeScript project (fully restructured at some
point into a feature-folder layout with a shadcn-style UI kit — see the
real current tree in "Architecture at a glance" above; do not trust any
older path reference like `App.tsx`/`onboarding/CreateWorkspace.tsx` —
those no longer exist).

**Create → creating → onboarding flow, wired to `rust_gateway` (not
directly to the wrapper):**
- `features/workspace/api.ts` — `POST /workspaces` via `VITE_GATEWAY_URL`,
  `GET /workspaces` list, `DELETE /workspaces/:id`, plus `hermesWebuiUrl` /
  `desktopUrl` (gateway proxy prefixes, never the wrapper origin).
- `/` workspace list matches the sibling design Dashboard row tools:
  Open → Hermes Web (`/hermes-webui/`), Terminal + Key → `/onboarding/:id`,
  ExternalLink → desktop UI (`/desktop/`), Trash → confirm + DELETE.
- The dashboard's "N healthy" count, the "Healthy" filter chip, and each
  row's status dot/label all read the gateway's LIVE `healthy` field
  (`features/workspace/components/workspace-list.tsx`'s `healthyCount`/
  `statusLabel`/`healthDotClass`) — NOT `status`. A `ready` row whose
  container has since died renders as "Unhealthy" with a red dot, and is
  excluded from the "Healthy" filter and count, even though `status` on
  the wire still says `"ready"`. This was a direct fix: an earlier
  version of this same dashboard filtered/counted by `status === 'ready'`
  alone, which would have shown a dead container as healthy forever.
- `pages/creating-workspace-page.tsx` — shows the POST response; on
  `status: ready`, **"Continue to setup"** navigates to
  `/onboarding/:workspaceId`; **"Done"** remains a skip path (clears
  draft, goes home).
- `features/onboarding/api.ts` — every onboarding action goes to
  `${VITE_GATEWAY_URL}/workspaces/:workspaceId/onboarding/...` — the
  BROWSER NEVER CALLS THE WRAPPER DIRECTLY. `rust_gateway` is the
  enforcement point for id-exists + `status == ready`; `wrapperUrl()` /
  `VITE_WRAPPER_URL` were removed from `lib/env.ts` specifically so
  nothing can accidentally bypass the gateway.
- Initial onboarding `GET .../status` failing with `workspace_not_found`
  / `workspace_not_ready` → replace-navigate to `/create` (toast
  explanation, no retry card — an invalid entry point, not a transient
  error). Any OTHER failure (including the known non-envelope `502` when
  a container's wrapper isn't reachable) → generic `handleError` + retry.
- `lib/api.ts` — shared `apiFetch<T>`/`ApiError`/`errorMessage` parsing
  the `{ok,data}`/`{ok,error}` envelope, identical for both backends.
  `lib/handle-error.ts` — one entry point (`handleError`) every page uses
  for a caught error → toast + display string.

**Known real limitation:** `rust_gateway` has no `GET /workspaces/:id`
status-poll endpoint (list + create + delete exist; no single-id GET) —
the creating page
can't poll a `creating` result to see if it later became `ready`; it can
only show what the one POST response said and let the user retry.

Verified: `npm install` (0 vulnerabilities), `npm run build` (clean, no TS
errors), `npm run dev` (starts, real pages load), CORS confirmed live
(`FRONTEND_ORIGIN` on the gateway side must be `http://localhost:5173`,
NOT `http://127.0.0.1:5173` — Vite's dev server binds `localhost` by
default and CORS is an exact-string match).

## Explicit non-goals / things NOT built (don't assume otherwise)

- No auth, no billing, no multi-tenant routing beyond workspace_id
  validation. `rust_gateway`'s per-workspace proxy routes validate
  existence+readiness, nothing more (no session/login layer anywhere in
  this stack yet).
- No Postgres — SQLite only, by explicit user choice, for Stage 1.
- Named volumes: container state does not survive `docker rm`. The one
  remaining item from `DockerCliLauncher`'s original gap list.
- Image/video/web-search/chat-gateway onboarding: deliberately deferred
  (see "Scope" above) — no roster, no storage decision, nothing built.
- Nothing pushed to any git remote. Ask before ever pushing.
- No real noVNC/KasmVNC-compatible web CLIENT embedded in the frontend
  yet — the desktop proxy's WebSocket transport is proven working
  end-to-end, but nothing in the frontend renders it for a user yet.
- `docs/` at the repo root is still empty.

## run.sh

`revamp/run.sh` — starts `test_backend`, `rust_gateway`, and the frontend
dev server together, interleaved logs to `revamp/logs/*.log`, clean
shutdown on Ctrl+C. Does NOT touch Docker/the workspace image (separate,
explicit, heavier step). Requires `rust_gateway/.env` + `.env.shared` to
exist and `frontend/node_modules` installed — exits with a clear message
if either is missing.

```bash
cd revamp
./run.sh
```

## Suggested next steps (not started)

1. Real noVNC/KasmVNC-compatible frontend client for the desktop proxy
   (transport is proven; nothing renders it yet).
2. A `GET /workspaces/:id` status-poll endpoint so the creating page can
   actually poll instead of showing one static response.
3. Named volumes for workspace persistence across `docker rm`.
4. A real auth/session layer (unblocks: gating onboarding routes,
   multi-tenant routing beyond id validation).
5. When ready to push to a remote: ask first, none configured yet.
