# Integrations POC findings — OpenConnector tenancy spike

Status: DONE. Verified against a real running container, real GitHub
account (via local `gh auth token`), not mocked. Feeds `docs/integrations-plan.md`
(read that first for architecture/security model/phases). This file is the
evidence log: exact commands, exact responses, so the real build (task #2
onward) does not need to re-derive any of this.

Date: 2026-09-03. Image: `ghcr.io/oomol-lab/open-connector:latest`,
digest `sha256:2e439db3be5d674b0b6743033e72d1a8d734875c6c4a9a251a079dfb64c7e411`
(pin this exact digest in compose — `latest` moves).

## What was proven

1. **Cross-tenant isolation holds**, enforced by OpenConnector itself, not
   just by our own code. Two connections (`ws-A`, `ws-B`) on the same
   `github` provider, two runtime tokens each restricted via
   `allowedConnections` to one connection id. Token A against connection B:
   `403`-equivalent `connection_not_allowed` — via MCP `tools/call`
   (`execute_action`), via the plain `POST /v1/actions/:actionId` HTTP path
   with `x-oo-connector-alias: ws-B` header, and with `connectionName`
   omitted entirely (no silent fallback to `default`). No path around it
   found.
2. **Revocation is immediate.** `DELETE /api/runtime-tokens/:id` then any
   call with that token: `401 unauthorized` immediately, no cache lag.
3. **Latency is fine.** `tools/list` (no upstream call): 18–42ms.
   `execute_action` hitting the real GitHub API: 400–750ms — that is
   GitHub's response time, not OpenConnector overhead. No lag concern from
   this architecture.
4. **In-place token update does not work as hoped.**
   `PUT /api/runtime-tokens/:id` with only `{"allowedConnections":[...]}`
   fails: `{"error":{"code":"invalid_input","message":"allowedActions must
   be an array of strings"}}`. The endpoint expects the full policy shape
   resent, not a partial patch. **Confirms the plan's rotate-via-outbox
   design (create new token, verify, revoke old) is the right approach —
   do not attempt in-place mutation.**
5. **Gap we must close ourselves: JSON-RPC batch requests are accepted.**
   `POST /mcp` with a JSON array of two `tools/list` calls returned a
   normal result, not a rejection. Our gateway MCP proxy MUST reject
   batches itself (already specified in `integrations-plan.md`'s security
   model, layer 4) — OpenConnector will not do this for us.
6. **Credential verification is real and per-provider.** Most providers
   (github, a_leads, abstract, 17track, avochato tested) call the real
   upstream API to validate credentials on connect — a fake key is
   rejected with `credential_verification_failed` before any connection
   row is created. Only `no_auth` providers (arxiv, hackernews, npm-without-key,
   etc.) skip this. Plan for provider registration flows: expect a real
   network round-trip and a real failure mode on bad credentials, not just
   local validation.
7. **`oauth/authorizations` requires OAuth client config first.** Calling
   it for a provider with no `PUT /api/oauth/configs/:service` done yet
   returns a clean `oauth_client_config_required` error — good, fails
   loud, not silently.

## Exact API shapes confirmed (source: `oomol-lab/open-connector` v1.4.1,
commit `0a88471b64379e6f84c2f70bec22e44d94e256fa`)

Connect (API key, works same way for OAuth once client is configured):

```
PUT /api/connections/:service
Authorization: Bearer <admin token>
{"authType":"api_key","connectionName":"ws-A","values":{"apiKey":"..."}}
→ 200 {"id":"<uuid>","service":"github","connectionName":"ws-A","authType":"api_key",
       "configured":true,"virtual":false,"default":false,
       "profile":{"accountId":"...","displayName":"...","grantedScopes":[]}}
```

Runtime token, scoped to one connection:

```
POST /api/runtime-tokens
{"name":"ws-A","allowedConnections":["<connection-id>"]}
→ 200 {"token":"<bearer, shown once>","record":{"id":"<token-id>",
       "allowedActions":[],"blockedActions":[],"allowedProxies":[],
       "allowedConnections":["<connection-id>"],"createdAt":"..."}}
```

MCP call (Streamable HTTP over plain POST works, no SSE session needed for
single-shot testing):

```
POST /mcp
Authorization: Bearer <runtime token>
Accept: application/json, text/event-stream
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"execute_action",
  "arguments":{"actionId":"github.get_current_user","input":{},"connectionName":"ws-A"}
}}
→ event: message
  data: {"result":{"content":[{"type":"text","text":"{\"ok\":true,\"data\":{...}}"}],
         "structuredContent":{"ok":true,"data":{...}}}}
```

Cross-tenant rejection (the actual proof):

```
same call, connectionName: "ws-B" (not in token A's allowedConnections)
→ data: {"result":{"content":[{"type":"text","text":
  "{\"ok\":false,\"error\":{\"code\":\"connection_not_allowed\",
    \"message\":\"dfcfa886-...-connection is not granted to this runtime token.\"}}"}]}}
```

Note: MCP errors come back as a 200 with `ok:false` inside the tool result
payload, not an HTTP error status. **Our gateway proxy's cross-tenant test
must assert on the JSON body's `ok`/`error.code`, not just HTTP status.**
The plain `/v1/actions/:id` HTTP path DOES use a real HTTP status (403) for
the same rejection — the two surfaces behave differently.

Revoke:

```
DELETE /api/runtime-tokens/:id → {"id":"...","revoked":true}
(any subsequent call with that token) → 401 {"error":{"code":"unauthorized",...}}
```

Delete connection:

```
DELETE /api/connections/:service?connectionName=ws-B
→ 200 {"service":"github","connectionName":"ws-B","configured":false}
```

## MCP tool surface (from `src/mcp.ts` in the OpenConnector source)

Four fixed tools, not one-per-action (hundreds of actions per install would
overload a tool list):

- `list_apps({query?})` — browse provider catalog
- `list_connections({service?})` — list configured connections, filtered
- `get_action_guide({actionId, connectionName?})` — docs for one action
- `execute_action({actionId, input, connectionName?})` — run it

`connectionName` resolution order in OpenConnector itself (not useful to
us since we always inject it, but good to know): `body.connectionName` →
`body.alias` → header `x-oo-connector-alias` → query `connectionName` →
query `alias`. **Our gateway proxy must strip ALL of these from the
inbound request and inject only its own value**, per the plan's layer-4
design — this spike confirms all five need stripping, not just the one
`connectionName` field the plan named first.

## Provider keys confirmed to exist in the catalog

`google` (plus split services `googlecalendar`, `googledocs`,
`googledrive`, `googlesheets` — no single combined `google` catalog entry
was found under that exact name; **re-check exact keys needed for Gmail
specifically** — `gmail` exists as its own entry), `github`, `slack`
(+ `slackbot`), `notion`. Microsoft: `microsoft_clarity`,
`microsoft_text_translate`, `microsoft_todo`, `outlook`, `one_drive` —
**no plain `microsoft-teams` or `teams` key found in this catalog pass.**
Action item for Phase A: confirm whether Teams is supported at all before
committing it to the provider order; may need `microsoft_teams` under a
different name or may not exist yet. Update `providers.yaml`'s
`openconnector_service` values for google (probably `gmail` +
`googlecalendar` + `googledrive` as three separate provider rows, not one
combined `google` row) and flag Teams as unresolved.

## Local repro (throwaway, already torn down)

```bash
docker run -d --name oc-spike -p 3300:3000 \
  -e OOMOL_CONNECT_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  -e OOMOL_CONNECT_ADMIN_TOKEN=spike-admin \
  -e OOMOL_CONNECT_ORIGIN=http://localhost:3300 \
  ghcr.io/oomol-lab/open-connector@sha256:2e439db3be5d674b0b6743033e72d1a8d734875c6c4a9a251a079dfb64c7e411
# then PUT /api/connections/github twice (ws-A, ws-B) with a real gh token,
# POST /api/runtime-tokens twice scoped to each connection id, then the
# MCP calls above.
```

Container and temp token files were removed after the spike; nothing left
running.

## Updates this makes to `docs/integrations-plan.md`

- Phase A ("broker spike, go/no-go") is now DONE for the GitHub case —
  go. Cross-tenant isolation, revocation, and latency are all confirmed
  acceptable.
- The MCP proxy allowlist (plan's security-model item 4) needs one
  correction: strip `alias` and query-string `connectionName`/`alias` too,
  not only the JSON-RPC body field.
- Cross-tenant test assertions (plan's item 10 / phase C) must check the
  tool-result JSON body for MCP calls, not rely on HTTP status — MCP
  wraps provider-level errors inside a 200.
- Google and Microsoft Teams service keys in `providers.yaml` need
  re-verification against the real catalog before Phase F; likely google
  becomes 3 provider rows, not 1, and Teams may not be supported yet.
- Rotation design (create-verify-revoke, never patch) is now confirmed
  necessary, not just cautious — the in-place update API does not support
  a partial change.

## Still open (unchanged from the plan, not addressed by this spike)

- Gateway authentication (Phase 0) — not touched here; this spike talked
  to OpenConnector directly with its admin token, standing in for the
  gateway.
- OAuth authorization-code flow itself (state, callback, redirect) — this
  spike only exercised `api_key` auth type, which skips the browser
  redirect entirely. The `POST /api/oauth/authorizations` response shape
  (`authorizationUrl`) and the callback's post-redirect behavior are still
  unverified against a real provider; needs its own spike once a real
  OAuth app (GitHub's is easiest, no verification) is registered.
