/**
 * Client for rust_gateway's whole-app passthrough proxy
 * (`ANY /workspaces/:id/hermes-webui/*path` -> that workspace's wrapper
 * root -> upstream Hermes' OWN `/api/*`). See
 * `rust_gateway/src/workspaces/proxy/hermes_webui_proxy.rs` — unlike
 * `chat_proxy.rs`, this route does NOT translate a `?agent=` query param
 * into a `Cookie: hermes_profile=<agent>` header; it forwards the request
 * (and whatever `Cookie` header the browser already attached) completely
 * verbatim.
 *
 * Like `chat/api.ts`, this proxy relays upstream Hermes' own JSON bodies
 * whole (not rust_gateway's `{ok,data}` envelope), so this module has its
 * own thin fetch wrapper mirroring `chat/api.ts`'s `chatFetch` rather than
 * going through `apiFetch`.
 *
 * SESSION-SCOPED MODEL SWITCHING — verified against the REAL Hermes WebUI
 * frontend (`backend/upstream/static/boot.js`, `$('modelSelect').onchange`,
 * ~line 2260), not assumed: the shipped composer's own model dropdown does
 * NOT call `POST /api/model/set` (that endpoint changes the AGENT-WIDE
 * default — see `set_hermes_default_model`, only reachable from Settings'
 * "Default Model" picker, `static/panels.js` line 12505). The composer
 * instead calls `POST /api/session/update` with
 * `{session_id, model, model_provider}` — a genuinely session-scoped
 * write straight onto that one session's own `model`/`model_provider`
 * fields (`backend/upstream/api/routes.py` line 15809). A code comment
 * right above that call in `boot.js` says it outright: "Clarify scope:
 * composer model changes are session-local, not the global default." This
 * module now mirrors that exact real behavior instead of the earlier
 * (wrong) `/api/profile/switch` + `/api/model/set` two-call chain, which
 * changed the AGENT's default for every future session, not just the one
 * open in the composer.
 */
import { gatewayUrl } from '@/lib/env'
import type { ModelCatalog, SessionModel } from '@/features/models/types'

/** Wire shape of `GET /api/models` (`get_available_models()`,
 * `backend/upstream/api/config.py` ~line 6774, surfaced at
 * `backend/upstream/api/routes.py` ~line 13234):
 * `{active_provider: str|null, default_model: str, groups: [{provider,
 * models: [{id, label}]}]}`. Field names map 1:1 to `ModelCatalog` except
 * for the snake_case remap done in `fetchModelCatalog` below.
 *
 * API-KEY VALIDATION — verified, not assumed: `groups` here is NOT the
 * full static provider list; `_build_available_models_uncached()`
 * (config.py ~line 6972) only ever adds a provider's models to `groups`
 * after that provider lands in its own `detected_providers` set, which is
 * built strictly from the active provider, the credential pool, OAuth
 * auth status, and configured env/`.env` keys (config.py lines
 * 5481-5621, mirrored again for the live-groups path around line 6972).
 * A provider with no usable key never gets a group at all. That means
 * this catalog IS already the API-key-validated list — the same
 * source of truth `GET /api/providers`'s own `has_key` field would give,
 * with the filtering already applied server-side. This is exactly what
 * the real WebUI's own picker trusts too (`static/panels.js` line 9275,
 * `populateModelDropdown` builds straight from these `groups` with no
 * separate client-side key check); its only extra safety net is a
 * loose, NON-blocking provider-mismatch toast comparing a model's slash
 * prefix against `active_provider` (`_checkProviderMismatch`,
 * `static/ui.js` line 3852) — informational only, never blocks a pick. */
type WireModelCatalog = {
  active_provider: string | null
  default_model: string
  groups: { provider: string; models: { id: string; label: string }[] }[]
}

/** Wire shape of the success body `POST /api/session/update` returns
 * (`backend/upstream/api/routes.py` line 15859):
 * `{"session": {...public_session_projection(...)}}`. Only the two
 * fields this module actually needs back are typed — the full session
 * projection is large and this module has no use for the rest (messages,
 * timestamps, ...), matching `chat/api.ts`'s own partial-view pattern
 * (see that file's `WireSessionStatus` doc comment for why). */
type WireSessionUpdateResult = {
  session: { model: string | null; model_provider: string | null }
}

/** Wire shape of `GET /api/session/status` (`session_ops.py::session_status`,
 * surfaced at `backend/upstream/api/routes.py` line 14040) — only the
 * `model` field this module actually needs is typed; the rest (title,
 * token counts, ...) intentionally follows `chat/api.ts`'s own
 * `WireSessionStatus` partial-view pattern. Confirmed by reading
 * `session_status()` directly: it looks the session up by `sid` alone
 * (global `SESSIONS`/materialization path, no profile-cookie gate) — so
 * this read resolves correctly through `hermes_webui_proxy.rs`'s
 * cookie-agnostic passthrough regardless of which profile the browser's
 * sticky `hermes_profile` cookie names. */
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
 * network instead of trusting a client-side stale copy. See the
 * `WireModelCatalog` doc comment above for why this list is already
 * API-key-filtered. */
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
 * Switches the model for ONE SPECIFIC SESSION, matching the real Hermes
 * WebUI composer's own model dropdown exactly (see this file's top doc
 * comment for the `boot.js`/`routes.py` citations). Calls the real
 * `POST /api/session/update` with `{session_id, model, model_provider}`.
 *
 * `workspace` is deliberately omitted from the body: the handler
 * (`backend/upstream/api/routes.py` line 15824,
 * `body.get("workspace", s.workspace)`) defaults it to the session's own
 * current `workspace` when absent, so omitting it is a no-op for that
 * field rather than clearing it — this app has no reason to know or
 * touch Hermes' internal per-session filesystem workspace path, which is
 * an unrelated concept from this app's own `workspaceId` (one per
 * container/tenant).
 *
 * No `/api/profile/switch` dance needed here (unlike the earlier,
 * incorrect implementation): `/api/session/update` resolves the session
 * purely by `session_id` (`_get_or_materialize_session`, no profile-
 * cookie gate — confirmed by reading the handler, which has no
 * `_session_visible_to_active_profile` check unlike sibling endpoints
 * that explicitly need one, e.g. `_handle_session_anchor_scene` right
 * above it in routes.py). Safe to call directly through
 * `hermes_webui_proxy.rs`'s cookie-agnostic passthrough: this app never
 * lets one agent hold another agent's `session_id` in the first place
 * (see `chat-session-store.ts`'s per-workspace+per-agent isolation), so
 * there is no cross-agent write risk even without a profile check.
 */
export async function setActiveModel(
  workspaceId: string,
  sessionId: string,
  provider: string,
  model: string,
): Promise<SessionModel> {
  const data = await hermesFetch<WireSessionUpdateResult>(
    `${hermesWebuiBase(workspaceId)}/api/session/update`,
    {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, model, model_provider: provider }),
    },
  )
  return { model: data.session.model }
}

/**
 * Reads which model a SPECIFIC session is actually on right now, via the
 * real `GET /api/session/status` (`session_ops.py::session_status`,
 * `s.model`) — the session's own persisted field. Used to hydrate the
 * picker's trigger label on mount/session-change, independent of whatever
 * this tab's `setActiveModel` mutation state currently holds (e.g. after
 * a reload, or when another tab switched this session's model).
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
