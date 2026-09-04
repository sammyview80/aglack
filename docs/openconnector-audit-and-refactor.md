# OpenConnector integration — audit, refactor proposal, optimizations

Date: 2026-09-03. Branch: `integration/openconnector` at `f99b1c6`
("feat: add workspace integrations, auth, and plugins UI", 74 files,
+8368/-105). This is a document only; no code was changed.

Baseline verified before writing this:

| Suite | Result |
| --- | --- |
| `cargo test` (rust_gateway) | 179 passed |
| `cargo clippy --all-targets` | 5 warnings (4 `assert_eq!` with bool literal, 1 large `Err` variant) |
| `pytest` (backend/wrapper) | 117 passed, 1 skipped |
| `vitest` (frontend) | 162 passed, 21 files |

Everything green. The findings below are about correctness under
conditions the tests do not exercise (two providers on one workspace,
OpenConnector slow or down, hostile containers), about operational gaps,
and about structure that will hurt the next three features.

---

## 1. What is built (as observed, not as planned)

```
browser ──cookie gw_session──► rust_gateway :8080
   │  GET  /integrations/providers                 (providers.yaml, oauth_available)
   │  GET  /workspaces/:id/integrations            (also reconciles pending OAuth rows)
   │  POST /workspaces/:id/integrations/:p/connect (api_key, synchronous)
   │  POST /workspaces/:id/integrations/:p/oauth/start  -> authorization_url (popup)
   │  GET  /oauth/callback                         (unauth'd; verbatim reverse proxy to OC)
   │  DELETE /workspaces/:id/integrations/:p
   │  GET/PUT /workspaces/:id/integrations/agents[/:agent] -> wrapper
   │
   ├─ integrations/{route,store,openconnector,mcp_proxy,token_delivery,providers}.rs
   ├─ auth/{middleware,route,store,password}.rs   (one admin password, Argon2id, opaque session)
   ├─ crypto.rs  (sha256_hex, AES-256-GCM TokenCipher for stored OC bearer)
   └─ SQLite: integration_connections, workspace_runtime_tokens,
              integration_agent_enablement (unused by gateway), gateway_sessions, integration_audit

workspace container
   boot script exports INTEGRATIONS_WORKSPACE_ID, GATEWAY_INTERNAL_URL; mkdir /run/hermes
   gateway `docker cp`s /run/hermes/integrations.token (0400 abc) on connect
   wrapper FastMCP at /api/wrapper/v1/integrations/mcp  tools: list_connections, execute_action, find_action
      └─ relay_mcp_call: httpx.post {GATEWAY_INTERNAL_URL}/workspaces/{id}/mcp  Bearer <token file>
                                          │
rust_gateway  POST /workspaces/:id/mcp  (exempt from session; bearer sha256 == stored hash)
   sanitize: single object only, method allowlist, tool allowlist, per-provider
   allowed_actions on actionId prefix, strip connectionName/alias, force "ws-<id>"
   decrypt stored OC runtime token ──► OpenConnector /mcp (SSE-framed single event → JSON)
```

Connection naming: one OpenConnector connection per (service, `ws-<workspaceId>`).
Runtime token: one per workspace, created with `allowedConnections: [<one id>]`,
rotated create-new-then-revoke-old.

---

## 2. Findings

Severity: **C** breaks the feature or isolation in a reachable scenario.
**H** wrong under realistic failure or load, or a security weakening.
**M** correctness debt / duplication that will bite. **L** cosmetic.

### 2.1 Gateway — integrations

| # | Sev | Where | Problem | Fix |
| --- | --- | --- | --- | --- |
| C1 | C | `rust_gateway/src/integrations/route.rs:558-562`, `:647-654` | **Second provider disconnects the first.** `finish_connection_inner` creates the runtime token with `allowedConnections: [connection_summary.id]` (only the provider being connected), then revokes the previous token. After connecting GitHub then Slack, the workspace token can no longer reach GitHub; OpenConnector answers `connection_not_allowed`. No test covers two providers on one workspace. | Build `allowed = all Connected rows' openconnector_connection_id` for the workspace and pass the full list. On partial disconnect, re-issue a narrowed token the same way (today the token keeps a deleted connection id, which is harmless but the comment at `:701-707` admits the narrowing is missing). Add a two-provider test. |
| C2 | C | `route.rs:420-465` then `:603-621` | **Orphaned OpenConnector connections.** Connect calls OpenConnector (`connect_with_api_key`) *before* checking that the workspace exists or has a container. A typo'd or deleted workspace id creates a real provider connection named `ws-<garbage>` holding a real API key in OpenConnector, then the local row flips to `error`. Nothing ever deletes it. Same ordering issue in `start_oauth_route`. | Call `resolve_ready_workspace` first in connect/oauth-start/list/disconnect. On any failure after the OC connection exists, best-effort `delete_connection` as compensation. |
| H1 | H | `integrations/openconnector.rs:92` (`reqwest::Client::new()`), `bin/rust_gateway.rs:74,110,157` | **No HTTP timeouts anywhere.** OpenConnector hanging pins a tokio task per request forever; MCP calls from every workspace hang until the wrapper's 30 s client timeout. Three separate clients are built with defaults. | One `reqwest::Client::builder().connect_timeout(3s).timeout(15s).pool_idle_timeout(..)` in `AppState`, shared. Streaming proxies keep their own long-timeout client. |
| H2 | H | `openconnector.rs:300-306` (`response_to_error` embeds body), `route.rs:446-451,563-569,348-352`, `mcp_proxy.rs:198-202` | **Upstream error bodies leak to callers.** OpenConnector's raw response text (may echo request fields, internal paths, token ids) is returned to the browser and, via the MCP proxy, to the agent container. Contradicts the audit table's own "never a raw upstream error" rule. | Log the upstream body server-side (with `tracing`), return fixed codes + short messages. Introduce one `AppError` enum with `IntoResponse`. |
| H3 | H | `route.rs:136-168`, `:190-195` | **Reconciliation is N+1 and polled.** Every `GET /workspaces/:id/integrations` calls `GET /api/connections` (full list) once *per pending row*, and the frontend polls every ~2 s while a popup is open. Ten pending rows across ten open tabs is 50 OpenConnector list calls/s. Errors are swallowed (`.ok().flatten()`) so an OC outage looks like "still pending". | Fetch the connection list once per request and match locally. Better: kill polling; see §4.2 (state-bound callback). |
| H4 | H | `route.rs:313-353` | `start_oauth_route` writes `pending` **before** calling OpenConnector and leaves it `pending` when that call fails. The UI shows a spinner for 600 s (`OAUTH_PENDING_TIMEOUT_SECS`). | `mark_error` in the `Err` arm; or create the authorization first and write `pending` only on success. |
| H5 | H | `mcp_proxy.rs:130`, `:106-151` | Bearer check is `sha256_hex(bearer) != token_record.token_hash` (comment admits not constant-time), and `/workspaces/:id/mcp` is session-exempt with **no rate limit** on failures. Any host that can reach the gateway can hammer bearer guesses; audit rows are the only cost. | `subtle::ConstantTimeEq` on the digests; per-workspace failure counter with lockout, same shape as `auth/route.rs` login limiter; consider a 64-byte random bearer length check before hashing. |
| H6 | H | `integrations/store.rs` (`upsert_runtime_token`, read-then-write `generation`) vs `mcp_proxy.rs` | `generation` is documented as "used by the MCP proxy to reject stale bearers" but **nothing reads it**. The increment is also a non-atomic read-modify-write. | Either drop the column or implement it: `ON CONFLICT ... SET generation = workspace_runtime_tokens.generation + 1` and reject bearers whose stored generation is older than a grace window. |
| H7 | H | `route.rs`, `store.rs:record_audit` | Every audit write is `let _ = ...record_audit(...)`. A disk-full or locked SQLite silently loses the security log; there is also no `tracing`/log crate in the gateway at all (only `eprintln!`). | Add `tracing` + `tracing-subscriber`; log audit-write failures at `error`. Keep best-effort semantics for the request. |
| M1 | M | `route.rs:809` and `mcp_proxy.rs:351` | `workspace_connection_name` duplicated. Drift here = silent cross-tenant mismatch. | One `pub(crate) fn` in `integrations/naming.rs`. |
| M2 | M | `route.rs:538-556` then `:559-635` | Row is written `Connected` before the token exists or is delivered; `finish_connection` wraps this with a compensating `mark_error`. | Reorder: create token → encrypt/store token → deliver file → *then* upsert `Connected` + revoke old, in one SQLite transaction for the two local writes. Removes the compensating write. |
| M3 | M | `route.rs:536` | `previous_token = find_runtime_token(...).await.ok().flatten()` — a DB error is treated as "no previous token", so the old OpenConnector token is never revoked (credential leak, not just a leak of a row). | Propagate the error. |
| M4 | M | `integrations/token_delivery.rs` | Four `docker` invocations per delivery (`mkdir`, `cp`, `chown`, `chmod`), bearer written to a **host tmp file in plaintext** first, `docker` spawned with no timeout, and `run_docker` duplicates `workspaces/container/docker_cli.rs`. | One `docker exec -i -u root <c> sh -c 'umask 077; install -d -o abc -g abc /run/hermes; cat > /run/hermes/integrations.token && chown abc:abc ... && chmod 0400 ...'` with the bearer piped on stdin. Share `docker_cli::run_docker` (make it `pub(crate)`). Wrap in `tokio::time::timeout`. |
| M5 | M | `mcp_proxy.rs:78` (`ALLOWED_TOOLS` contains `find_action`) | `find_action` is a **wrapper-local** tool (`mcp_server.py`) that never reaches the gateway; listing it in the gateway allowlist is a layering confusion that future readers will "fix" in the wrong direction. Same list is maintained by hand in three places (gateway, wrapper docstring, `org-integrations/SKILL.md`). | Remove from gateway list. Generate the wrapper docstring/skill text from one source or add a test asserting the sets match. |
| M6 | M | `openconnector.rs:261-287` (`forward_mcp`) | Ignores HTTP status (a 401/500 with a JSON body is returned as HTTP 200 to the container); SSE parse takes the first `data:` line only, drops multi-line `data:` and multiple events. | Check `status.is_success()` first; parse SSE properly (accumulate `data:` lines per event) or request `accept: application/json` only and verify OC honours it. |
| M7 | M | `openconnector.rs:196-204` | `connectionName` interpolated into the query string unencoded. Safe today only because the name is gateway-generated. | `.query(&[("connectionName", name)])`. |
| M8 | M | `route.rs:773-807` | Two hand-rolled wrapper proxies because `forward_to_wrapper_namespace` is `pub(super)` and the `integrations` namespace would collide in `build_router`. Comment documents the workaround instead of fixing visibility. | Make the helper `pub(crate)`, register these two routes through it; or nest agent routes under `/workspaces/:id/integrations/agents` inside the same router so no merge collision exists. |
| M9 | M | `bin/rust_gateway.rs` (270 lines), `IntegrationsState` vs `WorkspacesState` vs `AuthState` vs `ProxyState` | Four state structs, two `WorkspaceStore` handles on one pool, three `reqwest::Client`s, and the wiring lives in `main`. `build_router` is treated as frozen ("ten pinned tests") so new features are merged around it and CORS/auth layers are applied twice. Module doc on `bin/rust_gateway.rs:11-13` still says auth is "NOT YET IMPLEMENTED". | Single `AppState { pool, http, docker, cipher, providers, config }` with feature views (`FromRef`). One `build_router(state)` that owns CORS + auth layering. Update tests once. See §3.1. |
| M10 | M | `integrations/providers.rs` (`oauth_credentials` reads `std::env` per call) | Called on every `GET /integrations/providers` and at startup; `std::env::set_var` in tests is a data race in Rust ≥1.80 / unsound in edition 2024. | Resolve credentials once at load into `Provider.oauth: Option<OAuthClient>`; tests inject a `HashMap` env. |
| M11 | M | `store.rs:now_rfc3339`, `auth/store.rs:440`, `route.rs:253-262` | Timestamps are epoch-seconds **strings** in TEXT columns, compared lexicographically, under a function named `now_rfc3339`. | INTEGER columns, `i64` in Rust, `now_epoch_secs()`. Migration 0008. |
| M12 | M | `route.rs:384-411` (`/oauth/callback`) | Unauthenticated, forwards any query verbatim to OpenConnector, and the gateway never checks OAuth `state` even though the plan (Codex v2 review) required state binding, expiry and replay protection. Risk is contained because OC validates `state` itself, but the gateway learns nothing (hence H3's polling). | See §4.2: capture `state` from `authorization_url` at start, store on the pending row, match it in the callback, and finish the connection there. |
| L1 | L | `mcp_proxy.rs:87` | `pub use crate::crypto::sha256_hex` re-export shim "so existing call sites keep working". | Update the four call sites, delete the shim. |
| L2 | L | `mcp_proxy.rs:206-213` | `extract_bearer` requires exact `Bearer ` casing. RFC 7235 scheme is case-insensitive. | `eq_ignore_ascii_case` on the scheme. |
| L3 | L | `IntegrationsState.providers: Vec<Provider>` | Linear scans on every request. Trivial today, but a `HashMap<ProviderId, Provider>` + `HashMap<Service, ProviderId>` also removes the `find(|p| p.openconnector_service == service)` in the hot MCP path. | |
| L4 | L | clippy | 4× `assert_eq!(x, true/false)`, 1× large `Err` variant (a `Response` inside `Result<_, Response>`). | `cargo clippy --fix`; return `AppError` instead of `Response` from services. |

### 2.2 Gateway — auth

Solid for its stated scope (one admin credential). Notes:

- `auth/route.rs:585-593` lockout is **global**: 10 wrong passwords from anyone locks the real admin out for 5 minutes. Acceptable as documented; add per-IP keying once behind a proxy that sets `X-Forwarded-For`.
- Session lifetime fixed 12 h, no sliding renewal (documented). Fine.
- `is_exempt` (`auth/middleware.rs:244-248`) uses string prefix/suffix rules instead of router-level layering. Works, tested, but `/workspaces/../mcp`-style path normalisation is left to axum. Prefer applying the middleware to a route group and leaving the three public routes outside it.
- Cookie `SameSite=Strict` + the frontend on a different origin (`localhost:5173` vs `:8080`) works only because both are `localhost`. A real deployment on separate hosts will need `Lax` or same-site hosting. Document in `.env.example`.

### 2.3 Wrapper (Python)

| # | Sev | Where | Problem | Fix |
| --- | --- | --- | --- | --- |
| H8 | H | `features/integrations/service.py:99-111` (`relay_mcp_call`) | HTTP status ignored. Gateway 401 (`invalid_bearer`, post-rotation), 403 (`tool_not_allowed`), 502 all parse as JSON and are handed to `_unwrap` as if they were JSON-RPC results. Agent sees a confusing shape instead of a clear error. | Branch on `response.status_code`; map the gateway envelope `{ok:false,error:{code,message}}` to `IntegrationsError(code, message, status)`. Add tests for 401/403/502. |
| M13 | M | `service.py:99` | `timeout=30.0` is a single value (read timeout also applies to connect) and a new `httpx` client per call — no connection pooling, TLS/TCP handshake per tool call. Called from `find_action` up to 4× sequentially. | Module-level `httpx.Client(timeout=httpx.Timeout(30, connect=3))` or async client; `find_action` fans out guide fetches concurrently. |
| M14 | M | `mcp_server.py:234` | `guide_ok = guide_result.get("ok", True)` — an error dict without `ok` is treated as a schema. | `guide_result.get("ok") is True`. |
| M15 | M | `mcp_server.py:93-140` | Tool bodies do not catch `IntegrationsError`; FastMCP turns the exception into a generic tool error and the agent loses the code. | Catch and return `{ok:false, error:{code,message}}` consistently (the shape the skill already teaches). |
| M16 | M | `features/agent_seeder/service.py:430-454` | `_connected_provider_ids` swallows every exception at `debug`; a broken relay silently disables the "prefer connected provider" behaviour. `_EXCLUDED_BUNDLED_SKILL_SUBPATHS` hard-codes GitHub skill paths — a second provider needs edits here *and* in `providers.yaml`. | Log unexpected errors at `warning`; drive exclusions from a `bundled_skill_exclusions:` key in `providers.yaml` (served via `GET /integrations/providers`). |
| M17 | M | `config.py:127` | `resolve_gateway_internal_url` only `rstrip`s; no scheme/host validation. | `urllib.parse.urlsplit` and require scheme+netloc. |
| L5 | L | `service.py:51-72` | Bearer file re-read per request (fine, intentional for rotation) but no minimum-length sanity check. | Reject `< 32` chars as "token missing/corrupt". |
| L6 | L | `Dockerfile:188-189` | `seeder_kit[mcp]` then wrapper both pin `mcp`; resolution order works today by luck of matching ranges. | Pin `mcp` once in a shared constraints file. |

Verified: the wrapper exposes exactly three `@mcp.tool()`s
(`mcp_server.py:93,109,128`); `SKILL.md` is accurate on that point.

### 2.4 Setup / operations

| # | Sev | Problem | Fix |
| --- | --- | --- | --- |
| O1 | H | **No compose / deployment definition for OpenConnector in the repo.** The plan's "Infra" section requires a root `docker-compose.yaml` with gateway + openconnector on `integrations-net` and *no published OC port*. What exists is a throwaway `.worktrees/oc-spike/` (git-ignored) and `.env.example`'s `OPENCONNECTOR_URL=http://localhost:3300`, i.e. a **published** port on the dev host. Anyone reproducing this today has to rediscover how OC was started, and the admin token protects everything. | Add `deploy/docker-compose.yml` (gateway, openconnector pinned by digest, optional postgres), `deploy/.env.example`, and a `make up` / `run.sh --with-oc`. Pin OpenConnector version (docs say v1.4.1) in the compose file, not only in prose. |
| O2 | M | `run.sh` starts `test_backend`, gateway, frontend — nothing about OpenConnector, `GATEWAY_ADMIN_PASSWORD_HASH`, or `GATEWAY_TOKEN_ENCRYPTION_KEY`, all of which are now **required** and fail startup. First-run experience is four opaque `invalid configuration` exits. | `bootstrap.sh` generates the key + prompts for the password hash; `run.sh` checks for them with a hint. |
| O3 | M | No structured logging, no request ids, no metrics in the gateway. `println!`/`eprintln!` only. | `tracing` + `tower_http::trace::TraceLayer`, request-id layer, `/healthz` that also pings OC. |
| O4 | M | Secrets surface: `OPENCONNECTOR_ADMIN_TOKEN`, `GATEWAY_TOKEN_ENCRYPTION_KEY`, provider client secrets all in one flat `.env`; key rotation story is "reconnect everything". | Document rotation; support `GATEWAY_TOKEN_ENCRYPTION_KEY_PREVIOUS` for re-encrypt-on-read. |
| O5 | L | CI (`.github/workflows`) runs on `main, master, aglack` only; this branch's 8k lines run CI only on PR. `checkpoints/` (16 files, ~200 KB of session logs) sits at repo root. | Add `integration/**` to push triggers or open the PR now; move `checkpoints/` → `docs/history/`. |
| O6 | L | `.env.example` says `SameSite=Strict` cookie works cross-port; only true on `localhost`. | Note in env docs (see §2.2). |

### 2.5 Frontend

Conventions are consistent and good: `features/<name>/{api,types,hooks,components}`,
gateway URL only from `lib/env.ts`, query keys carry every identity part,
session is an HttpOnly cookie sent with `credentials: 'include'`.
Findings are all in the OAuth popup hook.

| # | Sev | Where | Problem | Fix |
| --- | --- | --- | --- | --- |
| M18 | M | `features/integrations/hooks/use-oauth-connect.ts:52-68` | **Polling never notices a closed popup.** User closes the consent window → `setInterval` keeps calling `fetchIntegrations` every 2 s for 600 s, and the gateway keeps hitting OpenConnector (H3) for the whole window. | Check `popupRef.current?.closed` each tick and stop; or replace polling entirely per §4.2. |
| M19 | M | same, `:52-56` | The async interval callback has no `try/catch`; when the gateway is down every tick is an unhandled promise rejection (console spam, no user feedback, `handleError` never called). | Wrap in `try/catch`, stop after N consecutive failures, toast once. |
| M20 | M | same, `:45` | `window.open(url, '_blank', ...)` without `noopener`: the provider/OpenConnector page gets `window.opener` and can navigate the console tab (reverse tabnabbing). `noopener` would break `popupRef`-based closing, which is why §4.2's postMessage/refetch design is the clean fix. | Until §4.2: keep the reference but set `popup.opener = null` right after opening. |
| L7 | L | `pages/login-page.tsx:32-33` | `navigate(from || '/')` where `from` comes from router `location.state`. Not attacker-reachable from a URL (state is in-memory), but a `from` that is not a same-app path should be rejected defensively. | `from?.startsWith('/') ? from : '/'`. |
| L8 | L | `use-oauth-connect.ts:45` | `authorization_url` from our own gateway is opened without a scheme check. Low risk (trusted origin) but one line prevents `javascript:` if the gateway is ever compromised. | Allow `https:` (and `http:` for localhost dev) only. |
| L9 | L | `components/ui/badge.tsx` | Exported, never imported. | Delete or use it in `provider-card.tsx`. |

---

## 3. Refactor proposal — folder structure

Goal: every new integration-adjacent feature (per-user auth, more
providers, token rotation worker, webhooks) lands in one obvious place,
with one state, one error type, one HTTP client, one docker helper.
Names below are suggestions; the *boundaries* are the point.

### 3.1 `rust_gateway/`

Current pain: `integrations/route.rs` is 886 lines mixing HTTP, business
rules and OC orchestration; four state structs; `bin/rust_gateway.rs`
does wiring that belongs in the lib; `proxy` helpers are `pub(super)`
so siblings copy them.

```
rust_gateway/
  src/
    lib.rs
    bin/rust_gateway.rs          # ~30 lines: load config → bootstrap::run()
    bin/hash_password.rs         # the --hash-password mode as its own tiny bin
    app/
      mod.rs
      state.rs                   # AppState { config, pool, http, docker, cipher, providers }
                                 #   + FromRef impls for feature sub-states
      router.rs                  # build_router(state) — ONE place; CORS + auth layers here
      layers.rs                  # cors(), request_id(), trace()
      bootstrap.rs               # connect db, run migrations, push OAuth configs, spawn daemons
    config/
      mod.rs                     # GatewayConfig (one struct, nested sections)
      env.rs                     # required_env / parse_bool_env helpers
    shared/
      error.rs                   # enum AppError { NotFound, Conflict, Upstream{..}, Db(..), .. } → IntoResponse
      response.rs                # envelope (existing)
      crypto.rs                  # existing
      time.rs                    # now_epoch_secs()
      docker.rs                  # run_docker(args, timeout) — moved from workspaces/container/docker_cli.rs
      http.rs                    # shared reqwest clients (short-timeout json, long-lived stream)
    proxy/
      mod.rs, forward.rs         # forward_to(...) pub(crate); wrapper-namespace helper lives here too
    features/
      auth/                      # unchanged internals; router() returns Router<AppState>
      workspaces/
        mod.rs, store.rs, resolve.rs, diagnosis.rs, daemon_watch.rs
        routes/{create,delete,list,diagnose}.rs
        proxies/{onboarding,chat,desktop,hermes_webui,agent_seeder,agent_history}.rs
        container/{launcher.rs, boot_script.rs, health.rs, inspect.rs, desktop.rs}
      integrations/
        mod.rs
        naming.rs                # workspace_connection_name (single definition)
        providers.rs             # registry + resolved OAuth creds (loaded once)
        store.rs                 # SQL only
        openconnector/
          client.rs              # HTTP calls, typed errors, timeouts
          types.rs               # ConnectionSummary, RuntimeToken, ...
          sse.rs                 # proper event parsing
        service.rs               # connect / finish_connection / disconnect / reconcile / rotate
                                 #   (no axum types; returns Result<T, AppError>)
        token_delivery.rs        # uses shared::docker, single exec, stdin pipe
        mcp_proxy/
          mod.rs                 # handler: bearer check, rate limit, decrypt, forward
          sanitize.rs            # pure fn sanitize_request(...) (+ its tests)
          allowlist.rs           # ALLOWED_METHODS / ALLOWED_TOOLS
        routes/
          providers.rs, connections.rs, oauth.rs, agents.rs
  migrations/                    # + 0008: integer timestamps, drop/implement generation
  tests/                         # integration tests with wiremock OpenConnector (see §5)
```

Mechanical steps, each shippable alone:

1. `shared/error.rs` + `AppError`; convert `integrations::route` first (kills the "large Err variant" clippy warning and H2 leaks in one pass).
2. `AppState` + single `build_router`; delete the duplicate CORS layer and the `is_exempt` string matcher in favour of route-group layering. Update the ten `build_router` tests once.
3. Split `route.rs` → `service.rs` + `routes/*.rs`. Fix C1/C2/M2/M3 while the logic is being moved (they are all inside `finish_connection`).
4. `shared/docker.rs`, `shared/http.rs`; delete `token_delivery::run_docker` and the three `Client::new()`s.
5. `naming.rs`, remove the `sha256_hex` shim, drop `find_action` from the gateway allowlist.

### 3.2 `backend/wrapper/`

Structure is already reasonable (`api/v1` thin, `features/*`). Targeted:

```
hermes_webui_wrapper/
  settings.py                    # one frozen dataclass: workspace_id, gateway_url, token_path,
                                 #   loaded once at startup (replaces 3 resolve_* fns called per request)
  features/integrations/
    relay.py                     # http client (pooled), status-code mapping → IntegrationsError
    tools.py                     # the three @mcp.tool bodies, all returning {ok, ...}
    mcp_app.py                   # build_mcp_app()
    agent_config.py              # set_agent_enabled / reload_mcp (profile YAML edits)
    errors.py
```

- `features/agent_seeder/service.py` should not know about GitHub skill
  paths; read exclusions from the provider registry.
- Keep the "wrapper never re-sanitizes" rule; document it in one place
  (`relay.py` docstring), not in three.

### 3.3 `frontend/`

Feature-folder layout (`features/<name>/{api,hooks,components,types}`) is
consistent and worth keeping. Suggested only:

- Move `pages/workspace-integrations-page.tsx` and `pages/login-page.tsx`
  into their features as `features/integrations/pages/…` and
  `features/auth/pages/…`; `app/router.tsx` imports from features. Pages
  folder then holds only cross-feature shells.
- `features/integrations/integrations-ui.ts` (status→label/colour maps)
  is the right pattern; mirror it for auth.
- `use-oauth-connect.ts` shrinks to "open popup, await one completion
  signal" once §4.2 lands; keep it a hook, drop the interval/timeout refs.

### 3.4 Repo root

```
/
  README.md, CONTRIBUTING.md, SECURITY.md, LICENSE
  deploy/
    docker-compose.yml           # gateway + openconnector(pinned digest) [+ postgres profile]
    .env.example                 # OC + gateway secrets, one file
  scripts/ (run.sh, bootstrap.sh, bootstrap-upstream.sh, sync-upstream.sh)
  docs/
    architecture/                # integrations-plan.md (trim to current truth), rust-gateway-architecture.md
    adr/                         # one file per decision (single connection name, api_key-first, no OC port)
    runbooks/                    # troubleshooting.md, key rotation, "OC down" playbook
    research/                    # poc-findings, hermes-extensions-and-mcp, a2a research, postmortem
    history/                     # checkpoints/*, CHANGELOG*
  rust_gateway/  backend/  frontend/  cli/
```

`integrations-plan.md` (670 lines) mixes plan, status log and review log.
Split: the *current* design into `architecture/integrations.md`, the
status/review logs into `history/`.

---

## 4. Optimizations

### 4.1 Cheap, do now

- **Timeouts + one HTTP client** (H1). Also set `pool_max_idle_per_host`.
- **Token delivery in one `docker exec`** with stdin pipe (M4): 4 process
  spawns → 1, no host tmp file, ~200 ms → ~50 ms per connect.
- **Reconcile once per request** (H3): one `GET /api/connections` per
  list call, not per pending row.
- **Wrapper pooled `httpx.Client`** and concurrent guide fetches in
  `find_action` (M13): 3–4 sequential round trips → 1 + parallel.
- **`HashMap` provider lookup** in the MCP hot path (L3).
- **SQLite**: confirm `journal_mode=WAL`, `busy_timeout`, and
  `synchronous=NORMAL` in `db/mod.rs`; the MCP proxy does a read per call
  and the audit table an insert per failure.

### 4.2 Structural: replace OAuth polling with a state-bound callback

Today: browser polls `GET /workspaces/:id/integrations` every ~2 s → gateway
lists all OC connections per pending row → `finish_connection` when one
shows `configured`. Cost: constant OC load while any popup is open, a
600 s zombie window, and no `state` binding at the gateway.

Proposed:

1. `start_oauth_route` parses `state` from the `authorization_url` OC
   returns and stores it on the pending row (`oauth_state`, unique index,
   `expires_at = now + 10 min`).
2. `/oauth/callback` looks up `state` from the query. Unknown or expired →
   400, request never forwarded (replay/forgery cut at the gateway).
   Known → forward to OC as today, and on 2xx run `finish_connection`
   for that row synchronously, then serve a tiny "you can close this
   window" page (or redirect to the frontend with `?connected=<provider>`).
3. Frontend: `ConnectDialog` listens for `window.postMessage`/`storage`
   event from the popup, or refetches once on popup close. No interval.

Removes H3, H4's zombie window, and M12 in one change. `list` route becomes
a pure read.

### 4.3 Token scoping model (fixes C1 properly)

Keep one runtime token per workspace, but make `allowedConnections` the
set of all Connected rows. Rotation triggers: any connect, any disconnect.
`service::rotate_workspace_token(ws)` becomes the single function that
computes the set, creates, encrypts, delivers, revokes. Connect/disconnect
call it; a future rotation daemon calls it too.

### 4.4 Cache what is static

`GET /integrations/providers` is identical for every caller: build the
`Vec<ProviderSummary>` once at startup (after resolving OAuth creds) and
serve with `Cache-Control: max-age=300`.

---

## 5. Test gaps worth closing first

1. **Two providers on one workspace** → `execute_action` for the first
   still works (would have caught C1). Gateway integration test with a
   `wiremock` OpenConnector stub recording `POST /api/runtime-tokens`
   bodies.
2. Connect against a **nonexistent / not-ready workspace** creates no OC
   connection (C2).
3. MCP proxy: **wrong bearer N times** → 429/lockout; OC **timeout** →
   504 within the configured budget (H1/H5).
4. `forward_mcp` with OC returning **HTTP 500 + JSON**, and an SSE body
   with multi-line `data:` (M6).
5. Wrapper `relay_mcp_call` with gateway **401/403/502** (H8);
   `find_action` where one guide fetch fails (M14).
6. Auth middleware applied via route group: assert the exact public
   route set by enumerating the router, not by string tests.
7. Frontend: OAuth popup closed early → dialog shows error, polling
   stops (or, after §4.2, single refetch).

---

## 6. Suggested order

| Step | Items | Size |
| --- | --- | --- |
| 1 | C1, C2, H4, M3 (all inside `finish_connection`/connect ordering) + tests 1–2 | 1 day |
| 2 | H1 timeouts, H2 `AppError`, H7 `tracing`, M6 status/SSE | 1 day |
| 3 | H5 constant-time + MCP lockout, H8 wrapper status mapping, M14/M15 | 0.5 day |
| 4 | O1 compose + O2 bootstrap; pin OC | 0.5 day |
| 5 | §3.1 steps 2–5 (AppState, split route.rs, shared docker/http) | 2 days |
| 6 | §4.2 state-bound callback, drop polling; §4.3 rotate function | 1.5 days |
| 7 | M11 integer timestamps migration, H6 generation decision, L-items, docs split | 1 day |

Steps 1–4 are safe to land on this branch before merge. Steps 5–7 are
better as their own PRs after merge, each keeping the test count green.
