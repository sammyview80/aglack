import { useReducer } from 'react'
import {
  readSelectedModels,
  toggleSelectedModel,
} from '@/features/models/selected-models-store'
import type { SelectedModel } from '@/features/models/types'

/**
 * Wraps `selected-models-store.ts` (localStorage) with a re-render trigger,
 * the same "bump a counter, re-read storage synchronously" idiom
 * `workspace-chat.tsx` already established for `chat-session-store.ts`
 * (`useReducer((n) => n + 1, 0)` + `bumpSessionStore()`) — reused verbatim
 * here rather than inventing a second state-sync mechanism (e.g. a
 * `useState` mirror that could drift from storage, or a `storage` event
 * listener that doesn't even fire for same-tab writes).
 *
 * `readSelectedModels` runs on every render (not just after a bump) so a
 * change made through a DIFFERENT hook instance in the same tree (e.g. the
 * dialog and the compact picker both mounted at once) is still picked up
 * next render without needing shared state lifted above both — storage
 * itself is the shared state.
 */
export function useSelectedModels(workspaceId: string, agent: string | null) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const selected = agent ? readSelectedModels(workspaceId, agent) : []

  function toggle(model: SelectedModel) {
    if (!agent) return
    toggleSelectedModel(workspaceId, agent, model)
    bump()
  }

  function isSelected(provider: string, id: string): boolean {
    return selected.some((m) => m.provider === provider && m.id === id)
  }

  return { selected, toggle, isSelected }
}
