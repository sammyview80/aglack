import { useReducer } from 'react'
import {
  clearPendingModel,
  readPendingModel,
  writePendingModel,
} from '@/features/models/pending-model-store'
import type { SelectedModel } from '@/features/models/types'

/**
 * Wraps `pending-model-store.ts` (in-memory) with a re-render trigger —
 * same bump-to-re-read idiom `use-selected-models.ts` already uses for
 * the localStorage-backed shortlist. See that hook's doc comment for why
 * this pattern (not a `useState` mirror, not a `storage` listener) is
 * this codebase's established idiom for "storage is the source of
 * truth, re-render on writes".
 */
export function usePendingModel(workspaceId: string, agent: string | null) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const pendingModel = agent ? readPendingModel(workspaceId, agent) : null

  function setPending(model: SelectedModel) {
    if (!agent) return
    writePendingModel(workspaceId, agent, model)
    bump()
  }

  function clearPending() {
    if (!agent) return
    clearPendingModel(workspaceId, agent)
    bump()
  }

  return { pendingModel, setPending, clearPending }
}
