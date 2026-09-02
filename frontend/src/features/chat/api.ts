/**
 * Client for rust_gateway's per-workspace chat proxy
 * (`ANY /workspaces/:id/chat/*path` -> Hermes' native `/api/chat/*`,
 * `/api/session/*`, `/api/approval/*`, `/api/clarify/*`). See
 * `rust_gateway/src/workspaces/chat_proxy.rs`.
 *
 * NOTE: unlike workspace/onboarding/agent-seeder/agent-history, this proxy
 * forwards Hermes' *own* JSON bodies whole (`{"error":"..."}` on failure,
 * plain objects on success) — it is not rust_gateway's `{ok,data}` envelope,
 * so calls here do NOT go through `apiFetch` (see that file's own doc
 * comment: proxy::forward-relayed responses are not that envelope). This
 * module has its own thin fetch wrapper instead.
 *
 * Every call takes `workspaceId` first, `agent` second. `agent` is always
 * sent as `?agent=<name>` — the gateway translates that into the
 * `hermes_profile` cookie the container requires for per-agent isolation.
 */
import { gatewayUrl } from '@/lib/env'
import type { ApprovalChoice, CancelTurnResult, ChatSession, StartTurnResult } from '@/features/chat/types'

/** Hermes nests the session under a `session` key
 * (`{"session":{"session_id":...}}`); a top-level `session_id` is kept as a
 * defensive fallback in case that shape ever changes. */
type WireSession = { session?: { session_id: string; profile?: string }; session_id?: string; profile?: string }
type WireStartTurnResult = {
  stream_id: string
  session_id: string
  pending_started_at: number
  turn_id: string | null
  title: string
  effective_model?: string
  effective_model_provider?: string
}
type WireCancelTurnResult = { ok: boolean; cancelled: boolean; stream_id: string }

function chatBase(workspaceId: string): string {
  return `${gatewayUrl()}/workspaces/${encodeURIComponent(workspaceId)}/chat`
}

function withAgent(path: string, agent: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}agent=${encodeURIComponent(agent)}`
}

/** Fetch helper for this proxy's raw (non-envelope) Hermes JSON bodies. */
async function chatFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new Error('Cannot reach the gateway. Is rust_gateway running?')
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }

  const errorText =
    body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : undefined

  if (!res.ok || errorText) {
    throw new Error(errorText ?? `Chat request failed (HTTP ${res.status})`)
  }

  return body as T
}

/** Create a session bound to one agent (Hermes profile). Each agent gets
 * its own session — never share one session across agents. */
export async function createSession(workspaceId: string, agent: string): Promise<ChatSession> {
  const data = await chatFetch<WireSession>(
    withAgent(`${chatBase(workspaceId)}/api/session/new`, agent),
    { method: 'POST', body: JSON.stringify({ profile: agent }) },
  )
  const session = data.session ?? data
  return { sessionId: session.session_id as string, profile: session.profile }
}

export async function startTurn(
  workspaceId: string,
  agent: string,
  sessionId: string,
  message: string,
): Promise<StartTurnResult> {
  const data = await chatFetch<WireStartTurnResult>(
    withAgent(`${chatBase(workspaceId)}/api/chat/start`, agent),
    { method: 'POST', body: JSON.stringify({ session_id: sessionId, message, profile: agent }) },
  )
  return {
    streamId: data.stream_id,
    sessionId: data.session_id,
    pendingStartedAt: data.pending_started_at,
    turnId: data.turn_id,
    title: data.title,
    effectiveModel: data.effective_model,
    effectiveModelProvider: data.effective_model_provider,
  }
}

/** Stream URL for `EventSource` — kept here so the SSE hook never builds
 * gateway paths itself. */
export function chatStreamUrl(workspaceId: string, agent: string, streamId: string): string {
  return withAgent(
    `${chatBase(workspaceId)}/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`,
    agent,
  )
}

/** Terminates the turn. Keyed by `streamId`, not `sessionId`. */
export async function cancelTurn(
  workspaceId: string,
  agent: string,
  streamId: string,
): Promise<CancelTurnResult> {
  const data = await chatFetch<WireCancelTurnResult>(
    withAgent(`${chatBase(workspaceId)}/api/chat/cancel?stream_id=${encodeURIComponent(streamId)}`, agent),
    { method: 'POST' },
  )
  return { ok: data.ok, cancelled: data.cancelled, streamId: data.stream_id }
}

/** Decision vocabulary is NOT approve/deny — exactly `once`/`session`/`always`/`deny`. */
export async function respondToApproval(
  workspaceId: string,
  agent: string,
  sessionId: string,
  choice: ApprovalChoice,
  approvalId?: string,
): Promise<void> {
  await chatFetch<unknown>(withAgent(`${chatBase(workspaceId)}/api/approval/respond`, agent), {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, choice, approval_id: approvalId }),
  })
}

export async function respondToClarify(
  workspaceId: string,
  agent: string,
  sessionId: string,
  response: string,
  clarifyId?: string,
): Promise<void> {
  await chatFetch<unknown>(withAgent(`${chatBase(workspaceId)}/api/clarify/respond`, agent), {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, response, clarify_id: clarifyId }),
  })
}
