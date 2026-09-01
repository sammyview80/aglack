# Checkpoint — read this first in a new session

Resume point for a fresh session, organized BY SUBSYSTEM, reflecting
VERIFIED/tested state only. Unfinished work is labeled "NOT YET BUILT."
Compressed from a fuller version — see `CHECKPOINT1.md` for full prose,
or git history for exact session-by-session narrative.

## What this project is

Revamp of an existing Hermes WebUI product into multi-tenant SaaS shape:

```
Rust gateway (control plane: auth/billing/tenant registry, future)
       │
       ▼
per-tenant Docker container (webtop desktop + Hermes Agent + Hermes WebUI)
```

Target architecture: `backend/wrapper/docs/rust-gateway-architecture.md`
("where it's going"). This file is "what exists and is tested now."

## Repository state

- `/Users/saman/Documents/personal/hermano/revamp/`
- Git: 17 commits, no remote, nothing pushed. **Ask before ever pushing.**
- Sibling to the ORIGINAL project at `.../hermano/backend` and
  `.../hermano/frontend` — read-only reference only, do not confuse the two.

## Architecture at a glance

```
revamp/
├── CHECKPOINT.md / CHECKPOINT1.md
├── run.sh                     ← starts gateway+test_backend+frontend
├── backend/
│   ├── upstream/               untouched pinned clone of nesquena/hermes-webui
│   ├── workspace-image/        Dockerfile + patch_kasmvnc_lastactiveat.py
│   │                            + e2e_test_kasmvnc_lastactiveat.py
│   └── wrapper/                FastAPI wrapper, runs upstream in-process
│       └── AGENTS.md            READ FIRST for wrapper work
├── rust_gateway/                Rust/axum gateway
│   ├── AGENTS.md                READ FIRST for rust_gateway work
│   └── src/
│       ├── config.rs             ONLY place env vars are read
│       ├── app.rs                route table, CORS
│       ├── response.rs           shared {ok,data}/{ok,error} envelope
│       ├── proxy/{mod.rs,forward.rs}
│       └── workspaces/
│           ├── mod.rs, route.rs, store.rs, container.rs, resolve.rs
│           ├── diagnosis.rs
│           ├── onboarding_proxy.rs / hermes_webui_proxy.rs / desktop_proxy.rs
│           └── test_support.rs
└── frontend/                    Vite + React 19 + TypeScript, feature-folder layout
```

## rust_gateway — what's built and verified

**`cargo test`: 80/80 passing.**
```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd rust_gateway && cargo test
```

**`POST /workspaces`** — `{name, password?}`. `name` = idempotency key.
Same name + prior `ready` → `409 workspace_name_taken`. Same name + prior
`creating`/`failed` → retries with the same `workspace_id`. Envelope:
`{ok:true,data}` / `{ok:false,error:{code,message}}` everywhere this
gateway itself produces JSON (not the raw proxy relay).

**`GET /workspaces`** — list + pagination (`?limit=&offset=`, default
50/0, clamped to 200, negative → `400`). Every `Ready` row gets a REAL
live health check per request (`check_wrapper_health`, 2s timeout,
concurrent via `JoinSet` — cost bounded by one timeout, not N). `status`
(DB, stale-but-free) vs `healthy` (live) are deliberately different
fields — a dead container still shows `status: ready` but `healthy:
false`. Verified live against both a real listening and a real dead port.

**`DELETE /workspaces/:id`** — `docker rm -f` + row delete. Missing
container = success. Unknown id → `404`. Docker failure → `502`, row kept.

**`POST /workspaces/:id/diagnose`** — real `docker inspect` state +
live wrapper/desktop health. If unhealthy: `docker stop` + `docker start`
(not `restart` — failure visibility), same readiness polls as launch,
re-diagnoses, updates store. Response: `{before, action:
none|restarted|restart_failed, after}`. Errors: `404` unknown,
`409 workspace_no_container` if never launched. **Known gap, confirmed
live: does NOT detect the KasmVNC `lastActiveAt` client-JS-crash class —
it only checks HTTP reachability, which is fine even when that bug is
present** (see debugging trail below).

**Container launch (`DockerCliLauncher`)** — `docker create` (2 published
ports via `pick_free_port`) → `docker cp` boot script to
`/custom-cont-init.d/` (must happen BEFORE `docker start`) → `docker
start` → poll wrapper health (30s) + desktop readiness (15s) → `Ready`.
Boot script: `setsid su -s /bin/sh abc -c '...'`, sets `HERMES_HOME`,
`HERMES_WRAPPER_HOST/PORT`, `HERMES_FRONTEND_ORIGIN`, `git config
safe.directory`, execs `/opt/hermes/.venv/bin/hermes-webui-wrapper`
(the AGENT's venv, not a separate one — needed for `from run_agent
import AIAgent` to resolve).

**Per-workspace proxy routes** — shared validation in `resolve.rs`:
unknown id → `404`; not `Ready` → `409`; `Ready` w/ no port → `500`
(should be impossible).
- `ANY /workspaces/:id/onboarding/*path` → wrapper's onboarding namespace only.
- `ANY /workspaces/:id/hermes-webui/*path` → wrapper root, unrestricted.
- `ANY /workspaces/:id/desktop/*path` → webtop desktop (nginx :3000 →
  KasmVNC). Plain HTTP AND `/websockify` WS upgrade both forward the
  ORIGINAL, UNSTRIPPED request path — opposite of the other two routes.
  **Do not "simplify" this back to path-stripping — see debugging trail,
  it will silently reintroduce a real 502.**

### Desktop "stuck on Connecting" / crash debugging trail

Read before touching `desktop_proxy.rs`, `container.rs`'s
`SUBFOLDER`/`desktop_subpath`, or `patch_kasmvnc_lastactiveat.py`. 5 real
bugs found in one debugging arc. **The actual lesson: 3 separate times a
fix that was correct but incomplete was caught only by re-verifying
against a real browser or a real relaunch — never by re-reading code.**
Tools that mattered: real headless Chrome driven via raw CDP over
Python's `websockets` (no playwright installed); reading the REAL
container's own files (`docker exec ... cat/grep`) instead of assuming;
fetching real upstream source at the EXACT shipped version; a negative
control for every fix (rebuild the old image / revert the code, confirm
it fails the original way).

1. **`1654c48`** — `forward_to` dropped all upstream response headers
   (only copied status+body) → CSS lost `Content-Type` through the
   gateway. Fixed: copy all headers except `Content-Length`/
   `Transfer-Encoding`.
2. **`159815a`** — browser-facing WS upgrade never negotiated
   `Sec-WebSocket-Protocol: binary` (axum needs explicit
   `.protocols([...])`). **Presented as "fixed stuck-Connecting" and was
   wrong to stop here** — real-browser verification surfaced bug 3 immediately.
3. **`52cfb07`** (reverted `02c2804`, reapplied `ff7b739`, net = `52cfb07`)
   — `SUBFOLDER` env var never set on the container, so kclient
   (`/kclient/index.js`, LinuxServer's KasmVNC wrapper — NOT KasmVNC's
   own `www` root) never injects the right `?path=` into its VNC iframe;
   browser's WS request went to bare `ws://<gateway>/websockify`, no
   response ever came. Fix: (a) `container.rs` sets `-e
   SUBFOLDER=/workspaces/<id>/desktop/` at `docker create`
   (`desktop_subfolder_env_arg`/`desktop_subpath`); once set, kclient's
   whole app moves under that prefix, so `wait_for_desktop_ready`/
   `check_desktop_health` had to stop hardcoding root too. (b)
   `desktop_proxy.rs` plain-HTTP branch forwards the unstripped path
   (bare `/` now 404s "Cannot GET /" once SUBFOLDER is live).
4. **`66bdef2`** — found DAYS later on a fresh screenshot of the SAME
   symptom: gateway's own outbound `/websockify` dial still used the
   STRIPPED path → real `502` in the gateway log, across MULTIPLE
   containers. Root cause in the container's own nginx error.log: once
   `SUBFOLDER` is set, nginx REGENERATES a workspace-specific
   `location /workspaces/<id>/desktop/websockify { proxy_pass
   ...:6901 }` PER CONTAINER instead of a generic short one — bare
   `/websockify` matches nothing, falls through to `location /`
   (port 6900, kclient, wrong app), connection closes immediately. Fix:
   both branches build the target URL from `req.uri().path()` (full
   path); the now-unused `path` wildcard param was removed, not left dead.
   Missed originally because that route's test fixture was a raw
   TCP/axum echo server (any path "works"), never real nginx.
5. **`7c9fe33` + `2a100d1`** (base image, not this repo's code) —
   KasmVNC's bundled `dist/main.bundle.js` (`@kasmtech/novnc` v1.3.0,
   confirmed via a running container's `app/package.json`) has a 5s
   `setInterval` keep-alive reading `UI.rfb.lastActiveAt` with NO guard
   on `UI.rfb` being defined; `UI.rfb` goes `undefined` on disconnect
   elsewhere. Real upstream fix
   (`402c0c59d62424ff110bad8f14682deec7d4c780`, PR #201, merged
   2026-07-16) exists but is UNRELEASED (no tag past v1.3.0). Ported a
   small guard (`if (!UI.rfb) return;`) via
   `patch_kasmvnc_lastactiveat.py`, run in the Dockerfile's final stage,
   fail-closed on exact string match — NOT the full 185-line upstream
   commit (unrelated reconnect/VDI features). E2E test
   (`e2e_test_kasmvnc_lastactiveat.py`): its FIRST version clicked the
   Disconnect button and false-PASSED against a deliberately unpatched
   image (`UI.disconnect()` clears the interval synchronously before
   `UI.rfb` is ever nulled — clean disconnect can never hit the bug).
   Fixed trigger: `pkill -9 Xvnc` inside the container (real unclean
   disconnect) — 5/5 repro on unpatched, 0/5 on patched.

**Still open:** diagnose endpoint can't see bug 5's failure mode (no
server-side signal for a client-JS crash — would need
`window.onerror`+beacon, doesn't exist). E2E test talks to the container
directly via `docker run`, never through `desktop_proxy` — structurally
can't catch bug 4's class. **Two independent staleness checks** before
trusting a new "stuck/crash" screenshot as new evidence: (a) was this
container's IMAGE built after `7c9fe33`? (b) is the GATEWAY PROCESS
serving it running a binary built after `66bdef2`? A gateway-code fix
needs a gateway restart; an image fix needs a new container.

### DB schema (`workspace_creations`)

`idempotency_key` (PK, = `name`), `workspace_id` (UUID, separate value),
`status` (creating/ready/failed), `container_name`, `host_port`,
`desktop_port` (all 3 set atomically in `mark_ready`). `DATABASE_URL` is
relative to `rust_gateway/` (where `cargo run` executes), not repo root —
`sqlite://./data/gateway.db`. Stray migration checksum errors → `find
revamp -name "*.db*"` and clean up orphans.

### Config rule

No hardcoded host/port/URL in `rust_gateway` — everything through
`config.rs` (rule #2 in `rust_gateway/AGENTS.md`). `.env.shared` loads
first, then each service's own `.env`.

### Dev-machine gotchas

- `cargo`/`rustc`: `export PATH="$HOME/.cargo/bin:$PATH"`.
- `docker`: `export PATH="/opt/homebrew/bin:$PATH"`.
- `test_backend` uses port 8797 (8787 was occupied by something else).
- Real CDP port 9222 is NOT reliably free on this machine — pick an OS-assigned
  free port for headless-Chrome debugging instead of assuming 9222.

## backend/wrapper — what's built and verified

**pytest: 31/31.**
```bash
cd backend/wrapper && source .venv/bin/activate
PYTHONPATH=src python -m pytest -q
```
Runs against the REAL pinned upstream checkout (isolated tmp `HERMES_HOME`).

Two request paths: (1) proxied catch-all through `FakeHandler` for
everything not natively reimplemented, (2) native routes
(`api/v1/*.py`) calling upstream's `api.*` directly — no dispatch replay,
proven by a test that makes `dispatch()` raise if called.

**`features/onboarding/`** — chat/text MODEL providers only
(openrouter/anthropic/openai/ollama/lmstudio/custom/gemini/deepseek/
xiaomi/zai/nvidia/mistralai/x-ai). 8 routes under
`/api/wrapper/v1/onboarding`. No auth gate yet (explicit scope decision —
add real auth before this matters outside local dev). Image/video/
web-search/chat-gateway onboarding explicitly deferred — **do not build
without a fresh scoping conversation** (no provider roster or storage
decision was ever made for those).

## Real, live end-to-end verification (cumulative)

- `POST /workspaces` → real container → `ready` (~4.5–10.7s).
- DB ports match Docker's real published mappings.
- Onboarding status, hermes-webui health, desktop root all real `200`s
  through the gateway.
- Real WS client received the real RFB handshake through the full chain.
- Unknown id → real `404` on all three proxy routes.
- Real onboarding `/setup` persisted a real, valid OpenRouter key
  (mode 0600, owned by `abc`).
- All test containers/DBs cleaned up after every verification run.

## Frontend — what's built and verified

Vite + React 19 + TS, feature-folder + shadcn-style UI kit.

- `features/workspace/api.ts` — `POST/GET/DELETE /workspaces` +
  `hermesWebuiUrl`/`desktopUrl`, all via gateway proxy prefixes.
- Dashboard's "N healthy" count / filter / per-row dot read the LIVE
  `healthy` field, not `status` — a dead-but-`ready` container shows
  Unhealthy (direct fix of an earlier status-only version).
- Onboarding flow's every call goes through the gateway
  (`${VITE_GATEWAY_URL}/workspaces/:id/onboarding/...`) — browser never
  calls the wrapper directly; `wrapperUrl()`/`VITE_WRAPPER_URL` removed
  from `lib/env.ts` on purpose.
- `workspace_not_found`/`workspace_not_ready` on initial onboarding
  status → replace-navigate to `/create`; any other failure → generic
  retry via `handleError`.

**Known gap:** no `GET /workspaces/:id` single-status-poll endpoint — the
creating page can't poll a `creating` result, only show the one POST
response.

Verified: `npm install` clean, `npm run build` clean, CORS confirmed live
(`FRONTEND_ORIGIN` must be `http://localhost:5173`, not `127.0.0.1` —
exact-string match, Vite binds `localhost`).

## Explicit non-goals (don't assume otherwise)

- No auth, no billing, no multi-tenant routing beyond workspace_id
  validation.
- No Postgres — SQLite only, explicit Stage-1 choice.
- No named volumes — container state does not survive `docker rm`.
- Image/video/web-search/chat-gateway onboarding: deferred, no roster,
  no storage decision.
- Nothing pushed to any remote.
- No real noVNC/KasmVNC client rendered in the frontend UI yet — the
  desktop proxy transport itself is proven end-to-end (see debugging
  trail), nothing in the frontend surfaces it to a user.

## run.sh

```bash
cd revamp && ./run.sh
```
Starts `test_backend` + `rust_gateway` + frontend dev server together,
logs to `revamp/logs/*.log`, clean Ctrl+C shutdown. Does NOT touch
Docker/the workspace image. Requires `rust_gateway/.env` + `.env.shared`
+ `frontend/node_modules`.

## Suggested next steps (not started)

1. `GET /workspaces/:id` status-poll endpoint.
2. Named volumes for workspace persistence across `docker rm`.
3. Real auth/session layer.
4. Server-visible signal for the KasmVNC `lastActiveAt` crash class
   (needs a new browser-reports-its-own-crash mechanism — `diagnose`
   cannot see it today).
5. Push to a remote: ask first, none configured.
