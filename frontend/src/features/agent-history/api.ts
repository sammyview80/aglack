/**
 * Client for rust_gateway's per-workspace agent-history proxy
 * (`GET /workspaces/:id/agent-history/*`). The gateway checks the
 * workspace id (exists + status === ready) then forwards to that
 * workspace's wrapper. Envelope parsing is apiFetch — same helper as
 * onboarding/workspace/agent-seeder.
 *
 * Base URL comes from VITE_GATEWAY_URL via lib/env.ts. Do not call the
 * wrapper's own base URL from this feature.
 */
import { apiFetch } from '@/lib/api'
import { gatewayUrl } from '@/lib/env'
import type {
  AgentMessage,
  AgentSession,
  ListAgentMessagesResult,
  ListAgentSessionsResult,
  ListAgentsResult,
} from '@/features/agent-history/types'

type WireAgent = { name: string }

type WireListAgentsResult = { agents: WireAgent[] }

type WireAgentSession = {
  session_id: string
  title: string
  message_count: number
  updated_at: number
  last_message_at: number
}

type WireListAgentSessionsResult = {
  sessions: WireAgentSession[]
  limit: number
  offset: number
}

type WireAgentMessage = {
  role: string
  content: string
  timestamp: number
}

type WireListAgentMessagesResult = {
  messages: WireAgentMessage[]
  limit: number
  offset: number
  total: number
}

export type PageQuery = {
  limit?: number
  offset?: number
}

function agentHistoryPath(workspaceId: string, path: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/agent-history/${path}`
}

function queryString(query?: PageQuery): string {
  if (!query) return ''
  const params = new URLSearchParams()
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

function mapSession(row: WireAgentSession): AgentSession {
  return {
    sessionId: row.session_id,
    title: row.title,
    messageCount: row.message_count,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
  }
}

function mapMessage(row: WireAgentMessage): AgentMessage {
  return {
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
  }
}

/** Real seeded Hermes agents/profiles for this workspace. */
export async function listAgents(workspaceId: string): Promise<ListAgentsResult> {
  const data = await apiFetch<WireListAgentsResult>(
    gatewayUrl(),
    agentHistoryPath(workspaceId, 'agents'),
  )
  return { agents: data.agents.map((row) => ({ name: row.name })) }
}

export async function listAgentSessions(
  workspaceId: string,
  agentName: string,
  query?: PageQuery,
): Promise<ListAgentSessionsResult> {
  const data = await apiFetch<WireListAgentSessionsResult>(
    gatewayUrl(),
    agentHistoryPath(workspaceId, `agents/${encodeURIComponent(agentName)}/sessions${queryString(query)}`),
  )
  return { sessions: data.sessions.map(mapSession), limit: data.limit, offset: data.offset }
}

export async function listAgentMessages(
  workspaceId: string,
  agentName: string,
  sessionId: string,
  query?: PageQuery,
): Promise<ListAgentMessagesResult> {
  const data = await apiFetch<WireListAgentMessagesResult>(
    gatewayUrl(),
    agentHistoryPath(
      workspaceId,
      `agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(sessionId)}/messages${queryString(query)}`,
    ),
  )
  return {
    messages: data.messages.map(mapMessage),
    limit: data.limit,
    offset: data.offset,
    total: data.total,
  }
}
