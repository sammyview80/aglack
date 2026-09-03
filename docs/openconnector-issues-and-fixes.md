# OpenConnector integration — issue report and remediation guide

Date: 2026-09-03. Branch `integration/openconnector` @ `f99b1c6`.
Companion to `openconnector-audit-and-refactor.md` (which holds the
structure/folder proposal). This document is the **work list**: one
entry per issue, each with symptom, root cause, evidence, the fix, the
test that proves it, and size. Research only; nothing here has been
applied.

Baseline at time of writing: `cargo test` 179 pass, `pytest` 117 pass,
`vitest` 162 pass. All issues below are in paths the suites do not cover.

Legend: **P0** ship-blocker (breaks the feature or isolation),
**P1** fix before any non-localhost deployment, **P2** correctness /
maintainability debt, **P3** cleanup.

---

## Quick index

| ID | P | Area | One line |
| --- | --- | --- | --- |
| [GW-01](#gw-01) | P0 | gateway | Connecting a second provider revokes access to the first |
| [GW-02](#gw-02) | P0 | gateway | Connect creates OpenConnector connection before validating workspace → orphaned credentials |
| [GW-03](#gw-03) | P1 | gateway | No HTTP timeouts on any outbound client |
| [GW-04](#gw-04) | P1 | gateway | Raw upstream error bodies returned to browser and containers |
| [GW-05](#gw-05) | P1 | gateway | OAuth completion detected by polling; N+1 OpenConnector calls |
| [GW-06](#gw-06) | P1 | gateway | `oauth/start` failure leaves row `pending` for 10 minutes |
| [GW-07](#gw-07) | P1 | gateway | MCP bearer check: non-constant-time, no lockout, unauthenticated route |
| [GW-08](#gw-08) | P1 | gateway | `generation` documented as enforced, never read; non-atomic increment |
| [GW-09](#gw-09) | P1 | gateway | Audit log best-effort with no logging; no `tracing` at all |
| [GW-10](#gw-10) | P2 | gateway | `Connected` written before token exists; compensating `mark_error` |
| [GW-11](#gw-11) | P2 | gateway | DB error on previous-token lookup silently skips revocation |
| [GW-12](#gw-12) | P2 | gateway | Token delivery: 4 docker spawns, plaintext host tmp file, no timeout |
| [GW-13](#gw-13) | P2 | gateway | `forward_mcp` ignores HTTP status; naive SSE parse |
| [GW-14](#gw-14) | P2 | gateway | Duplicated `workspace_connection_name`, `run_docker`, wrapper proxy, `sha256_hex` shim |
| [GW-15](#gw-15) | P2 | gateway | `find_action` in gateway allowlist; tool list maintained in three places |
| [GW-16](#gw-16) | P2 | gateway | Epoch-second strings in TEXT columns compared as strings |
| [GW-17](#gw-17) | P2 | gateway | OAuth `state` never bound at the gateway |
| [GW-18](#gw-18) | P2 | gateway | SQLite pool: no WAL, no busy_timeout |
| [GW-19](#gw-19) | P3 | gateway | Env read per request in `oauth_credentials`; `set_var` in tests |
| [GW-20](#gw-20) | P3 | gateway | Unencoded query param, case-sensitive `Bearer`, clippy warnings |
| [WR-01](#wr-01) | P1 | wrapper | `relay_mcp_call` ignores HTTP status |
| [WR-02](#wr-02) | P2 | wrapper | New `httpx` client per call; sequential `find_action` fetches |
| [WR-03](#wr-03) | P2 | wrapper | `guide_ok` defaults true on missing key; tools do not catch `IntegrationsError` |
| [WR-04](#wr-04) | P2 | wrapper | Provider-specific skill exclusions hard-coded; relay errors swallowed at debug |
| [FE-01](#fe-01) | P2 | frontend | Popup close not detected; poll loop unhandled rejections; no `noopener` |
| [FE-02](#fe-02) | P3 | frontend | Login redirect path unvalidated; unused `Badge` |
| [OPS-01](#ops-01) | P1 | ops | No compose/deployment for OpenConnector; example config publishes its port |
| [OPS-02](#ops-02) | P2 | ops | First-run scripts unaware of three new required secrets |
| [OPS-03](#ops-03) | P2 | ops | No structured logs, request ids, health check |
| [OPS-04](#ops-04) | P3 | ops | Key rotation undefined; CI triggers miss this branch; `checkpoints/` at root |

---

## Gateway

<a id="gw-01"></a>
### GW-01 · P0 · Second provider revokes the first

**Symptom.** Connect GitHub, then Slack, on one workspace. Agent calls
`execute_action` with `github.*` → OpenConnector returns
`connection_not_allowed`. GitHub shows "connected" in the UI.

**Root cause.** `rust_gateway/src/integrations/route.rs:558-562`

```rust
let runtime_token = state.openconnector
    .create_runtime_token(&token_name, &connection_summary.id)   // ONE id
```

then `:647-654` revokes the previous token. `create_runtime_token`
(`openconnector.rs:219-238`) hard-codes
`"allowedConnections": [allowed_connection_id]`. One token per workspace,
scoped to whichever provider connected last.

**Evidence.** No test creates two connections on one workspace
(`grep -n "providers = \[" mcp_proxy.rs` shows single-provider fixtures
only). Comment at `route.rs:701-707` admits narrowing on disconnect is
missing, but does not notice widening on connect is missing too.

**Fix.**

1. `openconnector.rs`: `create_runtime_token(name, allowed: &[&str])`.
2. New `service::rotate_workspace_token(state, workspace_id)`:
   ```text
   ids   = store.list_connections(ws).filter(status == Connected).map(openconnector_connection_id)
   if ids.empty()  → revoke current token, delete row, remove token file; return
   prev  = store.find_runtime_token(ws)?          // propagate Err (see GW-11)
   new   = openconnector.create_runtime_token("workspace:<ws>", &ids)
   store.upsert_runtime_token(ws, new.id, sha256(new.bearer), cipher.encrypt(new.bearer))
   token_delivery.deliver(container, new.bearer)
   if prev && prev.id != new.id → openconnector.revoke_runtime_token(prev.id)
   ```
3. `finish_connection` = upsert row `Connected` → `rotate_workspace_token`.
   `disconnect` = delete OC connection → mark row → `rotate_workspace_token`
   (replaces the ad-hoc "last one out" block at `route.rs:708-738`).

**Test.** Gateway integration test with a stub OpenConnector (see
[Testing infrastructure](#testing-infrastructure)): connect `github`, connect
`slack`, assert the second `POST /api/runtime-tokens` body has both
connection ids; disconnect `slack`, assert third body has only GitHub's.

**Size.** ½ day including the stub.

---

<a id="gw-02"></a>
### GW-02 · P0 · Orphaned OpenConnector connections

**Symptom.** `POST /workspaces/<typo>/integrations/github/connect` with a
real API key → gateway answers `409 workspace_not_ready`, but OpenConnector
now holds a working connection `ws-<typo>` with that key. Nothing deletes
it. Same for a deleted workspace, or one still `Creating`.

**Root cause.** `route.rs:420-465` calls `connect_with_api_key` first;
the workspace lookup happens inside `finish_connection_inner` at
`:603-621`. `start_oauth_route` (`:293-354`) and
`list_integrations_route` never check the workspace at all.

**Fix.**

- First statement of `connect`, `oauth/start`, `list`, `disconnect`,
  `agents*`: `let ports = resolve_ready_workspace(&state.workspace_store, &workspace_id).await?;`
  (`workspaces/resolve.rs` already exists and returns the right 404/409).
- Compensation: in `connect_integration_route`, if anything after
  `connect_with_api_key` fails, `let _ = openconnector.delete_connection(service, name)`
  and audit `connect_compensated`.
- Workspace delete (`workspaces/route/delete.rs`) should call
  `integrations::service::purge_workspace(ws)` → delete every OC connection
  for `ws-<id>`, revoke token, drop rows. Today deleting a workspace leaves
  its provider credentials alive in OpenConnector.

**Test.** Connect against unknown workspace → stub records zero
`PUT /api/connections/*`. Delete workspace with two connections → stub
records two `DELETE /api/connections/*` and one `DELETE /api/runtime-tokens/*`.

**Size.** ½ day.

---

<a id="gw-03"></a>
### GW-03 · P1 · No outbound timeouts

**Symptom.** OpenConnector (or a workspace wrapper) stops answering →
every MCP request from every container hangs until the *wrapper's* 30 s
client timeout; gateway tasks pile up; `GET /workspaces/:id/integrations`
hangs the UI.

**Root cause.** `openconnector.rs:92`, `bin/rust_gateway.rs:74,110,157`
all use `reqwest::Client::new()` (no timeout). `token_delivery.rs`
`Command::new("docker")` has no timeout either.

**Fix.**

```rust
// shared/http.rs
pub fn json_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(90))
        .build().expect("reqwest client")
}
pub fn stream_client() -> reqwest::Client { /* connect_timeout only; SSE never ends */ }
```

One `json_client` in `AppState`, used by `OpenConnectorClient` and the
two wrapper forwards. Keep `stream_client` for chat/desktop proxies.
Docker: `tokio::time::timeout(Duration::from_secs(20), cmd.output())`.
Map timeout → `504 upstream_timeout`.

**Test.** Stub OC with a 5 s delay on `/mcp`; assert gateway returns 504
in < 4 s with `timeout(2s)` configured for tests.

**Size.** 2 h.

---

<a id="gw-04"></a>
### GW-04 · P1 · Upstream error bodies leaked

**Symptom.** Wrong API key → browser receives
`openconnector returned 400 Bad Request: {"error":"...","details":{...}}`
verbatim. Same text reaches the agent container via the MCP proxy when OC
rejects a call. Contradicts `integration_audit`'s own "never a raw upstream
error" rule and lets a container probe OC's error surface.

**Root cause.** `openconnector.rs:300-306` embeds `response.text()` into
`OpenConnectorError.message`; every route does `err.to_string()` into the
envelope (`route.rs:446-451, 563-569, 348-352`; `mcp_proxy.rs:198-202`).
Errors are stringly typed (`struct XError { message: String }`) so callers
cannot distinguish "bad key" from "OC down".

**Fix.** One error type:

```rust
// shared/error.rs
pub enum AppError {
    NotFound(&'static str), Conflict(&'static str), BadRequest(&'static str),
    Unauthorized(&'static str), Forbidden(&'static str),
    Upstream { code: &'static str, status: StatusCode, detail: String }, // detail logged, not sent
    Db(sqlx::Error), Crypto(CryptoError), Docker(String), Timeout(&'static str),
}
impl IntoResponse for AppError { /* envelope with fixed code + short message; tracing::warn!(detail) */ }
```

`OpenConnectorError` becomes an enum: `Rejected { status, body }`,
`Unreachable(reqwest::Error)`, `Timeout`, `BadResponse`. Routes map
`Rejected{400..}` → `502 provider_rejected` with message
"Provider rejected the credential." Body goes to the log only.

Also fixes clippy `result_large_err` (handlers return `Result<_, AppError>`
instead of `Result<_, Response>`).

**Test.** Stub returns 400 with a body containing `SECRET-MARKER`; assert
the gateway response does not contain it.

**Size.** 1 day (touches every route; do together with GW-09).

---

<a id="gw-05"></a>
### GW-05 · P1 · Polling-based OAuth completion, N+1 upstream calls

**Symptom.** While a popup is open the browser calls
`GET /workspaces/:id/integrations` every 2 s; for **each** `pending` row
the gateway calls `GET /api/connections` (full list) on OpenConnector.
Ten users mid-connect ≈ 50 OC list calls/s. If the user closes the popup,
this continues for 600 s (see FE-01). OC errors are swallowed
(`.ok().flatten()`, `route.rs:190-195`) so an outage looks like "still
pending" until the timeout flips it to "timed out".

**Root cause.** The gateway does not learn when OAuth completes because
`/oauth/callback` (`route.rs:384-411`) is a blind reverse proxy and no
`state` is tracked (GW-17). Polling was the workaround.

**Fix (short-term, 1 h).** In `list_integrations_route`, if any row is
pending, fetch `GET /api/connections` **once** and match all rows locally.
Return `503 openconnector_unreachable` instead of swallowing.

**Fix (real, ½–1 day).** State-bound callback:

1. `start_oauth_route`: parse `state` from the returned
   `authorization_url` (`Url::parse(..).query_pairs().find(k == "state")`).
   Store `oauth_state`, `oauth_expires_at = now + 600` on the pending row
   (migration 0008 adds both columns + unique index on `oauth_state`).
2. `oauth_callback_route`: read `state` from the incoming query; look up
   the row. Missing/expired → `400 oauth_state_invalid`, **do not forward**
   (replay and forgery stop at the gateway). Found → forward to OC as
   today; if OC returned 2xx, call `find_connection(service, name)` once and
   run `finish_connection` synchronously. Respond with a minimal HTML page
   that does `window.opener?.postMessage({type:'integration-connected', provider}, FRONTEND_ORIGIN); window.close()`.
3. Frontend: `use-oauth-connect.ts` listens for that message (origin-checked)
   and invalidates the connections query. Delete the interval and the 600 s
   timer. Keep a `popup.closed` watcher for the "user closed it" case
   (one refetch, then mark `error` via a new `POST .../oauth/cancel`, or let
   the server-side expiry handle it).

`list_integrations_route` becomes a pure read.

**Test.** Callback with unknown `state` → 400 and stub sees no request.
Callback with known state → stub sees `/oauth/callback?...`, then
`/api/connections`, then `/api/runtime-tokens`; row is `connected`.

---

<a id="gw-06"></a>
### GW-06 · P1 · `oauth/start` failure leaves row `pending`

**Root cause.** `route.rs:315-353`: `mark_pending` runs before
`create_oauth_authorization`; the `Err` arm returns 502 but never updates
the row. UI spinner until `OAUTH_PENDING_TIMEOUT_SECS` (600 s) expires it.

**Fix.** Either order (authorize first, then `mark_pending`) or add
`state.store.mark_error(ws, provider, "Could not start the provider sign-in.")`
in the `Err` arm. Prefer the reorder: no row exists for a flow that never
started.

**Test.** Stub returns 500 on `POST /api/oauth/authorizations` → row is
absent (or `error`), never `pending`.

**Size.** 15 min.

---

<a id="gw-07"></a>
### GW-07 · P1 · MCP bearer verification hardening

**Symptom / risk.** `/workspaces/:id/mcp` is session-exempt
(`auth/middleware.rs:247`), so anything that can reach the gateway port can
send unlimited bearer guesses. Each failure costs the gateway a SQLite
read + hash + audit insert; the attacker pays a TCP round trip.

**Root cause.** `mcp_proxy.rs:130` `sha256_hex(&bearer) != token_record.token_hash`
is a variable-time string compare (comment acknowledges). No failure
counter. The bearer is a 64-hex OpenConnector token, so brute force is
impractical, but the audit table is unbounded and fills on every attempt.

**Fix.**

- `subtle = "2"`; compare `Sha256::digest(bearer).ct_eq(&stored_digest_bytes)`
  (store the hash as raw bytes or decode hex once).
- Reject before hashing if `bearer.len() != EXPECTED_LEN` or not
  `[0-9a-f]` — cheap pre-filter.
- Per-workspace limiter: `DashMap<WorkspaceId, (u32 failures, Instant)>`
  in `IntegrationsState`; after 20 failures in 5 min → 429 for that
  workspace id without touching the DB. Same shape as
  `auth/route.rs:585-665`.
- Rate-limit audit inserts for `mcp_proxy_invalid_bearer` to 1/min per
  workspace with a `count` field, so the table cannot be flooded.

**Test.** 21 wrong bearers → 21st is 429 and store has ≤ 2 audit rows.

**Size.** 2 h.

---

<a id="gw-08"></a>
### GW-08 · P1 · `generation` is dead

**Root cause.** `store.rs` (`WorkspaceRuntimeToken.generation`,
`upsert_runtime_token`) documents "the MCP proxy uses this to reject a
stale bearer". `mcp_proxy.rs` never reads it. The increment is
`SELECT` then `INSERT ... generation = ?` — two round trips, racy under
concurrent connects.

**Fix.** Decide:

- **Drop it** (recommended now): the token hash already changes on
  rotation, so a stale bearer fails the hash compare. Migration 0008 drops
  the column; delete the doc comments.
- **Or implement**: keep `previous_token_hash` + `rotated_at` and accept the
  previous hash for a 30 s grace window (covers the wrapper re-reading the
  file mid-rotation). Atomic increment:
  `ON CONFLICT(workspace_id) DO UPDATE SET generation = workspace_runtime_tokens.generation + 1`.

**Size.** 1 h either way.

---

<a id="gw-09"></a>
### GW-09 · P1 · Silent audit loss, no logging

**Root cause.** 11 call sites do `let _ = state.store.record_audit(..)`.
The gateway has no `tracing`/`log` dependency; startup uses `println!`.
A locked or full SQLite drops the security trail with zero signal.

**Fix.**

- `tracing`, `tracing-subscriber` (env-filter, JSON when
  `GATEWAY_LOG_FORMAT=json`), `tower-http` `TraceLayer` + `request-id`
  layers in `app/layers.rs`.
- `store.record_audit` stays best-effort for the request, but wraps:
  `if let Err(e) = ... { tracing::error!(event, %e, "audit write failed") }`
  via one helper `audit(&state, ev)`.
- Replace `println!/eprintln!` in `bin/rust_gateway.rs` with
  `tracing::info!/error!`.

**Test.** Unit: helper logs at error when the pool is closed (capture with
`tracing-test`).

**Size.** ½ day (together with GW-04).

---

<a id="gw-10"></a>
### GW-10 · P2 · `Connected` written too early

**Root cause.** `route.rs:538-556` upserts the row as `Connected` before
token creation and delivery; a failure later triggers the compensating
`mark_error` in `finish_connection` (`:487-508`). Between the two writes
the UI shows "connected" for a workspace with no token.

**Fix.** With GW-01's `rotate_workspace_token`: rotate first, upsert
`Connected` last. Wrap the two local writes (token row, connection row)
in one `sqlx::Transaction`. Delete the compensating block.

---

<a id="gw-11"></a>
### GW-11 · P2 · DB error skips revocation

**Root cause.** `route.rs:536`
`find_runtime_token(ws).await.ok().flatten()` → a transient SQLite error is
treated as "no previous token", so the old OpenConnector runtime token is
never revoked and stays valid forever.

**Fix.** `?` the error (with `AppError::Db`). Same pattern at
`:714-719` in disconnect.

---

<a id="gw-12"></a>
### GW-12 · P2 · Token delivery

**Root cause.** `token_delivery.rs` spawns `docker` four times
(`mkdir -p`, `cp`, `chown`, `chmod`), writes the bearer to a host temp file
in plaintext first, has no timeout, and re-implements `run_docker` that
exists in `workspaces/container/docker_cli.rs` (private).

**Fix.** Single exec, bearer on stdin, never on host disk:

```rust
let mut child = Command::new("docker")
    .args(["exec", "-i", "-u", "root", container,
           "sh", "-c",
           "umask 077 && install -d -o abc -g abc -m 0700 /run/hermes \
            && cat > /run/hermes/.integrations.token.tmp \
            && chown abc:abc /run/hermes/.integrations.token.tmp \
            && chmod 0400 /run/hermes/.integrations.token.tmp \
            && mv -f /run/hermes/.integrations.token.tmp /run/hermes/integrations.token"])
    .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn()?;
child.stdin.take().unwrap().write_all(bearer.as_bytes()).await?;
tokio::time::timeout(Duration::from_secs(20), child.wait_with_output()).await??;
```

`mv` makes the swap atomic, so the wrapper's per-request read never sees a
partial file (removes the torn-read concern the wrapper review raised).
Move `run_docker` to `shared/docker.rs` as `pub(crate)`.

**Test.** Existing `FakeLauncher` style: assert the argv shape and that
`bearer` is passed via stdin, not argv.

---

<a id="gw-13"></a>
### GW-13 · P2 · `forward_mcp` response handling

**Root cause.** `openconnector.rs:261-287`: status ignored (OC 401/500
with JSON body → returned to the container as HTTP 200); SSE parsed by
`lines().find_map(strip_prefix("data: "))` — first `data:` line only,
multi-line data and multiple events dropped.

**Fix.**

- `if !status.is_success() { return Err(Rejected{status, body}) }` →
  route maps to 502 with fixed code.
- Send `accept: application/json` **only** and verify OC honours it
  (spec-compliant Streamable HTTP servers must); if it still returns SSE,
  parse properly: split on blank line, join consecutive `data:` lines,
  take the event whose JSON `id` matches the request id.

**Test.** Stub returns `event: message\ndata: {"a":\ndata: 1}\n\n` →
parsed `{"a":1}`. Stub returns 500 JSON → gateway 502.

---

<a id="gw-14"></a>
### GW-14 · P2 · Duplication

| Duplicate | Locations | Fix |
| --- | --- | --- |
| `workspace_connection_name` | `route.rs:809`, `mcp_proxy.rs:351` | `integrations/naming.rs`, one `pub(crate) fn` |
| `run_docker` | `token_delivery.rs`, `workspaces/container/docker_cli.rs` | `shared/docker.rs` |
| wrapper proxy | `route.rs:773-807` vs `workspaces/proxy/wrapper_prefix_proxy.rs` (`pub(super)`) | make helper `pub(crate)`; register the two agent routes through it |
| `sha256_hex` shim | `mcp_proxy.rs:87` | update 4 call sites, delete |
| `reqwest::Client` | 3 instances | GW-03 |
| `WorkspaceStore` | 2 handles on one pool | single `AppState` |

---

<a id="gw-15"></a>
### GW-15 · P2 · Tool allowlist drift

**Root cause.** `mcp_proxy.rs:72-79` lists `find_action`, which is
implemented in the **wrapper** (`mcp_server.py:128`) and never forwarded.
The tool list is hand-copied in `mcp_proxy.rs`, `mcp_server.py` docstring,
and `backend/seeder/skills/org-integrations/SKILL.md`.

**Fix.** Remove `find_action` from `ALLOWED_TOOLS`. Add a wrapper test
that asserts the set of `@mcp.tool()` names equals the set documented in
`SKILL.md` (parse the markdown table). Gateway list stays the OC-side
allowlist only.

---

<a id="gw-16"></a>
### GW-16 · P2 · String timestamps

**Root cause.** `store.rs::now_rfc3339` returns epoch seconds as a string;
`auth/store.rs:440` compares `expires_at` strings with `>`;
`route.rs:253-262` parses back to `u64`. Works until someone stores a real
RFC 3339 value.

**Fix.** Migration 0008: `ALTER TABLE ... ADD COLUMN *_at_epoch INTEGER`,
backfill `CAST(col AS INTEGER)`, swap reads, drop TEXT columns in 0009.
`shared/time.rs::now_epoch_secs() -> i64`.

---

<a id="gw-17"></a>
### GW-17 · P2 · OAuth `state` not bound

Covered by GW-05's real fix. Listed separately because it is a security
requirement from the plan's v2 review ("OAuth state binding, expiry,
replay protection") that the status log marks as if done.

---

<a id="gw-18"></a>
### GW-18 · P2 · SQLite pool settings

**Root cause.** `db/mod.rs:18-22` — defaults only. No WAL, no
`busy_timeout`. With the MCP proxy reading per call and audit inserts,
`SQLITE_BUSY` will surface under concurrency.

**Fix.**

```rust
SqliteConnectOptions::from_str(..)?
    .create_if_missing(true)
    .journal_mode(SqliteJournalMode::Wal)
    .synchronous(SqliteSynchronous::Normal)
    .busy_timeout(Duration::from_secs(5))
    .foreign_keys(true);
SqlitePoolOptions::new().max_connections(8)
```

**Test.** Existing `connect_creates_*` test + `PRAGMA journal_mode` == `wal`.

---

<a id="gw-19"></a>
### GW-19 · P3 · Env reads per request

`providers.rs::oauth_credentials` reads `std::env` on every
`GET /integrations/providers`; tests call `std::env::set_var` (racy, and
`unsafe` in edition 2024). Resolve once at load into
`Provider.oauth: Option<OAuthClient>`; `load_providers(path, env: &dyn Fn(&str)->Option<String>)`
so tests inject a map.

---

<a id="gw-20"></a>
### GW-20 · P3 · Small items

- `openconnector.rs:196-204` `?connectionName={name}` unencoded → `.query(&[..])`.
- `mcp_proxy.rs:206-213` `strip_prefix("Bearer ")` → case-insensitive scheme.
- `cargo clippy --fix`: four `assert_eq!(x, true)`; large `Err` fixed by GW-04.
- `IntegrationsState.providers: Vec` → `HashMap<ProviderId, Provider>` +
  `HashMap<Service, ProviderId>` (MCP hot path does a linear `find`).
- `bin/rust_gateway.rs:11-13` doc says auth "NOT YET IMPLEMENTED".

---

## Wrapper (`backend/wrapper`)

<a id="wr-01"></a>
### WR-01 · P1 · Relay ignores HTTP status

**Symptom.** After a token rotation, the wrapper's next call gets gateway
`401 {"ok":false,"error":{"code":"invalid_bearer",...}}`. `relay_mcp_call`
(`service.py:99-111`) does `response.json()` and returns it; `_unwrap`
(`mcp_server.py:51-68`) looks for `"error"` (JSON-RPC shape) — the gateway
envelope has `error` nested under `ok:false`, so the agent receives
`{"ok": false, "error": {...}}` by luck for that case, but a `403
tool_not_allowed`, `429`, `502`, or a non-envelope 5xx becomes an opaque
dict with no `code`.

**Fix.**

```python
response = _client().post(url, json=body, headers=headers)
if response.status_code >= 400:
    try:
        err = response.json().get("error", {})
    except ValueError:
        err = {}
    raise IntegrationsError(
        err.get("code", "integrations_gateway_error"),
        err.get("message", f"Gateway returned HTTP {response.status_code}"),
        response.status_code,
    )
```

**Test.** Parametrize 401/403/429/502/500-html → `IntegrationsError.code`.

---

<a id="wr-02"></a>
### WR-02 · P2 · Client per call, sequential fan-out

`service.py:99` `httpx.post(..., timeout=30.0)` builds a client per call
(new TCP connection each time) and a single-value timeout (30 s to
*connect*). `find_action` (`mcp_server.py:205-246`) issues up to four
relay calls in series.

**Fix.** Module-level
`_client = httpx.Client(timeout=httpx.Timeout(30.0, connect=3.0), limits=httpx.Limits(max_keepalive_connections=4))`
created in `mcp_lifespan`, closed on exit. In `find_action`, run the guide
fetches with `anyio.create_task_group()` over `anyio.to_thread.run_sync`
(the relay is sync), or switch the relay to `httpx.AsyncClient`.

---

<a id="wr-03"></a>
### WR-03 · P2 · Error shape consistency

- `mcp_server.py:234` `guide_result.get("ok", True)` → treat only
  `ok is True` as success.
- Tool bodies (`:93-140`) let `IntegrationsError` propagate; FastMCP turns
  it into a generic tool error and the `code` is lost. Wrap each tool:
  `except IntegrationsError as e: return {"ok": False, "error": {"code": e.code, "message": e.message}}`
  — the shape `SKILL.md` already teaches agents to expect.
- Add a `_read_bearer` sanity check (`len < 32` → `integrations_token_missing`).

---

<a id="wr-04"></a>
### WR-04 · P2 · Seeder coupling

`features/agent_seeder/service.py:137-146` hard-codes GitHub bundled-skill
subpaths to exclude when GitHub is connected; `:430-454`
`_connected_provider_ids` catches every exception at `debug`.

**Fix.** Add `bundled_skill_exclusions: [..]` per provider in
`backend/integrations/providers.yaml`; expose through
`GET /integrations/providers`; seeder reads it. Log unexpected exceptions
at `warning`, keep `debug` only for "token file absent" (expected before
first connect).

---

## Frontend

<a id="fe-01"></a>
### FE-01 · P2 · OAuth popup hook

`features/integrations/hooks/use-oauth-connect.ts:45-68`:

1. **Closed popup undetected** — interval runs the full 600 s. Add
   `if (popupRef.current?.closed) { stopPolling(); refetchOnce(); return }`
   at the top of each tick. Disappears with GW-05's postMessage design.
2. **Unhandled rejections** — `await queryClient.fetchQuery(...)` inside
   `setInterval` with no `try/catch`. Wrap; after 3 consecutive failures
   stop and `toast.error('Lost contact with the gateway.')`.
3. **Reverse tabnabbing** — `window.open(url, '_blank', features)` gives
   the provider page `window.opener`. Set `popup.opener = null` after
   open (keeps `popupRef` for `.close()`), or add `noopener` once closing is
   no longer needed (GW-05).
4. Scheme check on `authorizationUrl` (`/^https?:/`).

**Test.** `workspace-chat-clarify.test.tsx` style: mock `window.open`
returning `{closed:true}` → no second `fetchIntegrations` call.

---

<a id="fe-02"></a>
### FE-02 · P3 · Small items

- `pages/login-page.tsx:32-33`: `navigate(from || '/')` → accept only
  `from?.startsWith('/') && !from.startsWith('//')`.
- `components/ui/badge.tsx` unused → delete or use in `provider-card.tsx`.

---

## Setup / operations

<a id="ops-01"></a>
### OPS-01 · P1 · OpenConnector deployment undefined

**Symptom.** A new developer cannot run the feature: nothing in the repo
starts OpenConnector. The only artefact is `.worktrees/oc-spike/`
(git-ignored). `rust_gateway/.env.example` sets
`OPENCONNECTOR_URL=http://localhost:3300`, i.e. OC's admin API is
**published on the host**, protected only by `OPENCONNECTOR_ADMIN_TOKEN`
— the plan's security model says "no published port".

**Fix.** `deploy/docker-compose.yml`:

```yaml
services:
  openconnector:
    image: ghcr.io/oomol-lab/open-connector@sha256:<pin>   # v1.4.1 per poc-findings
    environment:
      OOMOL_CONNECT_ADMIN_TOKEN: ${OPENCONNECTOR_ADMIN_TOKEN}
      OOMOL_CONNECT_ENCRYPTION_KEY: ${OC_ENCRYPTION_KEY}
      OOMOL_CONNECT_ORIGIN: ${GATEWAY_PUBLIC_URL}          # gateway URL, not OC's
    networks: [integrations-net]
    # no `ports:` — reachable only from the gateway
    volumes: [oc-data:/data]
  gateway:
    build: ../rust_gateway
    environment:
      OPENCONNECTOR_URL: http://openconnector:3000
      # ...rest from deploy/.env
    ports: ["8080:8080"]
    networks: [integrations-net, default]
    volumes: [/var/run/docker.sock:/var/run/docker.sock]  # workspace orchestration
networks: { integrations-net: { internal: true } }
```

For dev without compose, keep the published port but bind
`127.0.0.1:3300:3000` and say so in `.env.example`. Record the OC version
and digest in `docs/architecture/integrations.md`.

---

<a id="ops-02"></a>
### OPS-02 · P2 · First-run experience

`GATEWAY_ADMIN_PASSWORD_HASH`, `GATEWAY_TOKEN_ENCRYPTION_KEY`,
`OPENCONNECTOR_ADMIN_TOKEN`, `WORKSPACE_GATEWAY_URL` are all required;
`run.sh` checks none of them. Startup dies with four successive
`invalid configuration` messages.

**Fix.** `bootstrap.sh`: if `.env` lacks `GATEWAY_TOKEN_ENCRYPTION_KEY`,
generate with `openssl rand -base64 32`; if lacks the password hash,
prompt and run `cargo run --bin rust_gateway -- --hash-password`. `run.sh`
pre-flight: grep required keys, print the one-liner to fix each. Add
`--with-openconnector` that `docker compose -f deploy/docker-compose.yml up -d openconnector`.

---

<a id="ops-03"></a>
### OPS-03 · P2 · Observability

Covered by GW-09 (tracing, request ids). Add `GET /healthz` returning
`{db: ok, openconnector: ok|unreachable, docker: ok}` with a 2 s budget,
excluded from the session middleware. Frontend can surface "integrations
unavailable" instead of a spinner.

---

<a id="ops-04"></a>
### OPS-04 · P3 · Housekeeping

- **Key rotation**: document that losing `GATEWAY_TOKEN_ENCRYPTION_KEY`
  means every workspace must reconnect; support
  `GATEWAY_TOKEN_ENCRYPTION_KEY_PREVIOUS` so `TokenCipher::decrypt` tries
  both and re-encrypts on next write.
- **CI**: `.github/workflows/*.yml` trigger on `main, master, aglack` pushes
  only. Add `integration/**` or open the PR so the 8 k-line change runs CI.
- **`checkpoints/`** (16 session logs) → `docs/history/`.
- `.env.example` note: `SameSite=Strict` cookie works across
  `localhost:5173`/`localhost:8080` only because both are `localhost`; a
  split-host deployment needs `Lax` or same-origin hosting.

---

## Testing infrastructure

Most P0/P1 fixes need a fake OpenConnector. Add once, reuse everywhere:

- `wiremock = "0.6"` dev-dependency. `tests/support/openconnector_stub.rs`
  exposes `MockServer` with helpers: `expect_connect(service)`,
  `expect_runtime_token()` (records bodies), `expect_mcp(response)`,
  `fail_with(status, body)`, `delay(ms)`.
- `tests/integrations_flow.rs`: spin `build_router` with a temp SQLite,
  `FakeLauncher`, and the stub URL; drive the HTTP API with `tower::ServiceExt::oneshot`.
- Wrapper: `respx` (already pulled by `httpx` test extras?) or a local
  `http.server` thread fixture returning canned status codes.
- Frontend: existing vitest + `msw`-style fetch mocks; add the popup
  `closed` case.

Concrete new tests, in priority order: GW-01 two-provider scoping;
GW-02 unknown workspace creates nothing; GW-04 secret-marker not leaked;
GW-03 timeout → 504; GW-07 lockout; WR-01 status mapping; FE-01 closed
popup; GW-05 callback state.

---

## Execution plan

| Batch | Items | Est. | Land where |
| --- | --- | --- | --- |
| 1 | Stub infra; GW-01, GW-02, GW-06, GW-10, GW-11 | 1.5 d | this branch, before merge |
| 2 | GW-03, GW-04, GW-09, GW-13, GW-18 | 1.5 d | this branch |
| 3 | GW-07, GW-08 (drop), WR-01, WR-03, FE-01 | 1 d | this branch |
| 4 | OPS-01, OPS-02, OPS-04 CI trigger | 0.5 d | this branch |
| 5 | GW-05 real fix + GW-17 + FE popup rewrite | 1.5 d | follow-up PR |
| 6 | GW-12, GW-14, GW-15, WR-02, WR-04 | 1 d | follow-up PR |
| 7 | GW-16, GW-19, GW-20, FE-02, OPS-03, docs split | 1 d | follow-up PR |

Total ≈ 8 engineer-days. Batches 1–4 (≈4.5 d) make the branch safe to
merge and run on a non-localhost network. Batches 5–7 remove the debt
that would otherwise be copied by the next feature.
