import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listAgentMessages, listAgentSessions, listAgents } from '@/features/agent-history/api'
import { queryKeys } from '@/lib/query-keys'
import type { ListAgentsResult } from '@/features/agent-history/types'

export function useAgents<TData = ListAgentsResult>(
  workspaceId: string | undefined,
  panelOpen: boolean,
  select?: (data: ListAgentsResult) => TData,
) {
  return useQuery({
    queryKey: queryKeys.agentHistory.agents(workspaceId ?? ''),
    queryFn: () => listAgents(workspaceId as string),
    enabled: Boolean(workspaceId) && panelOpen,
    select,
  })
}

export function useAgentSessions(
  workspaceId: string | undefined,
  agentName: string | null,
  panelOpen: boolean,
) {
  return useQuery({
    queryKey: queryKeys.agentHistory.sessions(workspaceId ?? '', agentName ?? ''),
    queryFn: () => listAgentSessions(workspaceId as string, agentName as string),
    enabled: Boolean(workspaceId && agentName) && panelOpen,
  })
}

/** Prefetch helpers for hover/focus intent — never fan out beyond one item. */
export function useAgentHistoryPrefetch(workspaceId: string | undefined) {
  const queryClient = useQueryClient()

  function prefetchSessions(agentName: string) {
    if (!workspaceId) return
    void queryClient.prefetchQuery({
      queryKey: queryKeys.agentHistory.sessions(workspaceId, agentName),
      queryFn: () => listAgentSessions(workspaceId, agentName),
    })
  }

  function prefetchMessages(agentName: string, sessionId: string) {
    if (!workspaceId) return
    void queryClient.prefetchQuery({
      queryKey: queryKeys.agentHistory.messages(workspaceId, agentName, sessionId),
      queryFn: () => listAgentMessages(workspaceId, agentName, sessionId),
    })
  }

  return { prefetchSessions, prefetchMessages }
}
