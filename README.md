# aglack ⚙️

Multi-tenant control plane that runs one **Hermes WebUI** agent
environment per workspace, each in its own Docker container, behind a
single Rust gateway and a React frontend.

`rust_gateway/` | `backend/wrapper/` | `frontend/`

`STACK: RUST + PYTHON + REACT` · `RUNTIME: DOCKER REQUIRED` · `LICENSE: POLYFORM NONCOMMERCIAL 1.0.0`

One workspace, one container, one agent — created and torn down through
a single control-plane API. No shared state between tenants beyond the
gateway's own SQLite registry.

> [!WARNING]
> **There is no authentication gate on the gateway routes yet** —
> including `agent-config` and `agent-seeder`. Anyone who can reach the
> gateway can create, inspect, and delete workspaces and their
> containers. **Do not deploy this on a public network or an untrusted
> LAN as-is.** Run it on `localhost` or behind your own authenticating
> reverse proxy. See [Known gaps](#known-gaps).

| A real control-plane API | `POST/GET/DELETE /workspaces`, per-workspace proxy namespaces (`onboarding`, `agent-seeder`, `hermes-webui`, `desktop`), SQLite-backed registry, real `docker` CLI orchestration under `rust_gateway/`. |
| --- | --- |
| An agent-per-container model | Every workspace gets its own Docker container running Hermes WebUI plus a FastAPI sidecar wrapper — no cross-tenant process or filesystem sharing. |
| A seeding pipeline for agents | `backend/seeder_kit/` + `backend/seeder/` create agent profiles (skills, souls, MCP tool runner) and a real per-agent workspace directory on first apply. |
| A frontend that drives real workspaces | React 19 + Vite: create/list workspaces, onboarding wizard, mode select, per-workspace chat — talks to the gateway only through `VITE_GATEWAY_URL`. |
| Test discipline enforced at every layer | `cargo test` (gateway), `pytest` (wrapper, seeder_kit), `npm run build` (frontend) — plus real `docker build` + `POST /workspaces` + `docker exec` verification for anything touching container boot, env vars, or filesystem ownership. |

```
browser ── frontend (React 19 + Vite)
              │  VITE_GATEWAY_URL
              ▼
         rust_gateway (axum control plane)
              │  SQLite workspace registry + `docker` CLI
              ▼
   per-workspace Docker container (backend/workspace-image)
      ├── Hermes WebUI  (backend/upstream — pinned upstream checkout)
      ├── wrapper       (backend/wrapper — FastAPI sidecar API)
      └── desktop       (KasmVNC)
```

## Components

| Path | What it is | Tests |
| --- | --- | --- |
| `rust_gateway/` | Control plane: `POST/GET/DELETE /workspaces`, per-workspace proxy namespaces (`onboarding`, `agent-seeder`, `hermes-webui`, `desktop`), Docker orchestration, SQLite registry | `cargo test` |
| `backend/wrapper/` | FastAPI sidecar inside each container: onboarding, agent-config, agent-seeder v1 routes over the upstream WebUI's own modules | `.venv/bin/pytest` |
| `backend/seeder_kit/` | Library for seeding agent profiles (skills, souls, MCP tool runner) | `python3 -m pytest` |
| `backend/seeder/` | Mode content (agents, skills, tools) consumed by the seeder | content only |
| `backend/upstream/` | Pinned upstream Hermes WebUI checkout — do not edit; see `backend/UPSTREAM.md` and `backend/bootstrap-upstream.sh` | upstream's own |
| `backend/workspace-image/` | Dockerfile for the per-workspace container image | `python3 -m pytest backend/workspace-image` |
| `frontend/` | React app: create/list workspaces, onboarding wizard, mode select, per-workspace chat | `npm run build` (type-checks) |

## Install

Prerequisites: [Rust/cargo](https://rustup.rs), [Node.js/npm](https://nodejs.org),
Docker (only needed later, for real workspace containers — not for the
dev run below).

```bash
git clone https://github.com/sammyview80/aglack.git hermano
cd hermano
```

`backend/upstream/` is a pinned third-party checkout that is git-ignored,
so a fresh clone does not include it. Create it before running anything
that needs the wrapper:

```bash
./backend/bootstrap-upstream.sh
```

It clones the upstream project over HTTPS, checks out the pinned commit,
and verifies the result. It is idempotent — safe to re-run. See
`backend/UPSTREAM.md`.

## How to use — one line

```bash
./bootstrap.sh
```

That single command sets up everything (copies `.env.shared` and
`rust_gateway/.env` from their `.example` files if missing, runs
`npm install` in `frontend/` if `node_modules` is missing) and then runs
the whole stack for you — rust gateway, its `test_backend` dev stand-in,
and the frontend — with interleaved logs in this terminal. Ctrl+C stops
everything cleanly. Re-run any time; it is idempotent and never
overwrites an `.env` file you've already customized.

Already set up and just want to run again? Use `./run.sh` directly — it
is what `bootstrap.sh` hands off to; see its own header comment for
exactly what it starts.

## `aglack` CLI

A single dev CLI (`cli/aglack`, plain POSIX/bash — no build step, no
runtime dependency of its own) that wraps this project's scripts and
tools behind one consistent entrypoint, so you never have to remember
which subdirectory a given check lives in.

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/sammyview80/aglack/aglack/cli/install.sh | sh
```

The installer clones (or updates) the repo to `~/.aglack/src` over HTTPS
and symlinks `cli/aglack` onto your `PATH` (`~/.local/bin` by default).
Re-running it updates the checkout and re-links the CLI — safe to run
again any time. See `cli/install.sh`'s own header for every env override
(`AGLACK_SRC_DIR`, `AGLACK_BIN_DIR`, `AGLACK_REPO`, `AGLACK_BRANCH`).

Piping a script from the network into a shell is worth reading first.
To review before running:

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/sammyview80/aglack/aglack/cli/install.sh
less install.sh
sh install.sh
```

Already have a checkout and don't want a second copy under
`~/.aglack/src`? Skip the installer and just add `cli/` to your `PATH`,
or call it directly: `./cli/aglack help`.

### Usage

```bash
aglack help                    # full command list
aglack up                       # setup (if needed) + run everything — safe as the very first command
aglack bootstrap                # alias for 'up'
aglack install-deps             # just the setup half, no run
aglack test                     # run every suite (gateway, wrapper, seeder, frontend)
aglack test gateway              # just one suite
aglack image build               # docker build the workspace-image
aglack workspace list            # GET /workspaces on the real gateway
aglack workspace create [name]   # POST /workspaces — create a real container
aglack workspace rm <id>         # DELETE /workspaces/:id
aglack status                    # is the gateway reachable?
```

Every command is a thin wrapper — `aglack up` runs setup then `run.sh`, `aglack test
gateway` runs `cargo test`, `aglack image build` runs the same `docker
build` from the Install section above, `aglack workspace ...` calls the
gateway's own HTTP API (see `rust_gateway/src/app.rs`'s routes). Nothing
here reimplements those tools; it only gives one name to remember.

### Manual setup (equivalent, step by step)

```bash
cp .env.shared.example .env.shared          # shared config (all services)
cp rust_gateway/.env.example rust_gateway/.env
(cd frontend && npm install)
./run.sh                                    # test_backend + gateway + frontend
```

`./run.sh` starts a routing-only dev stack (a throwaway `test_backend`
stands in for a real container). Real workspace containers need the image
built first — see `backend/workspace-image/Dockerfile` and
`WORKSPACE_IMAGE_TAG` in `rust_gateway/.env`; the gateway then creates
real containers via `POST /workspaces`.

## Contributing / conventions

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose a change.

- Read the component's own `AGENTS.md` before changing it
  (`rust_gateway/AGENTS.md`, `backend/wrapper/AGENTS.md`); each states its
  structure rules and test requirements.
- `rust_gateway` is test-driven: failing test first, no hardcoded
  addresses (all config via `config.rs` env vars).
- Feature plans live as short docs next to the code
  (`rust_gateway/docs/*-plan.md`) — read the matching plan before touching
  a feature; add one before building a new feature.
- Session history and architecture evolution: `checkpoints/CHECKPOINT*.md`
  (read latest first), changelogs in `checkpoints/CHANGELOG*.md`.
- Research notes: `docs/` (e.g. `docs/hermes-extensions-and-mcp.md` for
  the plugin/MCP integration landscape).
- **Hitting a CORS error, or anything else that looks like an
  environment/config bug rather than a code bug? Check
  `docs/troubleshooting.md` first** — it covers the recurring
  cross-origin (CORS) mismatch class of error (port drift,
  `localhost`/`127.0.0.1` mismatch, missing credentials header, stale
  running process) with a 30-second diagnosis recipe, before you start
  reading gateway/proxy code.

## Verifying a change

All suites must stay green:

```bash
(cd rust_gateway && cargo test)
(cd backend/wrapper && .venv/bin/pytest)
(cd backend/seeder_kit && python3 -m pytest)
(cd frontend && npm run build)
```

Unit tests fake the Docker boundary (`FakeLauncher`); anything touching
the container boot script, env vars, directory ownership, or mounts also
needs a real `docker build` + `POST /workspaces` + `docker exec`
verification — a fully green unit suite has already missed a real
container-permissions bug once (see `checkpoints/CHECKPOINT5.md`).

## Known gaps

- **No auth gate yet on gateway routes** (including `agent-config` /
  `agent-seeder`) — do not expose publicly as-is. See the warning at the
  top of this file.
- No billing; SQLite single-machine stage (see
  `backend/wrapper/docs/rust-gateway-architecture.md` for the target).

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

This project is **source-available, not open source**. You may use, copy,
modify, and share it for **noncommercial purposes only**. Commercial use
is not permitted under this license. See [LICENSE](LICENSE) for the full
terms.
