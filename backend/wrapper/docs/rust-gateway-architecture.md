# Rust Gateway + Multi-Tenant Container Architecture (brainstorm, not yet implemented)

Status: **planning only**. No code exists for this yet. This document captures
the agreed direction so a future agent/session has context before starting
implementation. Do not treat any of this as already built.

## Origin of this idea

User wants to containerize the Hermes WebUI + wrapper stack per tenant, and
put a Rust application in front of it as a stateful SaaS backend (not a dumb
proxy).

## Per-tenant workspace container

Each tenant gets one container built on a lightweight Linux desktop base
image (`lscr.io/linuxserver/webtop`, KasmVNC-based), containing:

1. Hermes Agent (CLI + gateway)
2. Hermes WebUI upstream (`backend/upstream`, untouched — see
   `../../UPSTREAM.md`)
3. This wrapper (`backend/wrapper`) — runs in place of upstream's
   `server.py`, in-process (no HTTP hop between wrapper and upstream; see
   `README.md` architecture section for why)

The wrapper and Hermes WebUI/Agent always run together, in one process
inside one container. They are never split into separate containers talking
over HTTP — that would mean re-architecting the wrapper as a network proxy
instead of the in-process adapter it already is, for no benefit.

Each workspace container exposes:
- The Hermes WebUI (wrapper) port — the actual chat app
- The webtop desktop port (noVNC) — a full Linux desktop in-browser, mainly
  useful for the agent's own tool use / debugging, secondary to the chat UI

## Rust application: stateful backend, not just a router

Originally scoped as "just a gateway that routes to containers." Corrected:
Rust owns real state and must survive restarts, so it needs a real database
(Postgres) behind it. Rust is responsible for:

- **Tenant/container registry** — which container belongs to which tenant,
  container status, routing key resolution
- **Auth** — login, sessions/tokens (future)
- **Billing / SaaS plans** — usage, entitlements, plan limits (future)
- **Orchestration** — create/stop/route to workspace containers via the
  Docker API (e.g. the `bollard` crate against `/var/run/docker.sock`)

## Deployment shape

Rust runs in its own container, separate from every tenant's workspace
container. It never runs inside a tenant container.

```
Server (one VM/bare metal, or a fleet)

  Postgres (container) <---- Rust Gateway (container)
                                 - auth
                                 - billing
                                 - tenant DB
                                 - talks to Docker
                                       |
                         (Docker socket)
                 -----------------------------------
                 |              |                  |
           Tenant A         Tenant B          Tenant N
           webtop        webtop            webtop
           container     container         container
```

## Scaling path (staged, not all built at once)

**Stage 1 — one server (starting point).** Rust container + Postgres
container + N tenant containers on one machine. Rust talks to the local
Docker socket directly.

**Stage 2 — outgrow one server.** Run multiple Rust instances behind a load
balancer, all sharing the same Postgres, so auth/billing/API scales
horizontally. Tenant containers are still pinned to whichever physical
machine runs them — Rust on machine A cannot `docker run` on machine B yet.

**Stage 3 — multiple machines for tenant containers.** Requires a real
orchestrator spanning machines (Nomad or Kubernetes). Rust stops calling the
Docker socket directly and calls the orchestrator's API instead. This is a
real architectural jump, not a config change — worth knowing it is coming,
not worth building at Stage 1.

## Design choices to make Stage 2/3 painless later, even while building Stage 1

- Keep the Rust app **stateless in-process** — all durable state in
  Postgres, not in memory — so a second Rust instance can be added with zero
  rework.
- Use an **async runtime** (Tokio + axum, or similar) so one Rust process
  handles many concurrent connections cheaply.
- Put Docker access **behind a trait/interface** in the Rust codebase, so
  swapping "talk to local Docker" for "talk to Nomad/Kubernetes" later is an
  implementation swap, not a rewrite of auth/billing/routing code.

## Open questions (not yet decided — answer before implementing)

1. **Routing key**: how does the gateway resolve a request to a tenant
   container — subdomain, path prefix, or auth-token lookup?
2. **Container lifecycle**: pre-provisioned (always running) vs. on-demand
   (created on first request, cold-start latency)? Idle-timeout/reaping
   policy for cost control?
3. **Which of the two per-tenant ports are user-facing**: just the Hermes
   WebUI chat port, or also the webtop desktop port?
4. **Per-tenant persistent storage**: naming/mounting convention so a
   tenant's container always reconnects to that tenant's own data volume
   across restarts.
5. **Single machine vs. fleet from day one**: confirmed Stage 1 is
   single-machine/local Docker socket; revisit only when actually needed.
6. **Auth chokepoint**: does the Rust gateway authenticate requests before
   proxying to a tenant container, or does each container rely on Hermes
   WebUI's own built-in auth (password/OIDC) with the gateway forwarding
   blindly? Leaning toward gateway-enforced auth as the safer chokepoint,
   but not finalized.

## Relationship to existing wrapper work

This architecture sits *above* everything already built in
`backend/wrapper/` (see `README.md`). The wrapper's job inside each
tenant container does not change: it stays the in-process FastAPI adapter
over the untouched upstream `api/*` handlers. This document only adds the
multi-tenant container + Rust control-plane layer around it.
