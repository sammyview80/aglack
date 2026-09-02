import type { SelectedModel } from '@/features/models/types'

/**
 * Holds a model pick made on an EMPTY composer (no chat session exists
 * yet) until that pick can actually be applied — mirrors the real Hermes
 * WebUI's own `window._emptyComposerModelOverride`
 * (`backend/upstream/static/sessions.js`, `_rememberEmptyComposerModelOverride`
 * / `_readEmptyComposerModelOverride` / `_clearEmptyComposerModelOverride`,
 * ~line 1296-1320) exactly: an in-memory, page-lifetime value, NOT
 * persisted to `localStorage`/`sessionStorage`.
 *
 * WHY IN-MEMORY, NOT PERSISTED (matching upstream's own choice): there is
 * no session yet to scope a persisted key to (the isolation key every
 * other store in this feature uses is `workspaceId + agent + sessionId`
 * or `workspaceId + agent` — session-less state has no such key to hang
 * a lasting value off), and the pick is single-use — it exists only to
 * ride along with the VERY NEXT `POST /api/session/new` call (see
 * `chat/api.ts`'s `createSession` and `chat/hooks/use-chat.ts`'s
 * `send()`), then gets consumed and cleared. A page reload before the
 * first message is sent losing an unconfirmed pick matches upstream's own
 * behavior exactly, not an oversight.
 *
 * Scoped per `workspaceId + agent` in the in-memory map (not a single
 * global slot) so switching agents/workspaces before sending a first
 * message can never leak agent A's still-pending pick into agent B's
 * empty composer — the same isolation rule every other store in this
 * feature enforces, just held in memory instead of storage.
 */
const pending = new Map<string, SelectedModel>()

function key(workspaceId: string, agent: string): string {
  return `${workspaceId}\u0000${agent}`
}

export function readPendingModel(workspaceId: string, agent: string): SelectedModel | null {
  return pending.get(key(workspaceId, agent)) ?? null
}

export function writePendingModel(workspaceId: string, agent: string, model: SelectedModel): void {
  pending.set(key(workspaceId, agent), model)
}

/** Called once the pick is actually consumed (a session was just created
 * carrying it) — mirrors `_clearEmptyComposerModelOverride()`, called
 * right after upstream's own `POST /api/session/new` resolves. */
export function clearPendingModel(workspaceId: string, agent: string): void {
  pending.delete(key(workspaceId, agent))
}
