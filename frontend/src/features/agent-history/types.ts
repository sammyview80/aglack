/** camelCase DTOs for rust_gateway's per-workspace agent-history proxy
 * (`GET /workspaces/:id/agent-history/*`). See `api.ts` for the
 * snake_case -> camelCase remap. */

export type AgentSummary = {
  name: string
  /** True while this agent has at least one actively-streaming session
   * (any session, not only the one this tab may have open) — backed by
   * upstream's own `is_streaming` (`all_sessions()` in Hermes' `api/models.py`),
   * aggregated per-profile by the wrapper's `agent_history` service. Drives
   * the sidebar busy dot (see `threads-shell.tsx`), distinct from the
   * per-open-chat `chat.isStreaming` from `useChat`. */
  isWorking: boolean
}

export type AgentSession = {
  sessionId: string
  title: string
  messageCount: number
  updatedAt: number
  lastMessageAt: number
}

export type AgentMessage = {
  role: string
  content: string
  timestamp: number
}

export type ListAgentsResult = {
  agents: AgentSummary[]
}

export type ListAgentSessionsResult = {
  sessions: AgentSession[]
  limit: number
  offset: number
}

export type ListAgentMessagesResult = {
  messages: AgentMessage[]
  limit: number
  offset: number
  total: number
}
