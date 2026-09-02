# Agent-history proxy — plan (plain language)

Status: **planning only, nothing built yet**. This is the "how" before the
"code."

## What we're building

A fifth per-workspace wrapper-namespace proxy, alongside the existing
onboarding, agent-seeder, hermes-webui, and desktop proxies:
`ANY /workspaces/:id/agent-history/*path` (plus its no-trailing-path
sibling, `/workspaces/:id/agent-history/`). It lets a frontend panel ask
"what did agent X say in session Y, inside workspace Z" without knowing
which port that workspace's wrapper actually landed on.

## Why a thin proxy, not gateway-side logic

The gateway does not know anything about agents, sessions, or messages —
that data lives entirely in the wrapper
(`backend/wrapper/src/hermes_webui_wrapper/api/v1/agent_history.py`),
which reads it off disk per workspace. The gateway's only job is the same
one it already does for onboarding/agent-seeder/hermes-webui/desktop:
resolve `workspace_id` to a live wrapper address, and forward the request
there with the `/workspaces/:id/agent-history` prefix rewritten to
`/api/wrapper/v1/agent-history`. `agent_history_proxy.rs` is a few lines
delegating to `wrapper_prefix_proxy::forward_to_wrapper_namespace` — see
`agent_seeder_proxy.rs` for the exact shape it mirrors. No new business
logic, no new state, no new module beyond the one thin file.

## The three wrapper endpoints this exposes

- `GET .../agent-history/agents` — list agents that have any recorded
  history in this workspace.
- `GET .../agent-history/agents/:agent/sessions` — list that agent's
  sessions (id, title, message count, last-message time).
- `GET .../agent-history/agents/:agent/sessions/:session_id/messages` —
  the actual message list for one session.

The gateway does not special-case any of these paths — whatever segment
sequence the frontend requests under `agent-history/`, the proxy strips
the `/workspaces/:id/agent-history` prefix and forwards the rest
untouched, same as every other wrapper-namespace proxy.

## Gateway-level error codes

Before any request reaches the wrapper, the shared `resolve.rs` lookup
(used by every per-workspace proxy route) can already fail two ways, and
this feature doesn't change either:

- `workspace_not_found` (404) — the `workspace_id` in the URL has no
  matching row at all.
- `workspace_not_ready` (409) — the row exists but hasn't reached
  `Ready` yet (`Creating`) or never will (`Failed`) — there is no live
  wrapper port to forward to.

Both are asserted directly against the real router in this module's
tests, the same way the other namespace proxies assert them.

## Why read-only, fresh-on-open, no polling

Agent history is a record of what already happened — there is no
"live" state to keep in sync the way, say, a workspace's running status
is. The frontend panel fetches once when a user opens it (or explicitly
hits refresh), and does not re-fetch on a timer or over a websocket. That
keeps this feature within the gateway's existing "thin proxy, no new
runtime cost" shape — no background polling loop hammering every
workspace's wrapper on an interval, no new long-lived connection for the
gateway to manage. If a user wants the latest, they reopen the panel or
press refresh; the endpoints are cheap enough (a filesystem read on the
wrapper side) that re-fetch-on-demand is the right tradeoff over adding
any push mechanism.

## Where things live

- `workspaces/agent_history_proxy.rs` — the two thin handlers
  (`agent_history_proxy_route_with_path`, `agent_history_proxy_route_root`)
  plus its own behavior tests (unknown-id 404, not-ready 409,
  prefix-strip rewrite, query-string passthrough).
- `app.rs` — registered via `register_workspace_proxy_pair`, next to the
  other four namespace proxies, and added to
  `every_proxy_feature_prefix_is_reachable_through_the_real_router`'s URI
  list.

No new module, no new store, no new config — this reuses
`WorkspacesState`/`resolve.rs`/`wrapper_prefix_proxy.rs` exactly as they
stand today.
