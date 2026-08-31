# AGENTS.md — rust_gateway

Rust HTTP gateway. Current state: forwards every request to one fixed
backend (env-configured). No registry, DB, auth, billing, or Docker
orchestration yet — do not assume any of that exists.

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
├── lib.rs              crate root — wires config/proxy/app
├── config.rs            ONLY place env vars are read
├── proxy/
│   ├── mod.rs            ProxyState
│   └── forward.rs        forward-one-request-to-backend
├── app.rs               axum Router (route table only, no logic)
└── bin/
    ├── rust_gateway.rs   real entrypoint (thin: config → state → router → serve)
    └── test_backend.rs   throwaway "okay" stub; delete once real routing exists
tests/                   integration tests (see below)
```

New env var → `config.rs`. New routing/tenant logic → `proxy/`. New route →
`app.rs` (handler lives in its own module, not inline). DB/Docker/auth →
new module when actually built, not before. No empty placeholder folders.

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
