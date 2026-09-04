# Integrations (third-party service providers) — implementation plan

Status: v3. Drafted by Claude, reviewed adversarially by Codex (codex-cli
0.152.1, read-only run against this repo), revised to address every review
finding. Awaiting owner sign-off.

## Goal

Let a workspace owner connect external service providers (Google Workspace,
Slack, Microsoft Teams, GitHub, Notion, ...) from the frontend with one
OAuth click, and let the Hermes agents inside that workspace's container
call those providers as tools. Adding a provider must be configuration, not
code. Provider tokens must be isolated per workspace with no cross-tenant
access path.

## Decision summary

| Question | Decision | Why |
| --- | --- | --- |
| OAuth broker, token vault, provider actions | Self-hosted **OpenConnector** (`oomol-lab/open-connector`, Apache-2.0, pinned image tag) | Ships OAuth flows, AES-256-GCM vault, auto refresh, 1000+ providers, 10k prebuilt actions, built-in MCP endpoint. Nango free tier has no MCP; Composio keeps tokens on its cloud. Apache-2.0 permits commercial use; only provider logos/trademarks are excluded. |
| Tenancy | Built by us in the Rust gateway | OpenConnector is single-tenant by design. Gateway owns workspace -> connections -> runtime token and is the only caller. |
| Tool transport to agents | MCP over Streamable HTTP, container -> wrapper -> gateway -> OpenConnector | Hermes already consumes `mcp_servers` entries; per-agent enable/disable is a flag on that entry. Wrapper hop keeps the bearer out of Hermes config. |
| Provider catalog | `backend/integrations/providers.yaml` allowlist served by gateway | Frontend never hardcodes providers. Requires an explicit amendment to `frontend/AGENTS.md` rule 2 (today it names onboarding status as the only catalog source). |
| Gateway authentication | **Prerequisite (Phase 0)** | Codex review: integration routes and the MCP proxy cannot ship on an unauthenticated gateway. |

## Architecture

```
browser (React)
  │  GET    /integrations/providers
  │  POST   /workspaces/:id/integrations/:provider/connect  -> { authorizationUrl, flowId }
  │  GET    /workspaces/:id/integrations                    (poll; owner-scoped)
  │  DELETE /workspaces/:id/integrations/:provider
  │  PUT    /workspaces/:id/integrations/agents/:agent      { enabled }
  ▼
rust_gateway (axum)  [Phase 0 auth middleware in front of everything]
  ├── integrations registry (providers.yaml, validated at boot)
  ├── SQLite: integration_connections, workspace_runtime_tokens,
  │           integration_agent_enablement, integration_outbox, integration_audit
  ├── OpenConnector admin client (admin token; private docker network)
  ├── OAuth callback front door  GET /integrations/callback  (state check, then forward)
  ├── MCP tenancy proxy  POST /workspaces/:id/mcp  -> openconnector:3000/mcp
  └── wrapper client  PUT /api/wrapper/v1/integrations/...
        │
        ├──► openconnector (network `integrations-net`, no published port)
        │      Postgres (prod) / SQLite (dev); OOMOL_CONNECT_ENCRYPTION_KEY
        │
        └──► workspace container
               /run/hermes/integrations.token   (0400, owner abc, docker cp)
               wrapper: local MCP relay  POST /api/wrapper/v1/integrations/mcp
                        reads token file per request, forwards to gateway
               profile config.yaml:
                 mcp_servers.integrations.url = http://127.0.0.1:8787/api/wrapper/v1/integrations/mcp
                 mcp_servers.integrations.enabled = true|false   (per agent)
```

Workspace containers never dial OpenConnector and never hold the
OpenConnector admin token. They hold one workspace-scoped runtime token in a
file, not in YAML, not in env, not in the boot script.

## Security model (token isolation)

Independent layers. Any single failure still leaves provider tokens
isolated.

1. **Raw provider tokens never leave OpenConnector.** Stored AES-256-GCM.
   Its API never returns credentials. Agents receive action results only.
2. **OpenConnector reachable only from the gateway.** Dedicated Docker
   network, no `ports:`. Admin token only in gateway env.
   `OOMOL_CONNECT_RUNTIME_TOKEN` left unset so no global runtime token
   exists.
3. **Per-workspace runtime token enforced by OpenConnector.** One token per
   workspace, `allowedConnections` = that workspace's connection ids only.
   Naming another tenant's connection returns `403 connection_not_allowed`
   from OpenConnector itself.
4. **Gateway MCP proxy pins the tenant and validates protocol.**
   - Bearer required; sha256 compared against `workspace_runtime_tokens`
     for `:id` AND current generation. Stale generation = 401.
   - Strict JSON-RPC 2.0 parser. Rejects batches, unknown methods, unknown
     top-level fields. Allowlisted methods: `initialize`, `tools/list`,
     `tools/call`, `ping`, `notifications/initialized`.
   - For `tools/call`: tool must be one of `list_connections`,
     `execute_action`, `get_action_guide`. `connectionName` and any
     alias-like field are stripped and replaced with the workspace's
     connection name for the action's provider. `actionId` prefix must match
     a provider the workspace has `connected` AND that provider's optional
     `allowed_actions` list in providers.yaml.
   - Client `Authorization` and hop-by-hop headers are never forwarded; the
     gateway attaches the workspace runtime token itself.
5. **Bearer at rest in the container is a file, not config.** Written by
   `docker cp` to `/run/hermes/integrations.token`, `chown abc:abc`,
   `chmod 0400`. Wrapper reads it per request. Nothing about it appears in
   `docker inspect`, the boot script, `config.yaml`, or logs. Rotation
   replaces the file; no Hermes reload needed.
6. **OAuth flow hardening.** Gateway fronts the callback:
   `GET /integrations/callback?state=...`. Gateway-generated `state` is a
   random 32-byte value bound to `{workspace_id, provider, flow_id,
   expires_at (10 min), owner}` in `integration_connections`; single use.
   Gateway verifies state, forwards to OpenConnector `/oauth/callback`,
   then redirects to `FRONTEND_ORIGIN/workspaces/:id/integrations?flow=ok|error`.
   Unknown/expired/used state = 400, never forwarded. Polling endpoint is
   owner-scoped (Phase 0 identity).
7. **Rotation is atomic and generation-aware.** Per-workspace async mutex.
   Sequence: create new OpenConnector token -> persist
   `{generation+1, hash}` -> `docker cp` file -> health probe through wrapper
   relay -> revoke previous token -> commit. Every step recorded in
   `integration_outbox`; a crash resumes from the last completed step.
   Proxy rejects any generation other than current.
8. **Capability, not secrecy, is the residual risk.** A prompt-injected or
   compromised agent that is `enabled` can perform any allowed action for
   its own workspace (send mail, post to Slack). Mitigations: per-provider
   `allowed_actions` allowlist, per-agent enable flag defaulting to off,
   audit log per action, and a workspace-level kill switch (disconnect all,
   revoke token).
9. **Audit trail without secrets.** `integration_audit(ts, actor,
   workspace_id, provider, event, token_generation, request_id, outcome)`.
   Alerts on 401/403 from the proxy and on OpenConnector
   `connection_not_allowed`.
10. **Mandatory cross-tenant tests** (CI-blocking): workspace A token
    against B's connection is rejected at the gateway (401/403) and, in the
    integration test with a real pinned OpenConnector container, at
    OpenConnector too. Plus: replayed state, expired state, batch request,
    unknown method, forwarded Authorization header, stale generation.

Pre-existing gap now made a prerequisite: gateway has no authentication
(README warning). Phase 0 below.

## Data model (gateway SQLite, migration `0005_integrations.sql`)

```sql
CREATE TABLE integration_connections (
  id                          TEXT PRIMARY KEY,           -- uuid
  workspace_id                TEXT NOT NULL,
  provider_id                 TEXT NOT NULL,              -- key in providers.yaml
  connection_name             TEXT NOT NULL,              -- ws-<workspaceId>-<provider>, gateway-generated
  openconnector_connection_id TEXT,                       -- null while pending
  status                      TEXT NOT NULL CHECK (status IN
                                ('pending','connected','needs_reauth','revoking','disconnected','error')),
  oauth_state_hash            TEXT,                       -- sha256(state); cleared on use
  oauth_state_expires_at      TEXT,
  owner_id                    TEXT NOT NULL,              -- from Phase 0 identity
  account_label               TEXT,                       -- safe identity field only
  last_error                  TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  UNIQUE (workspace_id, provider_id)
);

CREATE TABLE workspace_runtime_tokens (
  workspace_id           TEXT PRIMARY KEY,
  generation             INTEGER NOT NULL,
  openconnector_token_id TEXT NOT NULL,
  token_hash             TEXT NOT NULL,                   -- sha256 of bearer
  previous_token_id      TEXT,                            -- revoked after rollout commit
  rotated_at             TEXT NOT NULL
);

CREATE TABLE integration_agent_enablement (
  workspace_id TEXT NOT NULL,
  agent_slug   TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 0,
  applied      INTEGER NOT NULL DEFAULT 0,                -- wrapper confirmed
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_slug)
);

CREATE TABLE integration_outbox (                          -- durable multi-step ops
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  op           TEXT NOT NULL,                              -- rotate_token | revoke_token | delete_connection | apply_agent | reapply_all
  step         INTEGER NOT NULL DEFAULT 0,
  payload      TEXT NOT NULL,                              -- json, never contains bearer
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_run_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE integration_audit (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               TEXT NOT NULL,
  actor            TEXT,
  workspace_id     TEXT,
  provider_id      TEXT,
  event            TEXT NOT NULL,
  token_generation INTEGER,
  request_id       TEXT,
  outcome          TEXT NOT NULL
);
```

State transitions:

```
pending ──callback ok──► connected ──disconnect──► revoking ──remote ok──► disconnected
   │                        │                                    │
   │ expiry 10 min          │ provider revoked / 424 / auth err  │ remote fails: stay revoking, retry via outbox
   ▼                        ▼
 error                  needs_reauth ──connect again──► pending
```

Rows are never marked `disconnected` before remote revocation succeeds.

## Provider registry

`backend/integrations/providers.yaml`, loaded at gateway start, fail-fast
on schema error:

```yaml
providers:
  - id: github
    name: GitHub
    icon: github
    openconnector_service: github
    oauth_client_env: GITHUB_OAUTH          # GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET
    allowed_actions: []                     # empty = all actions for this provider
  - id: google
    name: Google Workspace
    icon: google
    openconnector_service: google           # confirm exact key in Phase A spike
    scopes:
      - https://www.googleapis.com/auth/gmail.send
      - https://www.googleapis.com/auth/gmail.metadata
      - https://www.googleapis.com/auth/calendar.events
      - https://www.googleapis.com/auth/drive.file
    oauth_client_env: GOOGLE_OAUTH
    description: Gmail, Calendar, Drive
  - id: slack
    name: Slack
    openconnector_service: slack
    oauth_client_env: SLACK_OAUTH
  - id: microsoft-teams
    name: Microsoft Teams
    openconnector_service: microsoft-teams  # confirm exact key in Phase A spike
    oauth_client_env: MICROSOFT_OAUTH
  - id: notion
    name: Notion
    openconnector_service: notion
    oauth_client_env: NOTION_OAUTH
```

On boot, for every provider whose client id/secret are present in env, the
gateway pushes the OAuth config to OpenConnector
(`PUT /api/oauth/configs/:service`). Providers missing credentials are
served with `available: false` so the UI shows "not configured".

## API contract (gateway; envelope `{ok, data} | {ok:false, error:{code,message}}`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/integrations/providers` | Catalog + `available` |
| GET | `/workspaces/:id/integrations` | Connections with status, `last_error`, per-agent enablement. Triggers reconciliation of `pending` rows. Owner-scoped. |
| POST | `/workspaces/:id/integrations/:provider/connect` | Create/refresh `pending` row with state, call OpenConnector `POST /api/oauth/authorizations {service, connectionName}`, return `{authorizationUrl, flowId}` |
| GET | `/integrations/callback` | State verification, forward to OpenConnector, redirect to frontend |
| DELETE | `/workspaces/:id/integrations/:provider` | Enqueue `delete_connection` + `rotate_token`; disable in all agents |
| PUT | `/workspaces/:id/integrations/agents/:agent` | `{enabled}` -> enqueue `apply_agent` |
| POST | `/workspaces/:id/mcp` | MCP tenancy proxy (bearer). Registered with the root + wildcard pair helper like every other workspace namespace. |

Routes follow existing patterns: `register_workspace_proxy_pair` in
`rust_gateway/src/app.rs`, envelope helpers in `rust_gateway/src/response.rs`.
CORS in `app.rs` gains `PUT`. `Authorization` stays out of browser CORS
(the browser never sends it; only containers do, server-to-server).

Workspace delete (`rust_gateway/src/workspaces/route/delete.rs`) is
extended: enqueue `revoke_token` + `delete_connection` for every row, mark
`revoking`, then proceed with container removal. Rows and tokens are
cleaned by the outbox worker; the workspace row is removed only after the
outbox for it drains.

Container (re)create (`docker_launcher.rs` path and `daemon_watch.rs`
recovery) enqueues `reapply_all`: re-copy token file, re-apply
`mcp_servers` entries for every agent with `enabled=1`.

## Wrapper contract

Code lives under `backend/wrapper/src/hermes_webui_wrapper/` (router
`api/v1/integrations.py`, service `features/integrations/service.py`),
mounted at `/api/wrapper/v1/integrations`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/integrations/mcp` | Local MCP relay. Reads `/run/hermes/integrations.token` per request, forwards JSON-RPC to `GATEWAY_INTERNAL_URL/workspaces/<id>/mcp` with `Authorization: Bearer <token>`. No token logging. |
| PUT | `/integrations/agents/{agent}` | `{enabled}`. Resolves profile home via upstream `get_hermes_home_for_profile`, writes `mcp_servers.integrations` through `features/profile_yaml.py` `mutate_profile_config` under a per-profile file lock with atomic rename, then triggers reload. |
| GET | `/integrations/agents` | Reports current entries and flags for reconciliation. |
| POST | `/integrations/reload` | Executes the upstream `/reload-mcp` command through the existing command dispatch (`backend/upstream/api/commands.py`), not by calling internal functions directly. |

Entry written per agent (no secret inside):

```yaml
mcp_servers:
  integrations:
    url: http://127.0.0.1:8787/api/wrapper/v1/integrations/mcp
    enabled: true
```

Known upstream caveat to verify in Phase D: the MCP registry in the agent
process is process-global while profiles are per-agent. The reload path
must be exercised with two profiles, one enabled and one disabled, to
confirm the disabled agent does not see the tools.

## Frontend

- Route `/workspaces/:workspaceId/integrations`, thin page in `src/pages/`,
  feature `src/features/integrations/` (`api.ts`, `types.ts`, `hooks/`,
  `components/`, co-located tests), same layout as `src/features/models`.
- Settings rail icon in `src/components/threads-shell.tsx` navigates to the
  route (replaces the placeholder pane).
- Components: provider grid, connect button (popup with `authorizationUrl`,
  poll every 2s while popup open, stop on `connected|error|needs_reauth`),
  disconnect confirm dialog, per-agent switches, error banner from
  `last_error`.
- `queryKeys.integrations.*` carry `workspaceId` in every leaf.
- New shadcn primitives: card, switch, badge, dialog wrapper.
- `frontend/AGENTS.md` rule 2 amended to name `GET /integrations/providers`
  as the second permitted catalog source.

## Infra

- `docker-compose.yaml` at repo root for control-plane services only:
  `rust_gateway`, `openconnector` (`ghcr.io/oomol-lab/open-connector:<pinned>`,
  image digest recorded, scanned in CI), `postgres` (prod profile). Networks:
  `integrations-net` shared by gateway and openconnector only. Workspace
  containers stay on raw `docker create` and reach the gateway via
  `GATEWAY_INTERNAL_URL` (host.docker.internal on macOS/Windows, gateway
  host IP on Linux); they are never attached to `integrations-net`.
- OpenConnector env: `OOMOL_CONNECT_ENCRYPTION_KEY` (generate once, back up,
  no rotation), `OOMOL_CONNECT_ADMIN_TOKEN`, `OOMOL_CONNECT_ORIGIN` (public
  URL; the gateway's `/integrations/callback` proxies to it, so the public
  redirect URI registered with providers is the gateway URL),
  `OOMOL_CONNECT_DATABASE_URL`, `OOMOL_CONNECT_RUNTIME_TOKEN` unset,
  `OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK` unset.
- Gateway env: `OPENCONNECTOR_URL`, `OPENCONNECTOR_ADMIN_TOKEN`,
  `INTEGRATIONS_PROVIDERS_PATH`, `GATEWAY_PUBLIC_URL`, `GATEWAY_INTERNAL_URL`,
  `<X>_OAUTH_CLIENT_ID` / `<X>_OAUTH_CLIENT_SECRET` per provider.

## Phases and estimate

Codex review judged the v1 estimate of 12 days not credible for a secure
production scope. Revised:

| Phase | Deliverable | Days |
| --- | --- | --- |
| 0a | **Gateway authentication (prerequisite).** Admin password login, signed session cookie, middleware on all `/workspaces/*` and `/integrations/*` routes. See "Phase 0a detail". | 3 |
| A | **Broker spike (go/no-go).** Pinned OpenConnector in compose; verify runtime-token create/revoke semantics, `allowedConnections` 403 behaviour, MCP `execute_action` schema, callback post-redirect behaviour, exact service keys for google/teams. Written findings gate the rest. | 2 |
| B | Registry loader, migration 0005, routes providers/list/connect/callback/disconnect, outbox worker, state machine, audit | 4 |
| C | MCP tenancy proxy: strict JSON-RPC parser, allowlists, generation check, header stripping, adversarial test suite, integration test against real OpenConnector | 3 |
| D | Token file delivery (`docker cp`, perms), rotation sequence, wrapper relay + agents router + reload, reapply on recreate, delete cleanup, pytest | 3 |
| E | Frontend feature + page + tests; AGENTS.md amendment | 3 |
| F | GitHub vertical slice end-to-end with adversarial tests passing; then Google, Slack, Teams, Notion (OAuth apps supplied by owner) | 3 |
| — | Buffer | 3 |
| **Total** | | **~24 engineer-days** (Codex range: 20–30). Phase 0b per-user accounts is extra, 5–8 days, before public customers. |

Ship gate: Phase 0 merged, Phase A findings accepted, cross-tenant and
protocol test suites green, GitHub slice demoed.

Out of scope: Google OAuth app verification (Google side, weeks, needed
beyond 100 test users); persistent volumes for workspace containers (tokens
live in OpenConnector; `reapply_all` restores the container side).

## Decisions taken (v3)

The open decisions from v2 are resolved with the following defaults so
work can start. Each can be revisited; none blocks Phase 0.

1. **Identity model: staged.**
   - Phase 0a (now): one deployment-wide admin credential. Gateway issues a
     signed, HttpOnly, SameSite=Strict session cookie after
     `POST /auth/login` with `GATEWAY_ADMIN_PASSWORD` (argon2 hash in env,
     never plaintext). Every `/workspaces/*` and `/integrations/*` route
     requires the cookie. `owner_id = "admin"`. Container-to-gateway MCP
     calls use the runtime bearer, not the cookie.
   - Phase 0b (before public customers): `users` and `workspace_members`
     tables, email + password or magic link, `owner_id = user.id`.
     Integration rows already carry `owner_id`, so no migration of
     integration data is needed. Estimated separately (5–8 days).
   - Rationale: commercial use needs per-user auth eventually, but the
     integration work must not wait on it. 0a closes the "anyone on the
     network" hole today and is the same cookie machinery 0b extends.
2. **Provider order:** GitHub (proof, no verification), Google, Slack,
   Microsoft Teams, Notion. Each provider after GitHub is a yaml entry plus
   an OAuth app registered by the owner; no new code expected.
3. **Public URL:** development uses `http://localhost:<port>` for the
   gateway; GitHub, Slack and Notion accept it. Google requires HTTPS for
   non-localhost, so Google is tested in dev on localhost only and in
   staging behind the owner's HTTPS domain. Staging URL is an owner task.
4. **Encryption key custody:** `OOMOL_CONNECT_ENCRYPTION_KEY` and
   `OOMOL_CONNECT_ADMIN_TOKEN` are generated by `bootstrap.sh` into
   `.env.local` (git-ignored) for dev; production values live in the
   owner's secrets manager and are mounted as env. Loss of the encryption
   key means every user must reconnect; the runbook says so.
5. **Kill switch:** `POST /workspaces/:id/integrations/revoke-all` revokes
   the runtime token, marks all connections `revoking`, disables all agents.
   Admin-only. Included in Phase B.

## Phase 0a detail (gateway authentication, minimal)

- New env: `GATEWAY_ADMIN_PASSWORD_HASH` (argon2id), `GATEWAY_SESSION_SECRET`
  (32 bytes, HMAC key for cookie signing).
- Routes: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- Middleware (tower layer) on every route except `/auth/*`, `/health`,
  `/integrations/callback` (state-protected instead) and
  `/workspaces/:id/mcp` (bearer-protected instead).
- Cookie: `gw_session`, HttpOnly, Secure when scheme is https, SameSite=Strict,
  12 h expiry, sliding renewal. CORS already sends credentials.
- Brute-force: fixed 1 s delay on failed login plus 10/min per IP cap.
- Frontend: login page at `/login`, `apiFetch` treats 401 as redirect to
  `/login`. Existing `credentials: 'include'` paths already send the cookie.
- Tests: unauthenticated request to each `/workspaces/*` route returns 401;
  login with wrong password returns 401 after delay; cookie tampering
  returns 401.

## Plain-language summary

What we are building, without jargon:

- **A "Connect" page.** In each workspace you see cards for Google, Slack,
  Teams, GitHub, Notion. Click Connect, a small window opens, you sign in
  to that service and press Allow, the window closes, the card shows
  "Connected".
- **A locked safe for passwords.** The actual Google/Slack access keys are
  kept in a separate locked box (OpenConnector) that only our gateway can
  open. Your agents never see those keys. They ask the gateway "send this
  email", and the gateway does it with the right key.
- **One key ring per workspace.** Every workspace gets its own key ring that
  only opens that workspace's boxes. Even if an agent in workspace A is
  tricked, it cannot open workspace B's box: our gateway refuses, and the
  safe refuses again on its own.
- **A per-agent light switch.** Connecting a service does not turn it on
  for every agent. You flip a switch per agent. Off by default.
- **A front door with a lock.** Today anyone who can reach the gateway can
  do anything. First job is a login so the whole control panel needs a
  password before any of this is exposed.
- **A journal.** Every connect, disconnect, and tool call is logged without
  secrets, so you can see who did what.
- **Order of work.** Lock the front door (1 week). Prove the safe behaves
  as its manual says (2 days). Build the plumbing (about 2 weeks). Build the
  Connect page (3 days). Ship GitHub first as the proof, then add Google,
  Slack, Teams, Notion, each mostly a config entry plus you registering an
  app with that provider. Roughly five working weeks total for one
  engineer.

## Owner tasks (cannot be automated)

1. Register OAuth apps: Google Cloud Console, Slack API, Azure AD (Teams),
   GitHub, Notion. Redirect URI for all: `<GATEWAY_PUBLIC_URL>/integrations/callback`.
2. Generate and store `OOMOL_CONNECT_ENCRYPTION_KEY` and
   `OOMOL_CONNECT_ADMIN_TOKEN` in the secrets manager of choice.
3. Provide a public HTTPS URL for the gateway (Google rejects non-https
   redirect URIs except localhost).
4. Decide the Phase 0 identity model (single admin API key vs. per-user
   sessions). This changes `owner_id` semantics.

## Open questions / risks (resolved in Phase A unless noted)

1. OpenConnector post-callback redirect behaviour. Mitigated by fronting the
   callback at the gateway regardless.
2. Exact OpenConnector service keys for Microsoft Teams and Google.
3. Whether runtime tokens can be updated in place or must be recreated.
   Plan assumes recreate + revoke; the outbox handles either.
4. MCP `execute_action` argument schema; contract test pinned to the image
   digest.
5. Hermes MCP client Streamable HTTP support and process-global registry
   behaviour across profiles (Phase D).
6. Phase 0 scope creep: authentication is its own project; keep it minimal
   and explicitly versioned.

## POC status

Phase A (broker go/no-go) is DONE for GitHub: cross-tenant isolation,
revocation, and latency all confirmed against a real running OpenConnector
container with a real GitHub account. Full evidence, exact request/response
shapes, and corrections this found in the plan below are in
`docs/integrations-poc-findings.md` — read it before starting task #2
(gateway routes). Key corrections it makes here: the MCP proxy must strip
`alias` and query-string variants too (not just body `connectionName`);
cross-tenant tests must assert on the JSON body for MCP calls, not HTTP
status (MCP wraps errors in a 200); Google is likely 3 provider rows
(`gmail`, `googlecalendar`, `googledrive`), not one `google` row; Microsoft
Teams' exact service key is unconfirmed and may not exist in the catalog.
The OAuth authorization-code flow itself (as opposed to `api_key` auth,
which is what was spiked) is still unverified — needs its own pass once a
real OAuth app is registered.

## Task #2 status: real gateway code built and verified live

`rust_gateway/src/integrations/` now exists and is wired into the binary
(merged onto `build_router`'s output in `bin/rust_gateway.rs` — deliberately
NOT added to `build_router` itself, which has ten pinned tests). Built,
139/139 tests pass (10 new), and exercised end to end against a real
running OpenConnector container with a real GitHub token — not just unit
tests. See git history / the files under `src/integrations/` for the code;
this section records what is real vs. deferred.

**Working, verified live through actual HTTP calls to a running gateway
process:**
- `GET /integrations/providers` — serves `backend/integrations/providers.yaml`
- `POST /workspaces/:id/integrations/:provider/connect` (`api_key` auth
  only) — connects via OpenConnector, stores the connection row, creates a
  workspace-scoped OpenConnector runtime token, stores its hash
- `GET /workspaces/:id/integrations` — lists connections
- `POST /workspaces/:id/mcp` — the tenancy proxy: verified live that (a) a
  bearer that doesn't match the workspace's stored hash is rejected 401,
  (b) a JSON-RPC batch is rejected 400, (c) a tool outside the two-tool
  allowlist is rejected 403, (d) a missing bearer is rejected 401, (e) a
  real `execute_action` call against GitHub succeeds and returns real data
- `DELETE /workspaces/:id/integrations/:provider`

**Deliberately deferred at that point, since resolved (see "OAuth build
status" below) or still open:**
- ~~OAuth authorization-code connect~~ — built, see below.
- ~~The CORS layer from `build_router` does not cover the merged-in
  integrations routes~~ — fixed: a second `CorsLayer` wraps the fully
  merged router in `bin/rust_gateway.rs`, including `PUT`.
- ~~Delivering the runtime token into a workspace container~~ — built in
  task #4 (`token_delivery.rs`, real `docker cp`/`chown`/`chmod`, verified
  live against a throwaway container).
- Token rotation atomicity (revoke-old-after-new-verified, outbox) — still
  open. Connect (both `api_key` and OAuth) creates a new runtime token but
  does not revoke a prior one; disconnect only revokes when it is the
  workspace's LAST connection.
- The OpenConnector bearer is stored in plaintext in
  `workspace_runtime_tokens.openconnector_bearer` (needed to forward MCP
  calls) — encryption-at-rest for this column is still required before
  production; flagged in the migration's column comment.
- `integration_outbox`, `integration_audit` tables from the full plan are
  still not built — rotation durability and an audit trail are later work.
  (`integration_agent_enablement` was never a separate table — per-agent
  state lives in each agent's own `config.yaml`, read back via the
  wrapper's `GET /integrations/agents`, built in task #3.)

## Phase 0a status: gateway authentication — DONE, verified live

Built and verified against a real running gateway (not just unit tests):
login with wrong password rejected, correct password sets a real
`HttpOnly; SameSite=Strict` cookie, that cookie authenticates every
subsequent protected route, `/auth/me` confirms session state, logout
deletes the session server-side (confirmed: the same cookie is rejected
immediately after logout, not just cleared client-side), and a real CORS
preflight (`OPTIONS` with `Origin`) is answered by the outer `CorsLayer`
directly without ever reaching the session check — verified live, not
assumed from the layer ordering alone.

- `src/auth/`: `password.rs` (Argon2id hash/verify), `store.rs`
  (SQLite-backed opaque sessions, SHA-256-hashed at rest — same pattern as
  `workspace_runtime_tokens.token_hash`, no signing secret to manage),
  `route.rs` (`/auth/login`, `/auth/logout`, `/auth/me`), `middleware.rs`
  (`require_session`, wraps the entire merged app with a small path-based
  exemption list: `/auth/*`, `/oauth/callback`, `/workspaces/:id/mcp`).
- `rust_gateway --hash-password '<password>'` is the one way to generate
  `GATEWAY_ADMIN_PASSWORD_HASH` — never accepts a plaintext password any
  other way.
- Frontend: `pages/login-page.tsx`, `features/auth/api.ts`; `lib/api.ts`'s
  `apiFetch` now sends `credentials: 'include'` on every call and
  redirects to `/login` on any `not_authenticated` response, so every
  existing feature gets protected-route handling for free rather than
  needing its own.
- 163/163 gateway tests pass (7 new — password hashing, session store,
  middleware exemption paths).

**Deliberately deferred, per the plan's own Phase 0a scope — flagged, not
silently skipped:**
- No fixed-delay/per-IP brute-force mitigation on `/auth/login` yet
  (Argon2id's own cost is a partial mitigation).
- No sliding session renewal — a session expires outright at 12h rather
  than extending on use.
- Phase 0b (per-user accounts) is unstarted; this is still one shared
  deployment-wide credential.
- No `/auth/logout` UI control wired into the frontend chrome yet (the
  API and page-level redirect both work; there's no visible "log out"
  button anywhere yet).

## OAuth build status

Real one-click OAuth connect is built and verified live (fake GitHub app
credentials — no real GitHub app was available to complete an actual
login, but every piece up to the provider's own login screen was
exercised against a real running OpenConnector instance, not mocked):

- Gateway pushes each provider's OAuth client id/secret to OpenConnector
  at boot (`PUT /api/oauth/configs/:service`) for any provider with both
  halves of `<PREFIX>_CLIENT_ID`/`<PREFIX>_CLIENT_SECRET` present in the
  environment (`Provider::oauth_credentials`) — confirmed live via
  `GET /api/oauth/configs`.
- `POST /workspaces/:id/integrations/:provider/oauth/start` creates a
  `pending` connection row and returns a real provider authorization URL
  — confirmed live: a real `https://github.com/login/oauth/authorize?...`
  URL came back with the correct `client_id` and `redirect_uri`.
- `GET /oauth/callback` — **the exact path matters and was WRONG on the
  first pass**: OpenConnector computes the redirect URI it hands to the
  provider as `OOMOL_CONNECT_ORIGIN` + its own fixed `/oauth/callback`,
  confirmed live via a real `expectedRedirectUri` field — a route
  registered at `/integrations/callback` (the original draft) would never
  receive the provider's redirect. Fixed before this reached you; the
  live authorization URL's own `redirect_uri` param now matches exactly.
  This route is a pure reverse proxy to OpenConnector's real
  `/oauth/callback` (query string preserved), since OpenConnector has no
  public port in this deployment's security model.
- Completion is detected by **polling**, not by the callback itself: the
  callback's response belongs to OpenConnector, not this gateway, so
  `GET /workspaces/:id/integrations` reconciles every `pending` row
  against OpenConnector's live connection list on each call, running the
  same `finish_connection` logic (token creation, delivery) that `api_key`
  connect uses synchronously. A `pending` row older than 10 minutes is
  marked `error` rather than left pending forever.
- Frontend: `ProviderCard` picks OAuth popup vs. the `api_key` dialog per
  provider via `oauthAvailable` (never hardcoded); the popup hook polls
  the same query the page already displays, so status updates without a
  second UI surface.
- No providers ship with real OAuth credentials configured — every
  provider currently reports `oauth_available: false` until you register
  a real OAuth app per provider and set its env vars (see
  `rust_gateway/.env.example`'s OAuth section and the owner tasks below).
  GitHub needs no app review; Google/Slack/Notion do.

## Production-hardening pass — DONE, verified live

Five of the seven items from the "still open" list were built and
verified against the real running gateway with real data (six existing
connections migrated in place, not reset):

- **Encryption at rest**: `workspace_runtime_tokens.openconnector_bearer`
  is now AES-256-GCM encrypted (`crypto::TokenCipher`,
  `GATEWAY_TOKEN_ENCRYPTION_KEY`). Six pre-existing plaintext rows were
  migrated in place with a one-time script (deleted after use) rather
  than reset — confirmed live: a real `execute_action` call against
  GitHub succeeded post-migration, proving decrypt→forward still works.
- **Token rotation atomicity**: `finish_connection` now captures the
  workspace's previous runtime token BEFORE creating a new one, and only
  revokes it AFTER the new token is stored and delivered — a mid-rotation
  failure never leaves a workspace with zero valid tokens.
- **Audit log**: `integration_audit` table, written on connect, connect
  failure, disconnect, OAuth start, and MCP-proxy bearer rejection — never
  a secret in `detail`. Confirmed live: a real cross-tenant attempt
  (workspace A's bearer against workspace B's endpoint) was rejected AND
  recorded.
- **Brute-force protection on login**: fixed 400ms delay on every wrong
  password (on top of Argon2id's own cost) plus a sliding-window lockout
  (10 failures / 5 minutes) — global, matching the one-shared-credential
  design of this phase.
- **Per-provider action allowlists**: `Provider.allowed_actions` (empty =
  unrestricted, the default), enforced in `mcp_proxy.rs`'s
  `sanitize_request` against `execute_action`'s `actionId`. Confirmed
  live: with GitHub temporarily restricted to one action, the allowed
  action succeeded and every other action got a clean 403 from the
  gateway itself, before ever reaching OpenConnector — then reverted to
  unrestricted (which actions to actually scope is a product decision,
  not built into the default).

178/178 gateway tests pass (16 new). Not built, and explicitly not faked:
- **Google/Slack/Notion real OAuth wiring** — the code path is identical
  to GitHub's (already proven live); the remaining work is registering a
  real OAuth app per provider, which only the account owner can do.
- **Per-user accounts (Phase 0b)** — a genuinely separate, multi-day
  project (users table, per-row ownership checks across every workspace
  and connection). Left as its own future phase rather than half-built
  under this pass.

## Review log

- v1 (Claude): initial design, 12-day estimate.
- Codex review findings applied in v2: gateway auth as prerequisite; bearer
  moved from YAML/boot script to a 0400 file read by a wrapper relay; strict
  JSON-RPC allowlist proxy; generation-aware atomic rotation with outbox;
  OAuth `state` binding, expiry, replay protection, redirect via gateway;
  workspace delete and container-recreate reconciliation; explicit state
  machine; audit table; corrected file paths
  (`rust_gateway/src/workspaces/container/boot_script.rs`,
  `backend/wrapper/src/hermes_webui_wrapper/...`); reload through the
  upstream `/reload-mcp` command rather than internal functions; CORS `PUT`;
  workspace containers not on the compose network; AGENTS.md rule amendment;
  estimate raised to 24–26 days.
