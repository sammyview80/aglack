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
  chat: {
    all: ['chat'] as const,
    session: (workspaceId: string, agent: string) =>
      [...queryKeys.chat.all, workspaceId, 'agents', agent, 'session'] as const,
    sessionStatus: (workspaceId: string, agent: string, sessionId: string) =>
      [...queryKeys.chat.all, workspaceId, 'agents', agent, 'sessions', sessionId, 'status'] as const,
  },
  models: {
    all: ['models'] as const,
    // Not agent-scoped: the catalog itself is agent-agnostic (task item 1 —
    // "the FULL catalog"), only the ticked SHORTLIST is per-agent (that
    // lives in localStorage via selected-models-store.ts, not React Query).
    catalog: (workspaceId: string) => [...queryKeys.models.all, workspaceId, 'catalog'] as const,
    // Session-scoped (not agent-scoped): a session's own model can outlive
    // the agent's default changing again later, so this must be keyed by
    // the exact session id, not just the agent.
    sessionModel: (workspaceId: string, sessionId: string) =>
      [...queryKeys.models.all, workspaceId, 'sessions', sessionId, 'model'] as const,
  },
  commands: {
    all: ['commands'] as const,
    // Agent-scoped: the wrapper resolves the command/bundle list per Hermes
    // profile (`?agent=`), so two agents may legitimately see different lists.
    list: (workspaceId: string, agent: string) =>
      [...queryKeys.commands.all, workspaceId, 'agents', agent, 'list'] as const,
    bundles: (workspaceId: string, agent: string) =>
      [...queryKeys.commands.all, workspaceId, 'agents', agent, 'bundles'] as const,
  },
  integrations: {
    all: ['integrations'] as const,
    // Not workspace-scoped: the provider catalog is the same for every
    // workspace (see rust_gateway's GET /integrations/providers).
    providers: () => [...queryKeys.integrations.all, 'providers'] as const,
    // Not workspace-scoped either, but content differs per search text, so
    // the params ARE the identity (two searches must never share a cache
    // entry). Pagination progression lives in the infinite query's own
    // page cache under this one key, not in the key itself.
    catalog: (params: { search: string; limit: number; offset: number }) =>
      [...queryKeys.integrations.all, 'catalog', params] as const,
    connections: (workspaceId: string) =>
      [...queryKeys.integrations.all, workspaceId, 'connections'] as const,
    agentEnablement: (workspaceId: string) =>
      [...queryKeys.integrations.all, workspaceId, 'agent-enablement'] as const,
  },
} as const
