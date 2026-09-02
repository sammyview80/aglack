/** camelCase DTOs for the model catalog and model-switch surface, reached
 * through rust_gateway's whole-app passthrough proxy (`/workspaces/:id/
 * hermes-webui/*` -> the workspace's wrapper root -> upstream Hermes'
 * OWN `/api/models` and `/api/model/set`). See `api.ts` for the
 * snake_case -> camelCase remap and the raw (non-envelope) fetch wrapper
 * this module shares with `chat/api.ts`'s `chatFetch`.
 */

/** One selectable model inside a provider group, as returned by
 * `GET /api/models` (`get_available_models()`, `backend/upstream/api/
 * config.py` ~line 6774): `{'id': str, 'label': str}`. `id` is the exact
 * string `POST /api/model/set` expects back in its `model` field —
 * never re-derive or reformat it. */
export type CatalogModel = {
  id: string
  label: string
}

/** One provider's model group, as returned by `GET /api/models`'s
 * `groups: [{provider: str, models: [...]}]` (config.py ~line 6774).
 * `provider` here is upstream's "category" — the same string
 * `POST /api/model/set` expects back in its `provider` field. */
export type CatalogGroup = {
  provider: string
  models: CatalogModel[]
}

/** Full response body of `GET /api/models` (config.py `get_available_models`,
 * routes.py ~line 13234). `activeProvider`/`defaultModel` describe whichever
 * profile answered the request (see `hermes_profile` cookie discussion in
 * `api.ts`) — this feature never renders them as ground truth for a
 * specific agent, only uses `groups` to populate the catalog dialog. */
export type ModelCatalog = {
  activeProvider: string | null
  defaultModel: string
  groups: CatalogGroup[]
}

/** The minimal, denormalized record this feature persists per ticked
 * model (see `selected-models-store.ts`). Deliberately NOT the full
 * `CatalogModel` shape re-exported — storing `provider` alongside `id`/
 * `label` is what lets the compact picker render a grouped list straight
 * from localStorage without re-fetching the catalog (task requirement:
 * "small, do not store the whole catalog"). */
export type SelectedModel = {
  id: string
  label: string
  provider: string
}

/** What model a SPECIFIC session (not just the agent's default) is
 * currently bound to — sourced from `GET /api/session/status`'s own
 * `model` field (`session_ops.py::session_status`, `s.model`). This is
 * the session's own persisted field, refreshed on every
 * `/api/chat/start` from whatever the profile default resolves to at
 * that moment (`_prepare_chat_start_session_for_stream`, routes.py line
 * 22557) — so switching the agent's default model DOES change what an
 * existing, already-open session uses on its next turn; this is not
 * limited to brand-new sessions. `model` is `null` for a session that
 * has never sent a turn yet (the field starts unset). */
export type SessionModel = {
  model: string | null
}
