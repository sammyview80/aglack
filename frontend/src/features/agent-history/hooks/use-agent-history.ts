import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listAgentMessages, listAgentSessions, listAgents } from '@/features/agent-history/api'
import { queryKeys } from '@/lib/query-keys'

export function useAgents(workspaceId: string | undefined, panelOpen: boolean) {
  return useQuery({
    queryKey: queryKeys.agentHistory.agents(workspaceId ?? ''),
    queryFn: () => listAgents(workspaceId as string),
    enabled: Boolean(workspaceId) && panelOpen,
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

export function useAgentMessages(
  workspaceId: string | undefined,
  agentName: string | null,
  sessionId: string | null,
  panelOpen: boolean,
) {
  return useQuery({
    queryKey: queryKeys.agentHistory.messages(workspaceId ?? '', agentName ?? '', sessionId ?? ''),
    queryFn: () => listAgentMessages(workspaceId as string, agentName as string, sessionId as string),
    enabled: Boolean(workspaceId && agentName && sessionId) && panelOpen,
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
