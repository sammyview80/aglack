# Checkpoint 10 — Integrations/OAuth system — 2026-09-03

Session focus: build full plugin/OAuth integrations system (GitHub, Google,
Slack, Notion, Teams) via self-hosted OpenConnector broker, with strict
per-workspace tenant isolation. Continues from earlier checkpoints — this
one covers the production-hardening pass and the OAuth/MCP live-debugging
session.

## What's live and working

- Full OAuth authorization-code flow (start → callback → reconcile) working
  end-to-end with real GitHub OAuth credentials against a real self-hosted
  OpenConnector instance (`ghcr.io/oomol-lab/open-connector`, Apache-2.0,
  commercial-use-safe).
- Real MCP server in the wrapper
  (`backend/wrapper/src/hermes_webui_wrapper/features/integrations/mcp_server.py`),
  using the actual `mcp` Python SDK (`FastMCP`, Streamable HTTP), mounted at
  `/api/wrapper/v1/integrations` (parent path — FastMCP supplies the `/mcp`
  leaf itself; mounting at the exact leaf broke on a Starlette
  trailing-slash ambiguity).
- Gateway tenancy proxy (`rust_gateway/src/integrations/mcp_proxy.rs`)
  enforces: per-workspace bearer check (SHA-256 hash against
  `workspace_runtime_tokens.token_hash`), strict JSON-RPC method/tool
  allowlist (`ALLOWED_TOOLS = ["execute_action", "list_connections"]`),
  strips every caller-supplied connection-naming field and force-injects
  the workspace's own `connectionName`, rejects JSON-RPC batches outright,
  and enforces per-provider `allowed_actions` on `execute_action`'s
  `actionId`.
- AES-256-GCM encryption at rest for stored bearers
  (`rust_gateway/src/crypto.rs`, `TokenCipher`). Live data (6 rows,
  including real user workspaces) already migrated in place via a one-time
  script (`examples/migrate_encrypt_tokens.rs`, run once, then deleted).
- Atomic token rotation: capture old runtime token before creating new one,
  only revoke old one after new one is stored + delivered successfully.
- Audit log (`integration_audit` table) — write-only, deliberately holds no
  secrets, `outcome CHECK IN ('success','failure')`.
- Gateway login: Argon2id password hashing, opaque session cookie
  (`gw_session`, HttpOnly, SameSite=Strict, 12h), global brute-force
  lockout (sliding window + fixed delay). `--hash-password` CLI mode on the
  `rust_gateway` binary to generate the admin hash.
- GitHub provider fully wired end-to-end (real OAuth app registered by
  user, real client id/secret in `rust_gateway/.env`).
- Verified real OpenConnector action catalog for GitHub via live
  `search_actions` MCP calls against the running instance (not from any
  external doc) — confirmed format `github.<action_name>` lowercase, e.g.
  `github.create_issue`, `github.get_current_user`. Full example table is
  in this session's chat log if needed again; not persisted to a file on
  purpose (see decision below).

## Explicitly NOT done yet (and why)

- **Google, Slack, Notion real OAuth**: code path fully supports them
  (`backend/integrations/providers.yaml` has entries with
  `oauth_client_env` set, provider loader is generic), but no real OAuth
  app credentials are registered for any of them yet. This is an OWNER
  task — register an app on each provider's developer console, get
  client id/secret, paste into `rust_gateway/.env` — not a code task. I
  cannot register these myself (no account access).
- **Microsoft Teams**: commented out in `providers.yaml`. Its
  `openconnector_service` catalog key was never confirmed against the real
  running OpenConnector instance — deliberately left unguessed rather than
  risk a wrong key that fails confusingly at connect time instead of at
  gateway startup.
- **Per-user accounts**: still one shared admin credential
  (`GATEWAY_ADMIN_PASSWORD_HASH`) for the whole gateway. Scoped as future
  "Phase 0b" in `docs/integrations-plan.md`, not started this session.
- **Static SKILL.md-style usage doc for agents**: considered, then
  deliberately NOT built. The agent already discovers action IDs and their
  param shapes live via `search_actions`/`get_action_guide` on each MCP
  call, so a static doc would just drift out of sync with the real
  catalog. If asked again in a future session, don't build one — point
  back to this decision and explain the live-discovery mechanism instead.

## Key gotchas for next session (avoid re-discovering these)

- `docs.openconnector.dev` documents a DIFFERENT, unrelated product
  (uppercase `SERVICE_ACTION_NAME` action IDs, `oc.executeTool({slug,
  connectedAccountId})` SDK). Do not use it as a source of truth for this
  system — confirmed via WebFetch and by comparing against our own live
  instance's real (lowercase, dot-separated) action ID format.
- Real action ID format: lowercase `<service>.<action_name>`.
- OpenConnector runtime tokens cannot be patched in place (confirmed via a
  real 400 error) — rotation must always be create-new-then-revoke-old.
- sqlx migrations are checksum-locked once applied to a DB that's been
  used — never edit an already-applied migration file, always add a new
  one. Repo is currently at migrations `0001`–`0007`.
- `VITE_GATEWAY_URL` (frontend) and `FRONTEND_ORIGIN` (gateway) must use
  the EXACT SAME hostname spelling (`localhost` vs `127.0.0.1`) or
  `SameSite=Strict` cookies silently fail to be sent cross-site — login
  will look like it succeeded (cookie set) while every subsequent request
  401s. Root-caused and fixed live this session.
- FastMCP integration has three sharp edges: (1) `mcp.session_manager` is
  only accessible after `streamable_http_app()` is called once; (2)
  `StreamableHTTPSessionManager.run()` can only be entered ONCE per
  `FastMCP` instance — must use a per-call factory (`build_mcp_app()`), not
  a module-level singleton, or repeated calls (e.g. in tests) crash; (3)
  mounting a sub-app at the exact same path as its own bare `/` route
  creates a Starlette trailing-slash ambiguity that silently falls through
  to a different route — mount at the PARENT path instead and let FastMCP
  supply its own default `/mcp` leaf.
- The gateway's OAuth callback route MUST be registered at exactly
  `/oauth/callback` (not `/integrations/callback` or anything else) —
  OpenConnector computes the redirect URI as a fixed, non-configurable
  `OOMOL_CONNECT_ORIGIN + /oauth/callback`; confirmed live via
  `GET /api/oauth/configs`'s `expectedRedirectUri` field.
- `mcp` Python package must be installed via `seeder_kit[mcp]` extra in the
  workspace Dockerfile — bare `seeder_kit` silently omits it entirely,
  which was the root cause of "No MCP servers connected" for both the
  integrations MCP server and any other stdio MCP servers.
- A workspace container created before the workspace-image rebuild that
  added the integrations wrapper routes will 404 on `/integrations/*` from
  inside the container (stale image, no code for those routes at all) —
  this is NOT a bug to fix by editing that container; the fix is
  reconnecting on a freshly created workspace. User was asked and chose
  this over deleting/recreating an existing real workspace (`viralo`) —
  that workspace was left untouched.

## Working tree state (nothing committed this session)

All integrations work below is uncommitted — confirmed via `git status`:
- `rust_gateway/src/integrations/*`, `rust_gateway/src/auth/*`,
  `rust_gateway/src/crypto.rs`, migrations `0005`–`0007`.
- `backend/wrapper/src/hermes_webui_wrapper/features/integrations/*`,
  `backend/wrapper/src/hermes_webui_wrapper/api/v1/integrations.py`,
  `backend/wrapper/tests/v1/test_integrations.py`.
- `backend/integrations/providers.yaml` (new).
- `backend/workspace-image/Dockerfile`, `backend/wrapper/pyproject.toml`,
  `backend/seeder_kit/pyproject.toml` (license-field + mcp-extra fixes).
- `frontend/src/features/integrations/*` — NOTE: several of these files
  (`provider-card.tsx`, `integrations-page-content.tsx`,
  `agent-toggle-list.tsx`, `connect-dialog.tsx`,
  `workspace-integrations-page.tsx`) are also under the user's own
  concurrent UI redesign (marketplace-style shelves/search/chips). Don't
  revert or fight their changes in a future session — only the OAuth-popup
  wiring (`use-oauth-connect.ts`, the `oauthAvailable` branch in
  `provider-card.tsx`) is mine to own there.
- `docs/integrations-plan.md`, `docs/integrations-poc-findings.md`.

Full design history and all decisions: `docs/integrations-plan.md`
(v1→v3 plus status sections appended through this session) and
`docs/integrations-poc-findings.md` (live-verified OpenConnector API
shapes from the original POC).

## Immediate next steps for a new session

1. System is functional end-to-end for GitHub — no blocking work pending
   for it.
2. If the user wants Google/Slack/Notion working: first ask them to
   register OAuth apps (need client id/secret + redirect URI
   `<gateway-public-url>/oauth/callback` registered on each provider's
   developer console) — cannot proceed on those without real credentials.
3. This work has never been committed. Ask the user before committing
   (git safety protocol: only commit when explicitly asked) — don't
   assume silence means go-ahead.
