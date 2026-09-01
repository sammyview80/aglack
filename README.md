# revamp

Multi-tenant platform that runs one **Hermes WebUI** agent environment per
workspace, each in its own Docker container, behind a single Rust gateway
and a React frontend.

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
| `backend/upstream/` | Pinned upstream Hermes WebUI checkout — do not edit; see `backend/UPSTREAM.md` and `backend/sync-upstream.sh` | upstream's own |
| `backend/workspace-image/` | Dockerfile for the per-workspace container image | `python3 -m pytest backend/workspace-image` |
| `frontend/` | React app: create/list workspaces, onboarding wizard, mode select, per-workspace chat | `npm run build` (type-checks) |

## Run locally

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

- No auth gate yet on gateway routes (including `agent-config` /
  `agent-seeder`) — do not expose publicly as-is.
- No billing; SQLite single-machine stage (see
  `backend/wrapper/docs/rust-gateway-architecture.md` for the target).
