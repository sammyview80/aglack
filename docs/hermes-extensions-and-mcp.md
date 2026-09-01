# Hermes plugins (Extensions) and MCP — research notes

Research for the revamp platform: how the upstream Hermes WebUI supports
plugins ("Extensions") and MCP, what the revamp stack already uses, and
what an integration would look like. Sources are the pinned upstream
checkout (`backend/upstream`, see `backend/UPSTREAM.md`) and this repo's
own wrapper/seeder code — file references below are exact.

## 1. Plugins: the upstream "Extensions" surface

Upstream deliberately has **no plugin marketplace or dependency system**.
What it has instead is a small, opt-in **Extensions** surface
(`backend/upstream/docs/EXTENSIONS.md`):

- Serves files from one configured local directory at `/extensions/...`.
- Injects same-origin CSS into `<head>` and same-origin JS before
  `</body>` of the app shell.
- A local JSON manifest lists bundled scripts/styles to inject.
- Extension JS runs with **full WebUI session authority** — it can call
  every API the logged-in user can call. Trust model: only install code
  you trust as much as the WebUI source itself.
- Extensions cannot: bypass auth, serve files outside the extension dir,
  load third-party scripts via the built-in injection config, or register
  new backend routes.

Two ways to enable:

1. **One-click gallery install** — Settings → Extensions. First install
   creates a WebUI-managed directory `STATE_DIR/extensions`
   (e.g. `~/.hermes/webui/extensions/`); gallery installs load on the
   next app-shell render, no env vars, no restart. The vetted gallery
   lives in a separate public repo:
   `hermes-webui/hermes-webui-extensions` (entries, authoring
   conventions, JSON schema, CI safety gates).
2. **Manual** — `HERMES_WEBUI_EXTENSION_DIR` env var overrides the
   managed default (advanced/self-hosted).

### What this means for revamp

Each tenant container runs the full upstream WebUI, so the Extensions
surface already exists inside every workspace container today — nothing
to build to get baseline support. Integration options, smallest first:

- **Nothing (works now):** a user opens the container's WebUI
  (gateway `/workspaces/:id/hermes-webui/` proxy) and installs from the
  gallery via Settings → Extensions. State persists in the container's
  `/config` volume alongside sessions.
- **Pre-seeded extensions:** the workspace image boot script
  (`rust_gateway/src/workspaces/container/boot_script.rs`) already sets
  env and seeds state; it could set `HERMES_WEBUI_EXTENSION_DIR` to a
  baked directory, or the seeder could copy extension bundles into
  `STATE_DIR/extensions` the same way it seeds skills. This is how a
  "revamp default extension" (e.g. branding, per-agent dashboard) would
  ship to every new workspace.
- **Per-mode extensions:** `backend/seeder/modes/<mode>/` could grow an
  `extensions/` directory mirrored by `agent_seeder/service.py`, matching
  the existing skills/tools seeding pattern.

Caveat: extension JS has full session authority inside the container's
WebUI. Since the gateway currently has **no auth gate** on workspace
proxies (known gap since CHECKPOINT4), pre-seeding third-party extensions
widens the blast radius — vet anything seeded by default.

## 2. MCP in upstream Hermes

Two distinct MCP directions exist upstream:

### a. Hermes Agent as MCP *client* (config.yaml `mcp_servers`)

A profile's `config.yaml` can declare MCP servers the agent connects to:

```yaml
mcp_servers:
  <name>:
    command: /path/to/python3
    args: [/path/to/server.py]
    env:
      SOME_VAR: value
```

The WebUI also has a management API for these entries
(`backend/upstream/api/routes.py`):

- `GET /api/mcp/servers` — list
- `GET /api/mcp/tools` — tools exposed by configured servers
- `POST /api/mcp/servers/<name>` — toggle
- update/delete handlers (`_handle_mcp_server_update`,
  `_handle_mcp_server_delete`)

### b. WebUI as MCP *server* (`backend/upstream/mcp_server.py`)

A stdio MCP server exposing project/session management as MCP tools for
any MCP-compatible agent. Runs with `python3 mcp_server.py`, needs
`pip install "mcp>=1.28,<2"`, honors `HERMES_WEBUI_PASSWORD` and an
optional `--profile` override. It imports the WebUI's own `api.models` /
`api.profiles` for locking/scoping/validation, so it stays consistent
with the UI.

## 3. What revamp already does with MCP

The agent seeder **already writes an MCP server entry per agent
profile**:

- `backend/wrapper/src/hermes_webui_wrapper/features/agent_seeder/service.py`
  (`_apply_mcp_tools`) seeds each agent's tools and writes one
  `mcp_servers.hermes-seeder` entry into that profile's `config.yaml`.
- The entry is built by `seeder_kit.build_mcp_server_entry`
  (`backend/seeder_kit/src/seeder_kit/mcp_config.py`): `{"command":
  <python>, "args": [runner_entry_point, --server-name, ..., --tools-dir,
  ...]}`. The Python executable comes from `SEEDER_KIT_RUNNER_PYTHON`
  (falls back to `python3` on PATH at launch time in the container —
  deliberately never the seeder process's own `sys.executable`).
- Never clobbers: like every other seeder step, an existing entry is not
  overwritten.

So "MCP addition" is not greenfield — the per-agent MCP plumbing exists
and is exercised by wrapper tests. What does **not** exist yet:

## 4. Gaps / candidate next steps

| Idea | Effort | Notes |
| --- | --- | --- |
| Expose upstream `/api/mcp/*` through the gateway | Small | Already reachable via the catch-all `hermes-webui` proxy; a dedicated namespace would follow the `agent_seeder_proxy` pattern (one new `<name>_proxy.rs` + `register_workspace_proxy_pair`). |
| Wrapper v1 route to add/remove `mcp_servers` entries per agent | Medium | Same shape as `agent-config`; reuse `features/profile_yaml.py` merge helpers so it composes with the seeder's never-clobber rule. |
| Per-mode MCP servers in seeder modes | Small | `modes/<mode>/agents/<agent>/` could declare extra MCP entries; `_apply_mcp_tools` is the single chokepoint to extend. |
| Run `mcp_server.py` inside each container | Small | The image already ships the upstream tree; would let external agents manage a workspace's sessions over MCP. Needs the `mcp` pip dependency in the image and a consented port/stdio story through the gateway. |
| Frontend UI for MCP servers | Larger | Upstream WebUI already renders its own settings; revamp frontend would only need this if MCP management should happen outside the embedded WebUI. |

Security note (applies to every row): the gateway still has no auth gate
on `agent-config`/`agent-seeder` (known gap, CHECKPOINT4/5). MCP entries
execute arbitrary commands inside the container when the agent starts —
any route that writes `mcp_servers` must be behind auth before public
exposure.
