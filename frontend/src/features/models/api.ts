/**
 * Client for rust_gateway's whole-app passthrough proxy
 * (`ANY /workspaces/:id/hermes-webui/*path` -> that workspace's wrapper
 * root -> upstream Hermes' OWN `/api/*`). See
 * `rust_gateway/src/workspaces/proxy/hermes_webui_proxy.rs` — unlike
 * `chat_proxy.rs`, this route does NOT translate a `?agent=` query param
 * into a `Cookie: hermes_profile=<agent>` header; it forwards the request
 * (and whatever `Cookie` header the browser already attached) completely
 * verbatim. That distinction matters a lot for this module — see
 * `setActiveModel`'s doc comment below for the real consequence.
 *
 * Like `chat/api.ts`, this proxy relays upstream Hermes' own JSON bodies
 * whole (not rust_gateway's `{ok,data}` envelope), so this module has its
 * own thin fetch wrapper mirroring `chat/api.ts`'s `chatFetch` rather than
 * going through `apiFetch`.
 */
import { gatewayUrl } from '@/lib/env'
import type { ModelCatalog, SessionModel } from '@/features/models/types'

/** Wire shape of `GET /api/models` (`get_available_models()`,
 * `backend/upstream/api/config.py` ~line 6774, surfaced at
 * `backend/upstream/api/routes.py` ~line 13234):
 * `{active_provider: str|null, default_model: str, groups: [{provider,
 * models: [{id, label}]}]}`. Field names map 1:1 to `ModelCatalog` except
 * for the snake_case remap done in `fetchModelCatalog` below. */
type WireModelCatalog = {
  active_provider: string | null
  default_model: string
  groups: { provider: string; models: { id: string; label: string }[] }[]
}

/** Wire shape of the success body `POST /api/model/set` returns when
 * `scope: "main"` (routed to `set_hermes_default_model`, `backend/upstream/
 * api/config.py` line 4851): `{"ok": true, "model": persisted_model,
 * "provider": persisted_provider|None}`. Confirmed by reading the handler
 * directly — not assumed. */
type WireSetModelResult = { ok: boolean; model: string; provider: string | null }

/** Wire shape of the success body `POST /api/profile/switch` returns
 * (`switch_profile()`, `backend/upstream/api/profiles.py` line 1614,
 * surfaced at `backend/upstream/api/routes.py` ~line 16598):
 * `{"profiles": [...], "active": name}`. This module only needs to know
 * the call succeeded, so the profile list is left untyped/unused here. */
type WireSwitchProfileResult = { active: string }

/** Wire shape of `GET /api/session/status` (`session_ops.py::session_status`,
 * surfaced at `backend/upstream/api/routes.py` line 14040) — only the
 * `model` field this module actually needs is typed; the rest (title,
 * token counts, ...) intentionally follows `chat/api.ts`'s own
 * `WireSessionStatus` partial-view pattern (that file's doc comment on
 * `WireSessionStatus` explains why: model this app's own usage, not the
 * full upstream shape). Confirmed by reading `session_status()` directly:
 * `session_status(sid)` looks the session up by `sid` alone (global
 * `SESSIONS` dict, no profile-cookie gate) — so unlike `/api/model/set`,
 * this read does NOT need the `/api/profile/switch` dance first, it
 * resolves correctly through `hermes_webui_proxy.rs`'s cookie-agnostic
 * passthrough regardless of which profile the sticky cookie names. */
type WireSessionStatus = { model: string | null }

function hermesWebuiBase(workspaceId: string): string {
  return `${gatewayUrl()}/workspaces/${encodeURIComponent(workspaceId)}/hermes-webui`
}

/** Fetch helper for this proxy's raw (non-envelope) Hermes JSON bodies —
 * copy of `chat/api.ts`'s `chatFetch`. Kept as its own small copy rather
 * than shared/exported from `chat/api.ts`: the task's file-organization
 * boundary is "don't touch chat's core logic", and this fetch shape (raw
 * upstream JSON, `{error}` on failure) is a property of the *proxy*, not
 * of chat specifically — `hermes_webui_proxy.rs` and `chat_proxy.rs` both
 * relay upstream's bodies whole for the same reason. */
async function hermesFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new Error('Cannot reach the gateway. Is rust_gateway running?')
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }

  const errorText =
    body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : undefined

  if (!res.ok || errorText) {
    throw new Error(errorText ?? `Model request failed (HTTP ${res.status})`)
  }

  return body as T
}

/** Fetches the FULL model catalog fresh — no client-side caching beyond
 * whatever the caller's React Query `staleTime` imposes (see
 * `use-model-catalog.ts`, which gates this to dialog-open only and treats
 * every open as a fresh fetch, matching the task's "when add model then
 * fetch model all from backend"). `GET /api/models` itself is served from
 * upstream's OWN warm in-memory cache unless config just changed
 * (`get_available_models`'s doc comment, config.py line 6777) — this call
 * does not force a live provider re-probe, it just always reaches the
 * network instead of trusting a client-side stale copy. */
export async function fetchModelCatalog(workspaceId: string): Promise<ModelCatalog> {
  const data = await hermesFetch<WireModelCatalog>(`${hermesWebuiBase(workspaceId)}/api/models`, {
    method: 'GET',
  })
  return {
    activeProvider: data.active_provider,
    defaultModel: data.default_model,
    groups: data.groups.map((g) => ({
      provider: g.provider,
      models: g.models.map((m) => ({ id: m.id, label: m.label })),
    })),
  }
}

/**
 * Sets the ACTIVE agent's default model going forward, via the real,
 * confirmed `POST /api/model/set` with `scope: "main"` (routes.py ~line
 * 15477 -> `set_hermes_default_model`, config.py line 4780). This
 * persists to that profile's `config.yaml` (`_get_config_path()` ->
 * `get_active_hermes_home()`) — a real, durable setting change, not a
 * fake per-turn-only override.
 *
 * REAL AMBIGUITY FOUND AND HOW IT'S RESOLVED: `/api/model/set` has no
 * `agent`/`profile` field of its own — "which agent" is decided entirely
 * by upstream's per-request `hermes_profile` cookie
 * (`api/helpers.py::get_profile_cookie`, read by `server.py` at the top
 * of every request into `api/profiles.py`'s per-request thread-local; see
 * `get_active_profile_name()`'s doc comment, profiles.py line 467). Chat's
 * own proxy (`chat_proxy.rs`) works around the browser's one-cookie-per-
 * origin limit by translating `?agent=` into that cookie PER REQUEST
 * server-side. `hermes_webui_proxy.rs` — the proxy this feature is
 * required to use — does NOT do that translation (confirmed by reading
 * it: it is a bare prefix-rewrite passthrough with no cookie handling at
 * all). That means a raw `POST .../hermes-webui/api/model/set` would
 * silently apply to whatever profile the browser's *sticky*
 * `hermes_profile` cookie currently happens to hold — which is a real,
 * global, cross-agent footgun (agent B's cookie could still be set from
 * switching to agent B in some OTHER tab), not the agent the caller
 * actually passed in.
 *
 * The one real per-client mechanism that changes which profile that
 * cookie names is upstream's own `POST /api/profile/switch`
 * (`switch_profile(name, process_wide=False)`, profiles.py line 1599) —
 * called with `process_wide=False` it is cookie+thread-local scoped only
 * (does not touch the process-global active profile, does not require no
 * agent to be running, and returns a `Set-Cookie: hermes_profile=<agent>`
 * this browser will keep). So this function switches to `agent` FIRST,
 * THEN sets the model — making the two-request sequence line up with the
 * agent the caller actually asked for, instead of gambling on whatever
 * the cookie already said. Both calls go through this same proxy path.
 */
export async function setActiveModel(
  workspaceId: string,
  agent: string,
  provider: string,
  model: string,
): Promise<void> {
  await hermesFetch<WireSwitchProfileResult>(`${hermesWebuiBase(workspaceId)}/api/profile/switch`, {
    method: 'POST',
    body: JSON.stringify({ name: agent }),
  })
  await hermesFetch<WireSetModelResult>(`${hermesWebuiBase(workspaceId)}/api/model/set`, {
    method: 'POST',
    body: JSON.stringify({ scope: 'main', provider, model }),
  })
}

/**
 * Reads which model a SPECIFIC session is actually on right now, via the
 * real `GET /api/session/status` (`session_ops.py::session_status`,
 * `s.model`) — the session's own persisted field, not the agent-wide
 * default. `s.model` is refreshed from the resolved default on every
 * `/api/chat/start` (`_prepare_chat_start_session_for_stream`, routes.py
 * line 22557), so after `setActiveModel` switches the agent default and
 * the user sends (or has already sent) a turn in this session, this call
 * reflects that change — "switch model, session continues on it" is a
 * property of that existing upstream behavior, not something invented
 * client-side. Returns `model: null` for a session that has never sent a
 * turn yet (the field starts unset — see `Session.__init__`, models.py
 * line 1264).
 */
export async function fetchSessionModel(
  workspaceId: string,
  sessionId: string,
): Promise<SessionModel> {
  const data = await hermesFetch<WireSessionStatus>(
    `${hermesWebuiBase(workspaceId)}/api/session/status?session_id=${encodeURIComponent(sessionId)}`,
    { method: 'GET' },
  )
  return { model: data.model }
}
