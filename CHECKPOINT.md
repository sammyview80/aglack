# Checkpoint — read this first in a new session

This file exists so a fresh agent session (or you) can resume exactly where
this one left off, without re-reading the whole prior chat. Everything
below reflects VERIFIED, tested state as of this checkpoint — not plans,
not assumptions. Where something is explicitly unfinished, it's labeled
"NOT YET BUILT," not glossed over.

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
`backend/wrapper/docs/rust-gateway-architecture.md` — read this for the
"why" behind the whole shape (Stage 1/2/3 scaling plan, container
lifecycle questions, etc.). This checkpoint is about "what exists and is
tested right now," that doc is about "where it's going."

## Repository state

- Location: `/Users/saman/Documents/personal/hermano/revamp/`
- Git: initialized, **one commit**, no remote configured, nothing pushed
  anywhere yet (explicit user choice — commit locally only, for now).
  - Commit: `1220169d996a5472eea919b42988433b6dbd2533`
  - Message: "Initial commit: FastAPI wrapper, Rust gateway, and frontend scaffold"
  - 69 files, all reviewed before commit — confirmed no `backend/upstream/`
    files, no real `.env` secrets, no `node_modules`/`target`/`data`
    build artifacts got staged.
- Sibling to the ORIGINAL, separate project at
  `/Users/saman/Documents/personal/hermano/backend` and
  `/Users/saman/Documents/personal/hermano/frontend` — those are
  untouched by this work except as a READ-ONLY source for copying the
  create-workspace UI (see Frontend section below). Do not confuse the
  two — `revamp/` is the new one.

## Folder structure (verified via `find`, not guessed)

```
revamp/
├── CHECKPOINT.md              ← this file
├── .env.shared / .env.shared.example   (shared config; see Config section)
├── .gitignore
├── run.sh                     ← starts gateway+test_backend+frontend together
├── logs/                      ← run.sh's output, gitignored
│
├── docs/                      ← empty (reserved for whole-system docs)
│
├── backend/
│   ├── HERMES_WEBUI_README.md
│   ├── UPSTREAM.md            ← pin provenance + update procedure
│   ├── sync-upstream.sh       ← NEW: one-command check for newer upstream
│   │                             commits (read-only, never auto-updates)
│   ├── upstream/               ← UNTOUCHED nested clone of nesquena/hermes-webui,
│   │                             own git history, own `origin` remote already
│   │                             configured, gitignored from THIS repo.
│   │                             Currently pinned + verified AT upstream's
│   │                             latest: e168b67e4278df618d1cab61fdb3a8dc55b29a81
│   ├── workspace-image/
│   │   └── Dockerfile          ← multi-stage: webtop + Hermes Agent (rebuilt
│   │                             musl venv) + upstream + wrapper. VERIFIED
│   │                             BUILDING AND RUNNING (see Docker section).
│   └── wrapper/                ← FastAPI wrapper, runs upstream in-process
│       ├── src/hermes_webui_wrapper/  (app.py, config.py, upstream.py,
│       │                               runtime.py, transport/, api/)
│       ├── tests/               (21 tests, all passing as of last run)
│       ├── docs/rust-gateway-architecture.md  ← the master architecture doc
│       └── (pyproject.toml, README.md, LICENSE, .env.example)
│
├── rust_gateway/                ← Rust/axum gateway
│   ├── AGENTS.md                ← READ THIS FIRST if working on rust_gateway.
│   │                               Compact rules: test-driven, no hardcoded
│   │                               host/port/URL, optimize for the reader.
│   │                               Says explicitly: "read docs/ before
│   │                               implementing any feature."
│   ├── docs/create-workspace-plan.md  ← plain-language plan for the
│   │                               create-workspace feature (already built)
│   ├── .env / .env.example
│   ├── migrations/0001_workspace_creations.sql
│   └── src/
│       ├── lib.rs                (wires config/proxy/db/workspaces/app)
│       ├── config.rs             (THE ONLY place env vars are read)
│       ├── app.rs                (route table: /workspaces before catch-all)
│       ├── db/mod.rs             (SQLite connect + auto-migrate)
│       ├── proxy/{mod.rs,forward.rs}   (generic forward-to-one-backend;
│       │                                will become per-tenant lookup later)
│       ├── workspaces/           (the real feature — see below)
│       │   ├── mod.rs             (create_workspace: the ONE idempotency
│       │   │                       decision point)
│       │   ├── route.rs           (HTTP handler for POST /workspaces)
│       │   ├── store.rs           (SQLite persistence, race-safe via
│       │   │                       PRIMARY KEY constraint)
│       │   └── container.rs       (ContainerLauncher trait;
│       │                           DockerCliLauncher = real; FakeLauncher
│       │                           = test double)
│       └── bin/
│           ├── rust_gateway.rs    (real entrypoint)
│           └── test_backend.rs    (throwaway "okay" stub backend)
│
└── frontend/                     ← Vite + React 19 + TypeScript
    └── src/
        ├── App.tsx, main.tsx      (NEW minimal routing glue, not copied)
        ├── onboarding/CreateWorkspace.tsx, types.ts   (COPIED byte-identical
        │                                               from the original
        │                                               project's frontend)
        ├── routes/CreatePage.tsx  (COPIED byte-identical)
        ├── discord-ui/ThemeSwitch.tsx, color-theme.css  (COPIED byte-identical)
        ├── lib/colorTheme.ts      (COPIED byte-identical)
        └── styles/brand.css       (COPIED byte-identical)
```

## Config / environment variables — hard rule

**No hardcoded host/port/URL anywhere in `rust_gateway`.** Every network
address is read from env vars via `rust_gateway/src/config.rs`, the only
place `std::env::var` is called directly. This is enforced in
`rust_gateway/AGENTS.md` as rule #2. Do not add a literal address constant
anywhere else in that crate.

Two-tier env file layering (see `.env.shared.example` and
`rust_gateway/.env.example` for full comments):
1. `.env.shared` (repo root) — cross-cutting values used by 2+ services
   (`APP_ENV`, `LOG_LEVEL`, `DATABASE_URL`).
2. Each service's own `.env` — service-only values, loaded AFTER the
   shared file so it can override.

**Known gotcha already hit and fixed once:** `DATABASE_URL` in
`.env.shared` is relative to wherever the PROCESS runs from
(`rust_gateway/`, since that's where `cargo run` executes), NOT relative
to the repo root where `.env.shared` itself lives. Currently correctly set
to `sqlite://./data/gateway.db`. If you ever see `rust_gateway/rust_gateway/data/...`
appear, that's this exact bug recurring — fix the path, don't just delete
the file and retry blindly (a stale sqlx migration checksum error can also
surface if you edit a migration file's CONTENTS after it's already been
applied to some now-orphaned db file — clean up ALL `*.db`/`*.db-*` files
under `revamp/` with `find revamp -name "*.db*"` if that happens).

`WORKSPACE_IMAGE_TAG=hermes-workspace:dev` in `rust_gateway/.env` — must
match whatever tag you build the Docker image as (see Docker section).

## rust_gateway: what's built and verified (4 automated tests, all passing)

**Endpoint:** `POST /workspaces`
**Request body:** `{ "name": "my-workspace", "password": "optional" }` —
matches the REAL existing frontend contract exactly (see
`frontend/src/onboarding/CreateWorkspace.tsx`'s `CreateWorkspaceInput` and
`frontend/src/api/client.ts`'s `createInstall` in the ORIGINAL project,
not this revamp's frontend). `password` is genuinely optional; no `kind`
field (explicitly removed per user instruction — don't re-add it without
being asked).

**Idempotency design:** the workspace `name` IS the idempotency key
(explicit user decision, not a placeholder). Two requests with the same
`name` are treated as the same logical creation attempt:
- If a previous attempt for this name already succeeded (`status: ready`),
  return that same result — never launch a second container.
- If a previous attempt is still in progress OR previously FAILED
  (`status: creating` or `status: failed`), RETRY the launch using the
  same `workspace_id` — do NOT treat an incomplete/failed record as done.
  (This exact distinction was a real bug found via manual end-to-end
  testing during this session, fixed, and now has a regression test:
  `a_key_whose_launch_failed_is_retried_on_the_next_call_with_the_same_key`
  in `rust_gateway/src/workspaces/mod.rs`.)

**Storage:** SQLite, auto-created (including parent directories) on first
connect if missing — verified with a real test
(`database_file_is_created_automatically_when_missing`).

**Container launch:** `DockerCliLauncher` (in `container.rs`) shells out to
`docker run --detach --name hermes-ws-<uuid> <image>`. This is
DELIBERATELY MINIMAL / NOT YET COMPLETE — its own doc comment lists exactly
what's still missing:
- no host port allocation (wrapper's port 8787, desktop port not published)
- no named volumes (container state does not survive `docker rm`)
- no boot script delivery (wrapper process is NEVER STARTED inside the
  container it creates — confirmed via manual test, see Docker section)
- no health-check/readiness wait

None of these require touching `create_workspace` or the HTTP route again
— they're isolated behind the `ContainerLauncher` trait by design.

## Docker: what's been verified with REAL commands (not assumed)

Docker is available on this dev machine at `/opt/homebrew/bin/docker` (not
on default PATH — same class of PATH issue as `cargo`, see below). Daemon
confirmed running, platform `linux/arm64`.

**Build command (the ONLY one that works — this was a real bug, now fixed
in the Dockerfile's own comment):**
```bash
cd revamp/                       # build context MUST be here, not backend/
docker build -t hermes-workspace:dev -f backend/workspace-image/Dockerfile .
```
(The Dockerfile's `COPY backend/upstream` / `COPY backend/wrapper` lines
resolve relative to this context — get the context wrong and you get
`"backend/upstream": not found`.)

**Verified with a real running container** (`hermes-ws-demo`, still running
as of this checkpoint — NOT deleted, user wanted to inspect it in Docker
Desktop):
- ✅ Image builds successfully end to end (base image pulls, musl venv
  rebuild, upstream+wrapper copy, wrapper pip install all succeeded)
- ✅ Container boots cleanly (LSIO `s6-overlay` init completes)
- ✅ Correct desktop protocol confirmed running: **KasmVNC** (not the
  incompatible Selkies variant some other webtop tags silently ship —
  this distinction mattered a lot in an earlier design discussion)
- ✅ Hermes Agent installed at `/opt/hermes/`, its own venv, confirmed
  importable: `docker exec hermes-ws-demo /opt/hermes/.venv/bin/python -c
  'import hermes_cli'` → succeeds
- ✅ Hermes WebUI (upstream + wrapper) installed at `/opt/hermes-webui/`,
  separate venv, confirmed importable: same pattern with
  `hermes_webui_wrapper` → succeeds
- ❌ **NOT YET RUNNING**: neither Hermes Agent's gateway nor the wrapper's
  uvicorn process is actually started. Confirmed via `netstat` inside the
  container — only webtop's own nginx (3000/3001) and KasmVNC (6900/6901)
  are listening. Nothing on 8787. This is the exact gap `container.rs`'s
  doc comment already names ("no boot script delivery").

**To inspect the running demo container yourself:**
```bash
docker ps -a --filter name=hermes-ws-demo
docker logs hermes-ws-demo
docker exec -it hermes-ws-demo sh
```

## Frontend: what's copied and verified

New Vite + React 19 + TypeScript project. NOT built from scratch designwise
— the create-workspace screen was copied byte-identical (diff-verified by
the subagent that did this work) from the ORIGINAL project at
`/Users/saman/Documents/personal/hermano/frontend`, including its full
recursive dependency closure (component → ThemeSwitch → colorTheme.ts,
CSS → brand.css tokens). Only `App.tsx`/`main.tsx`/`index.html` are new
glue code (minimal routing so `/create` renders the copied screen).

Verified: `npm install` (0 vulnerabilities), `npm run build` (succeeds, no
TS errors), `npm run dev` (starts, `/create` returns 200).

The ORIGINAL project at `/Users/saman/Documents/personal/hermano/frontend`
was only READ from, never written to, during this copy — but this was
verified by the subagent that did the work, not independently re-verified
by the parent session. If that matters, run `git status` in the original
`frontend/` directory to double check before trusting it fully.

## run.sh

`revamp/run.sh` — starts `test_backend`, `rust_gateway`, and the frontend
dev server together, interleaved prefixed logs to `revamp/logs/*.log` and
to the terminal, clean shutdown of all three on Ctrl+C. Does NOT touch
Docker/the workspace image — that stays a separate, explicit, heavier step.

```bash
cd revamp
./run.sh
```

Requires `rust_gateway/.env` and `.env.shared` to already exist (copy from
their `.example` counterparts if missing) and `frontend/node_modules`
already installed — `run.sh` checks for these and exits with a clear
message rather than failing confusingly if they're missing.

## Environment gotchas specific to this dev machine (may not apply elsewhere)

- `cargo`/`rustc` exist at `~/.cargo/bin/` but are NOT on this shell's
  default PATH. `rustup default stable` needed to be run once (toolchain
  existed but had no default set). `run.sh` already defensively adds
  `~/.cargo/bin` to PATH if `cargo` isn't found — do the same in any new
  shell/script that needs `cargo` directly.
- `docker` exists at `/opt/homebrew/bin/docker`, also not on default PATH.
  Prefix commands with `export PATH="/opt/homebrew/bin:$PATH"` or use the
  full path directly if `docker: command not found` shows up.
- Port 8787 (the wrapper's real default port) was occupied by an unrelated
  process on this machine early in the session — `rust_gateway`'s test
  setup uses 8797 instead for its throwaway `test_backend`. This is purely
  a local dev-machine accommodation, not a design decision — switch back
  to 8787 freely once it's free / once pointing at a real wrapper
  container.

## Explicit non-goals / things NOT built (don't assume otherwise)

- No auth, no billing, no multi-tenant routing in `rust_gateway` yet —
  `proxy/forward.rs` forwards every request to ONE fixed configured
  backend; there is no tenant/container registry lookup.
- No Postgres — SQLite only, by explicit user choice, for Stage 1 (see
  architecture doc for the Stage 2 trigger: multiple gateway instances
  needing to share one datastore).
- `DockerCliLauncher` does not allocate ports, create volumes, deliver a
  boot script, or wait for health — see "rust_gateway: what's built"
  above for the exact list.
- Nothing has been pushed to any git remote. No remote is configured.
  User explicitly said "commit locally for now" when asked.
- `docs/` at the repo root is still empty — reserved for future
  whole-system docs, nothing placed there yet.

## Frontend ↔ rust_gateway wiring (done and verified this session)

`CreatePage.tsx`'s `onCreate` now really calls `POST /workspaces` via the
new `frontend/src/api/workspaceClient.ts`, using `VITE_GATEWAY_URL` (see
`frontend/.env.example`) — no hardcoded host/port. On success it navigates
to a new `/creating` route (`frontend/src/routes/CreatingPage.tsx`,
registered in `App.tsx`) that shows the POST response (status +
container_name) and offers a retry, which re-submits the same workspace
name (safe — it's the idempotency key on the gateway side).

**Known real limitation, not a bug to "fix" casually:** `rust_gateway` has
no `GET /workspaces/:id` or status-poll endpoint (only `POST /workspaces`
exists — see `app.rs`), so `/creating` cannot poll a `status: "creating"`
result to see if it later became `ready`; it can only show what the one
POST response said and let the user manually retry. Don't assume polling
exists without adding that endpoint first.

**CORS added to rust_gateway** (`app.rs`, new `tower-http` dependency) —
required because the frontend dev server and gateway are different
origins; verified with real `curl` OPTIONS/POST calls carrying an `Origin`
header, and with two new automated tests in `app.rs`
(`preflight_from_configured_frontend_origin_is_allowed`,
`post_response_from_configured_frontend_origin_carries_cors_header`).
Allowed origin is `FRONTEND_ORIGIN`, a new required env var in
`rust_gateway/.env(.example)` — **set to `http://localhost:5173`, not
`http://127.0.0.1:5173`**, because Vite's dev server actually binds
`localhost` by default and CORS origins are exact-string matches. Open
the app via `http://localhost:5173` or this won't match.

Full manual verification chain run this session (then all three
processes stopped again — nothing left running):
- `cargo test` in `rust_gateway/`: 6/6 passing (was 4; two CORS tests
  added).
- `npm run build` in `frontend/`: clean, no TS errors.
- Real `test_backend` + `rust_gateway` + `npm run dev` all started
  together; `curl -X OPTIONS .../workspaces -H 'Origin: http://localhost:5173'`
  → `200`, correct `access-control-allow-origin` header.
- Real `curl -X POST .../workspaces` with a fresh name → `502 failed to
  launch workspace container` (expected: this dev machine's `cargo run`
  process doesn't have `docker` on PATH — the exact pre-existing PATH
  gotcha documented below — and/or the Docker launcher gap documented in
  the section above; the ROUTE and CORS wiring themselves are confirmed
  correct, not the container launch).

Frontend form still sends a `kind` field (`'headless' | 'server'`) that
`rust_gateway`'s route silently ignores (per its own doc comment) — cosmetic
mismatch, not a bug, not addressed this session.

## Suggested next steps (not started, just the logical next slice)

1. Finish `DockerCliLauncher`: port publishing, named volumes, boot-script
   delivery (start the wrapper's uvicorn inside the container), health
   check before returning `ready`. This is also what's needed for a real
   POST from the frontend to end in `ready` instead of `502`.
2. Add a `GET /workspaces/:id` (or similar) status endpoint so
   `/creating` can actually poll instead of only showing one static
   response and a manual retry button.
3. When ready to push: user has not yet chosen a remote — ask before
   pushing anywhere.
