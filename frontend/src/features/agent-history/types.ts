/** camelCase DTOs for rust_gateway's per-workspace agent-history proxy
 * (`GET /workspaces/:id/agent-history/*`). See `api.ts` for the
 * snake_case -> camelCase remap. */

export type AgentSummary = {
  name: string
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
