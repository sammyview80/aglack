/**
 * Hierarchical query-key factory for every server resource this app reads
 * through TanStack Query. Hierarchical so `invalidateQueries({ queryKey:
 * queryKeys.workspaces.all })` invalidates every workspace query, while a
 * leaf key still includes every id it depends on (workspaceId/agent/
 * session) — a key missing part of its identity is a cross-tenant leak.
 */
export const queryKeys = {
  workspaces: {
    all: ['workspaces'] as const,
    list: () => [...queryKeys.workspaces.all, 'list'] as const,
  },
  agentHistory: {
    all: ['agent-history'] as const,
    agents: (workspaceId: string) =>
      [...queryKeys.agentHistory.all, workspaceId, 'agents'] as const,
    sessions: (workspaceId: string, agentName: string) =>
      [...queryKeys.agentHistory.all, workspaceId, 'agents', agentName, 'sessions'] as const,
    messages: (workspaceId: string, agentName: string, sessionId: string) =>
      [
        ...queryKeys.agentHistory.all,
        workspaceId,
        'agents',
        agentName,
        'sessions',
        sessionId,
        'messages',
      ] as const,
  },
  onboarding: {
    all: ['onboarding'] as const,
    status: (workspaceId: string) => [...queryKeys.onboarding.all, workspaceId, 'status'] as const,
  },
} as const
