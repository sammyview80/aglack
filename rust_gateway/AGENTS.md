# AGENTS.md — rust_gateway

Rust HTTP gateway. `proxy::forward` forwards a request to one fixed
backend (env-configured) — the original test slice. `workspaces/` is the
real feature: a per-tenant SQLite registry + real `docker` CLI
orchestration, with per-workspace proxy routes (onboarding/hermes-webui/
desktop) resolved through that registry instead of one fixed address. No
auth or billing yet — do not assume either exists.

Full target architecture: `../backend/wrapper/docs/rust-gateway-architecture.md`.

**Before implementing any feature, read `docs/` in this directory.** Each
planned feature gets a short plain-language plan doc there before code is
written (e.g. `docs/create-workspace-plan.md`). If a doc for the feature
you're touching exists, read it first — it explains the "why" so the code
doesn't have to.

## Rules

1. **Test-driven.** Write a failing test before the fix/feature; make it
   pass; keep it. No code without a test proving the behavior.
2. **No hardcoded host/port/URL.** Every network address comes from
   `config.rs` via env vars. No literal address constants anywhere else.
3. **Optimize for the reader.** Small functions, one concern per module,
   names that say what the code does. No cleverness that costs clarity.

## Structure

```
src/
├── lib.rs                      crate root — wires config/proxy/app
├── config.rs                    ONLY place env vars are read
├── response.rs                  shared {ok,data}/{ok,error} JSON envelope
├── db.rs                        SQLite connection setup
├── proxy/
│   ├── mod.rs                    ProxyState
│   └── forward.rs                forward_to: one request → one backend addr
├── app.rs                       axum Router (route table only, no logic)
├── workspaces/                  the create-workspace feature, one module
│   │                             per responsibility — see its own mod.rs
│   │                             doc comment before adding anything here
│   ├── mod.rs                    create_workspace/delete_workspace — the
│   │                             ONLY place idempotency + launch logic meet
│   ├── store.rs                  SQLite-backed workspace_creations CRUD
│   ├── resolve.rs                shared workspace_id → ready-ports lookup,
│   │                             used by every per-workspace proxy route
│   ├── diagnosis.rs              POST /workspaces/:id/diagnose logic
│   ├── container/                turning a workspace_id into a real
│   │   │                         Docker container — split by concern:
│   │   ├── mod.rs                  ContainerLauncher trait + shared types
│   │   ├── docker_launcher.rs      DockerCliLauncher (the real impl)
│   │   ├── boot_script.rs          the /custom-cont-init.d/ wrapper hook
│   │   ├── desktop.rs              desktop SUBFOLDER/subpath helpers
│   │   ├── health.rs               wrapper/desktop readiness + health checks
│   │   ├── inspect.rs              `docker inspect` output parsing
│   │   └── fake_launcher.rs        #[cfg(test)] Docker-free test double
│   ├── route/                    HTTP handlers for /workspaces and its
│   │   │                         per-id sub-routes — one file per handler
│   │   ├── mod.rs                  WorkspacesState (shared by all four)
│   │   ├── create.rs               POST /workspaces
│   │   ├── list.rs                 GET /workspaces
│   │   ├── delete.rs               DELETE /workspaces/:id
│   │   └── diagnose.rs             POST /workspaces/:id/diagnose
│   ├── onboarding_proxy.rs       ANY /workspaces/:id/onboarding/*path
│   ├── hermes_webui_proxy.rs     ANY /workspaces/:id/hermes-webui/*path
│   ├── desktop_proxy.rs          ANY /workspaces/:id/desktop/*path (+ WS)
│   └── test_support.rs           #[cfg(test)] shared test state/DB helpers
└── bin/
    ├── rust_gateway.rs           real entrypoint (thin: config → state →
    │                             router → serve)
    └── test_backend.rs           throwaway "okay" stub for the fixed-
                                  backend proxy slice; not used by the
                                  workspaces feature
```

New env var → `config.rs`. New routing/tenant logic → `proxy/`. New
top-level route → `app.rs`'s route table + a new file in `workspaces/route/`
(handler logic lives in its own file, not inline in `app.rs`). New Docker
concern → a new file in `workspaces/container/`, not a bigger
`docker_launcher.rs`. New per-workspace proxy feature (a fourth namespace
beyond onboarding/hermes-webui/desktop) → a new
`workspaces/<name>_proxy.rs` reusing `resolve.rs` + `proxy::forward_to`,
matching the existing three. No empty placeholder folders — a module
folder (`container/`, `route/`) earns its `mod.rs` only once it actually
holds more than one file's worth of one clear responsibility; do not
pre-split a small, single-purpose file (e.g. `store.rs`, `diagnosis.rs`)
just to mirror this pattern.

## Testing

- `cargo test` must pass before any change is considered done.
- Prefer calling `app::build_router` directly in tests over spawning real
  processes/ports.
- One test per behavior change, asserting the actual response, not that a
  function was called.

## Run

```bash
cp .env.example .env
cargo run --bin test_backend   # terminal 1
cargo run --bin rust_gateway   # terminal 2
curl http://127.0.0.1:$GATEWAY_PORT/
```

## Boundary

`backend/wrapper` (Python/FastAPI) is a separate process, reached over
HTTP only. No code dependency either direction.
