import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import type { AgentSession, ListAgentSessionsResult, ListAgentsResult } from '@/features/agent-history/types'

/** Sidebar busy-dot without a network round trip. Returns the same cache
 * reference when `isWorking` is already correct so observers do not re-render.
 * No-ops when the agents list is not in cache yet — never invents a list
 * that would skip the real first fetch. */
export function setAgentWorking(
  queryClient: QueryClient,
  workspaceId: string,
  agentName: string,
  isWorking: boolean,
) {
  queryClient.setQueryData<ListAgentsResult>(queryKeys.agentHistory.agents(workspaceId), (prev) => {
    if (!prev) return prev
    let changed = false
    const agents = prev.agents.map((row) => {
      if (row.name !== agentName || row.isWorking === isWorking) return row
      changed = true
      return { ...row, isWorking }
    })
    return changed ? { agents } : prev
  })
}

/** Audience session row without refetching `/sessions`. Skips when that
 * query has never loaded — writing a synthetic list would hide the real
 * first fetch. A missing session id (brand-new chat) is inserted at the
 * top so the panel shows it immediately. Same-row no-ops (already first,
 * same title/count) keep the previous reference so the panel does not
 * re-render for a timestamp-only bump. */
export function touchCachedSession(
  queryClient: QueryClient,
  workspaceId: string,
  agentName: string,
  sessionId: string,
  patch: { title?: string; messageCountDelta: number; at: number },
) {
  queryClient.setQueryData<ListAgentSessionsResult>(
    queryKeys.agentHistory.sessions(workspaceId, agentName),
    (prev) => {
      if (!prev) return prev
      const idx = prev.sessions.findIndex((row) => row.sessionId === sessionId)
      const title = patch.title?.trim()
      if (idx >= 0) {
        const current = prev.sessions[idx]
        const nextTitle = title || current.title
        const nextCount = current.messageCount + patch.messageCountDelta
        if (idx === 0 && nextTitle === current.title && nextCount === current.messageCount) {
          return prev
        }
        const nextRow: AgentSession = {
          ...current,
          title: nextTitle,
          messageCount: nextCount,
          updatedAt: patch.at,
          lastMessageAt: patch.at,
        }
        const rest = prev.sessions.filter((_, i) => i !== idx)
        return { ...prev, sessions: [nextRow, ...rest] }
      }
      return {
        ...prev,
        sessions: [
          {
            sessionId,
            title: title || '',
            messageCount: Math.max(0, patch.messageCountDelta),
            updatedAt: patch.at,
            lastMessageAt: patch.at,
          },
          ...prev.sessions,
        ],
      }
    },
  )
}
