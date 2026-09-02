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

/** Same normalized shape `startTurn`'s own `ChatAttachment` sends over the
 * wire (`features/chat/types.ts`) — this is that record read BACK from
 * upstream's persisted history via the wrapper's `agent_history` projection
 * (`backend/wrapper/.../agent_history/service.py::_project_attachments`),
 * which carries it through verbatim from upstream's own
 * `user_msg["attachments"]` (`backend/upstream/api/routes.py:22499`).
 * `size`/`isImage` are optional because upstream's own normalizer
 * (`_normalize_chat_attachments`, `api/routes.py:24368`) only includes them
 * when the original upload actually had them. */
export type AgentMessageAttachment = {
  name: string
  path: string
  mime: string
  size?: number
  isImage?: boolean
}

export type AgentMessage = {
  role: string
  content: string
  timestamp: number
  /** Absent (not `[]`) means this message never had attachments at all —
   * see `_project_attachments`'s own doc comment for why that distinction
   * is preserved through the projection rather than collapsed to `[]`. */
  attachments?: AgentMessageAttachment[]
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
