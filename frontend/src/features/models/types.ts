/** camelCase DTOs for the model catalog and model-switch surface, reached
 * through rust_gateway's whole-app passthrough proxy (`/workspaces/:id/
 * hermes-webui/*` -> the workspace's wrapper root -> upstream Hermes'
 * OWN `/api/models` and `/api/session/update`). See `api.ts` for the
 * snake_case -> camelCase remap, the raw (non-envelope) fetch wrapper
 * this module shares with `chat/api.ts`'s `chatFetch`, and the citation
 * trail confirming session-scoped switching against the real Hermes
 * WebUI frontend source.
 */

/** One selectable model inside a provider group, as returned by
 * `GET /api/models` (`get_available_models()`, `backend/upstream/api/
 * config.py` ~line 6774): `{'id': str, 'label': str}`. `id` is the exact
 * string `POST /api/session/update` expects back in its `model` field —
 * never re-derive or reformat it. */
export type CatalogModel = {
  id: string
  label: string
}

/** One provider's model group, as returned by `GET /api/models`'s
 * `groups: [{provider: str, models: [...]}]` (config.py ~line 6774).
 * `provider` here is upstream's "category" — the same string
 * `POST /api/session/update` expects back in its `model_provider` field.
 * See `api.ts`'s `WireModelCatalog` doc comment: this list is already
 * filtered to providers with a usable API key, so every model surfaced
 * here is already validated, not merely a static catalog entry. */
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

/** What model a SPECIFIC session (not the agent-wide default) is
 * currently bound to — sourced from either `GET /api/session/status`'s
 * own `model` field (`session_ops.py::session_status`, `s.model`) or the
 * `session.model` echoed back by `POST /api/session/update`'s own
 * response (routes.py line 15859) after a switch. This IS the session's
 * own persisted field, written directly by `setActiveModel` — the real
 * Hermes WebUI composer's own model dropdown writes this exact field the
 * exact same way (see `api.ts`'s `setActiveModel` doc comment for the
 * `boot.js`/`routes.py` citations). `model` is `null` for a session that
 * has never sent a turn yet AND never had an explicit pick (the field
 * starts unset — `Session.__init__`, `backend/upstream/api/models.py`
 * line 1264). */
export type SessionModel = {
  model: string | null
}
