import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  cancelTurn,
  createSession,
  getSessionStatus,
  respondToApproval,
  respondToClarify,
  startTurn,
} from '@/features/chat/api'
import { listAgentMessages } from '@/features/agent-history/api'
import { useChatStream } from '@/features/chat/hooks/use-chat-stream'
import { queryKeys } from '@/lib/query-keys'
import { errorMessage } from '@/lib/api'
import { handleError } from '@/lib/handle-error'
import type { ApprovalChoice, ToolActivity } from '@/features/chat/types'
import type { AgentMessage } from '@/features/agent-history/types'

export type ChatTurn = {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  errored?: boolean
  /** Assistant-only. Snapshotted from the live stream once the turn settles
   * (done/cancelled/error) — never discarded like a streaming-only display
   * would, so a completed turn's reasoning/tool trace stays available for
   * an on-demand expand (matches upstream Hermes' persisted `m.reasoning`
   * + collapsed "Thinking" card, see backend/upstream/static/ui.js).
   * Undefined (not empty string) means "no reasoning for this turn" — a
   * turn can genuinely have none. */
  reasoning?: string
  /** Same snapshot rule as `reasoning` — empty array means "no tool
   * calls", not "not loaded yet" (history-seeded turns below also
   * default to it being absent, since history has no reasoning/tool data
   * at all — see isDisplayableHistoryMessage's own doc comment). */
  tools?: ToolActivity[]
}

/** A `role: "tool"` history row carries a raw tool-execution result as its
 * `content` — often a JSON-shaped string like
 * `{"output": "...", "exit_code": 0, "error": null}` (real example seen
 * live) — not conversation prose. Hermes' native session storage tags
 * these distinctly from `user`/`assistant` (confirmed against upstream's
 * own `role === 'tool'` handling in `static/messages.js`). Filtered here,
 * client-side, deliberately — the frontend must render a sane transcript
 * on reload regardless of which backend/version actually served the
 * history, not assume a server-side filter is present. A `role:
 * "assistant"` row with empty content is a placeholder Hermes writes
 * while a tool call is in flight (real example seen live, immediately
 * preceding a `tool` row) — it is superseded by that turn's eventual
 * real answer, so an empty one is never worth its own blank bubble. */
function isDisplayableHistoryMessage(message: AgentMessage): boolean {
  if (message.role === 'tool') return false
  if (message.role !== 'user' && !message.content.trim()) return false
  return true
}

function historyToTurns(sessionKey: string, messages: AgentMessage[]): ChatTurn[] {
  return messages
    .filter(isDisplayableHistoryMessage)
    .map((message, index) => ({
      id: `history-${sessionKey}-${index}`,
      role: message.role === 'user' ? 'user' : 'assistant',
      text: message.content,
      at: message.timestamp,
    }))
}

const SESSION_STORAGE_PREFIX = 'hermano.chat.session'

function sessionStorageKey(workspaceId: string, agent: string): string {
  return `${SESSION_STORAGE_PREFIX}.${workspaceId}.${agent}`
}

/** Reads a previously-persisted session id for this exact workspace+agent
 * pair, if any. `localStorage` access is wrapped defensively — private
 * browsing / storage-disabled contexts throw on read/write in some
 * browsers, and this feature degrading to "no persistence" is strictly
 * better than a crash. */
function readPersistedSessionId(workspaceId: string, agent: string): string | null {
  try {
    return window.localStorage.getItem(sessionStorageKey(workspaceId, agent))
  } catch {
    return null
  }
}

function writePersistedSessionId(workspaceId: string, agent: string, sessionId: string): void {
  try {
    window.localStorage.setItem(sessionStorageKey(workspaceId, agent), sessionId)
  } catch {
    /* storage unavailable — persistence is best-effort, never fatal */
  }
}

function clearPersistedSessionId(workspaceId: string, agent: string): void {
  try {
    window.localStorage.removeItem(sessionStorageKey(workspaceId, agent))
  } catch {
    /* storage unavailable — persistence is best-effort, never fatal */
  }
}

/**
 * Ties session creation, turn start, and the SSE stream together for one
 * agent. Switching `agent` switches which session the chat is bound to —
 * each agent has its own React-Query-cached session, keyed by
 * `workspaceId` + `agent` so one agent's session can never leak into
 * another's (see AGENTS.md's chat-key rule).
 *
 * `options.sessionId`: bind explicitly to an already-existing session
 * (e.g. opened from agent history) instead of creating/reusing this
 * agent's default session.
 *
 * Session id + in-flight turn both survive a hard page reload:
 * - The resolved session id is persisted to `localStorage` per
 *   workspace+agent (`readPersistedSessionId`/`writePersistedSessionId`)
 *   so a reload binds back to the SAME session instead of `createSession`
 *   minting a brand new one and silently orphaning the old one — upstream's
 *   `/api/session/new` always creates a new session, it never returns an
 *   existing one, so nothing but explicit persistence recovers this.
 * - Whichever session id is bound to (explicit OR persisted OR freshly
 *   created), its history is seeded via agent-history so a reload never
 *   shows an empty transcript for a session that already has messages.
 * - Once bound to a known session id, a one-shot `GET /api/session/status`
 *   check (`getSessionStatus`) detects a turn already running server-side
 *   and reconnects this tab's SSE stream to it, instead of the reload
 *   silently losing track of a still-in-flight turn until its result
 *   shows up in history on the NEXT reload.
 */
export function useChat(
  workspaceId: string | undefined,
  agent: string | null,
  options?: { sessionId?: string | null },
) {
  const explicitSessionId = options?.sessionId ?? null
  const queryClient = useQueryClient()
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [streamId, setStreamId] = useState<string | null>(null)
  // Tracks whether a send is in flight FOR THE CURRENTLY BOUND agent/session
  // — not just whether the startTurn mutation object is pending. Reset
  // immediately on agent switch so the new agent's composer is never stuck
  // showing the old agent's in-flight state.
  const [isSending, setIsSending] = useState(false)
  const processedStreamId = useRef<string | null>(null)
  const sendSeqRef = useRef(0)
  const streamIdRef = useRef<string | null>(null)
  // Latest agent/workspace snapshot, read by async continuations to detect
  // a switch that happened while they were in flight — same guard shape as
  // the agent-history request-id fix.
  const activeRef = useRef({ workspaceId, agent })
  activeRef.current = { workspaceId, agent }

  const persistedSessionId =
    !explicitSessionId && workspaceId && agent ? readPersistedSessionId(workspaceId, agent) : null
  // The session id actually bound to right now, whichever source it came
  // from — used for history seeding and the status/reconnect check below,
  // both of which apply identically regardless of provenance.
  const boundSessionId = explicitSessionId ?? persistedSessionId

  const sessionQuery = useQuery({
    queryKey: queryKeys.chat.session(workspaceId ?? '', agent ?? ''),
    queryFn: () => createSession(workspaceId as string, agent as string),
    // A persisted session id from a prior visit is bound to directly
    // (below), same as an explicit one — never mint a new session when a
    // perfectly good one is already known for this exact workspace+agent.
    enabled: Boolean(workspaceId && agent) && !boundSessionId,
    staleTime: Infinity,
    retry: false,
  })
  const sessionId = boundSessionId ?? sessionQuery.data?.sessionId ?? null

  // Persist a freshly-created session id the moment it's known, so the
  // VERY NEXT reload binds back to it instead of creating another one.
  useEffect(() => {
    if (workspaceId && agent && sessionQuery.data?.sessionId) {
      writePersistedSessionId(workspaceId, agent, sessionQuery.data.sessionId)
    }
  }, [workspaceId, agent, sessionQuery.data?.sessionId])

  // Seed turn history from the bound session's past messages once loaded
  // — a one-shot fetch, never polled, per this feature's no-polling rule.
  // Runs for ANY known session id (explicit, persisted, or otherwise),
  // not only an explicit one: a persisted session across a reload needs
  // its transcript loaded exactly the same way an explicitly-opened one
  // does — the previous session-id-only-explicit rule left a persisted
  // reload showing an empty chat despite real history existing.
  const historyQuery = useQuery({
    queryKey: queryKeys.agentHistory.messages(workspaceId ?? '', agent ?? '', boundSessionId ?? ''),
    queryFn: () => listAgentMessages(workspaceId as string, agent as string, boundSessionId as string),
    enabled: Boolean(workspaceId && agent && boundSessionId),
  })
  const seededRef = useRef<string | null>(null)

  // Backs the reconnect effect further below — see its own comment for why
  // this exists. One-shot (no polling), fired once `sessionId` resolves.
  const sessionStatusQuery = useQuery({
    queryKey: queryKeys.chat.sessionStatus(workspaceId ?? '', agent ?? '', sessionId ?? ''),
    queryFn: () => getSessionStatus(workspaceId as string, agent as string, sessionId as string),
    enabled: Boolean(workspaceId && agent && sessionId),
    staleTime: Infinity,
    retry: false,
  })
  const reconnectedRef = useRef<string | null>(null)

  useEffect(() => {
    streamIdRef.current = streamId
  }, [streamId])

  useEffect(() => {
    setTurns([])
    setStreamId(null)
    setIsSending(false)
    processedStreamId.current = null
    seededRef.current = null
    reconnectedRef.current = null
    // Switching agents mid-turn does not stop the backend turn on its own —
    // closing the browser EventSource only drops OUR connection. Explicitly
    // cancel the outgoing agent's turn so returning to it later doesn't hit
    // Hermes' active-stream 409. (Chosen over "leave it running": simpler
    // and avoids surfacing that 409 at all.)
    return () => {
      const abandoned = streamIdRef.current
      if (abandoned) void cancelTurn(workspaceId as string, agent as string, abandoned).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agent, explicitSessionId])

  // Seed turn history from the bound session's past messages once loaded,
  // before any new turn is sent on top of it.
  useEffect(() => {
    if (!boundSessionId || !historyQuery.data) return
    if (seededRef.current === boundSessionId) return
    seededRef.current = boundSessionId
    setTurns(historyToTurns(boundSessionId, historyQuery.data.messages))
  }, [boundSessionId, historyQuery.data])

  // Detect a turn already running server-side for this exact session — a
  // one-shot check (no polling, matches this hook's own no-polling
  // convention elsewhere), fired once `sessionId` resolves. Reload/remount
  // is the only reason this ever finds something: normal in-tab sending
  // already has `streamId` set locally and never needs this. Runs AFTER
  // the agent/session reset effect above (declaration order = commit
  // order for same-render effects) so switching agents can never leave a
  // stale `setStreamId` racing the reset's own `setStreamId(null)`.
  useEffect(() => {
    if (!sessionId || !sessionStatusQuery.data) return
    if (reconnectedRef.current === sessionId) return
    reconnectedRef.current = sessionId
    // Never override a stream this tab already knows about (a real local
    // send in flight) — this effect exists only to RECOVER a turn this
    // tab has no local memory of.
    if (streamIdRef.current) return
    if (sessionStatusQuery.data.activeStreamId) {
      setStreamId(sessionStatusQuery.data.activeStreamId)
    }
  }, [sessionId, sessionStatusQuery.data])

  const stream = useChatStream({ workspaceId, agent, sessionId, streamId })

  const startMutation = useMutation({
    mutationFn: ({ sessionId: sid, message }: { sessionId: string; message: string }) =>
      startTurn(workspaceId as string, agent as string, sid, message),
    onError: (err) => handleError(err, { fallback: 'Could not send that message' }),
  })

  const cancelMutation = useMutation({
    mutationFn: () => cancelTurn(workspaceId as string, agent as string, streamId as string),
    onError: (err) => handleError(err, { fallback: 'Could not stop the turn' }),
  })

  const approvalMutation = useMutation({
    mutationFn: ({ choice, approvalId }: { choice: ApprovalChoice; approvalId?: string }) =>
      respondToApproval(workspaceId as string, agent as string, sessionId as string, choice, approvalId),
    onSuccess: () => stream.clearApproval(),
    onError: (err) => handleError(err, { fallback: 'Could not respond to the approval request' }),
  })

  const clarifyMutation = useMutation({
    mutationFn: ({ response, clarifyId }: { response: string; clarifyId?: string }) =>
      respondToClarify(workspaceId as string, agent as string, sessionId as string, response, clarifyId),
    onSuccess: () => stream.clearClarify(),
    onError: (err) => handleError(err, { fallback: 'Could not send that answer' }),
  })

  const reloadMutation = useMutation({
    mutationFn: () => {
      if (!workspaceId || !agent || !sessionId) {
        return Promise.reject(new Error('No active session to reload'))
      }
      return listAgentMessages(workspaceId, agent, sessionId)
    },
    onSuccess: (data) => {
      if (!sessionId) return
      seededRef.current = sessionId
      setTurns(historyToTurns(sessionId, data.messages))
    },
    onError: (err) => handleError(err, { fallback: 'Could not reload messages' }),
  })

  // Snapshot the assembled assistant reply into turn history once content
  // is final (`done`/`cancelled`/`error`). This does NOT close the
  // connection or release `streamId` — only a genuine connection-final
  // event does that, below.
  useEffect(() => {
    if (!streamId || processedStreamId.current === streamId) return
    if (stream.terminal !== 'done' && stream.terminal !== 'cancelled' && stream.terminal !== 'error') return
    processedStreamId.current = streamId

    if (stream.assistantText.trim() || stream.terminal === 'error') {
      setTurns((prev) => [
        ...prev,
        {
          id: streamId,
          role: 'assistant',
          text: stream.assistantText || stream.errorMessage || 'The agent did not respond.',
          at: Date.now(),
          errored: stream.terminal === 'error',
          reasoning: stream.reasoningText.trim() || undefined,
          tools: stream.tools,
        },
      ])
    }

    if (workspaceId && agent) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentHistory.sessions(workspaceId, agent) })
      if (sessionId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.agentHistory.messages(workspaceId, agent, sessionId),
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.terminal, streamId])

  // Only release `streamId` (which unmounts the EventSource) once the
  // connection is ACTUALLY over — never on content-final `done` alone.
  // This is what lets a second send start only after `stream_end`/
  // `cancel`/`apperror`/transport-error, per the wire contract.
  useEffect(() => {
    if (streamId && stream.connectionClosed) setStreamId(null)
  }, [streamId, stream.connectionClosed])

  const lastMessageRef = useRef<string | null>(null)

  async function send(text: string) {
    const message = text.trim()
    if (!message || !workspaceId || !agent) return
    if (streamId) return // a turn is already running
    lastMessageRef.current = message

    let activeSessionId = sessionId
    if (!activeSessionId) {
      try {
        const session = await queryClient.fetchQuery({
          queryKey: queryKeys.chat.session(workspaceId, agent),
          queryFn: () => createSession(workspaceId, agent),
          staleTime: Infinity,
        })
        activeSessionId = session.sessionId
        writePersistedSessionId(workspaceId, agent, activeSessionId)
      } catch (err) {
        handleError(err, { fallback: 'Could not start a session for this agent' })
        return
      }
    }

    setTurns((prev) => [...prev, { id: `${Date.now()}`, role: 'user', text: message, at: Date.now() }])

    const sentForAgent = agent
    const sentForWorkspaceId = workspaceId
    const seq = ++sendSeqRef.current

    setIsSending(true)
    try {
      const result = await startMutation.mutateAsync({ sessionId: activeSessionId as string, message })
      const stillActive =
        sendSeqRef.current === seq &&
        activeRef.current.agent === sentForAgent &&
        activeRef.current.workspaceId === sentForWorkspaceId
      if (!stillActive) {
        // Agent (or workspace) changed while `startTurn` was in flight —
        // discard the stale continuation rather than misbinding this
        // stream id onto the now-current agent/session. The backend turn
        // this created is cleaned up by the agent-switch effect above.
        // Don't touch `isSending` here: the agent-switch effect already
        // reset it for whichever agent is now current, and this stale
        // continuation must not resurrect any UI state.
        void cancelTurn(sentForWorkspaceId as string, sentForAgent as string, result.streamId).catch(() => {})
        return
      }
      setStreamId(result.streamId)
      setIsSending(false)
    } catch {
      /* onError already toasted */
      if (sendSeqRef.current === seq) setIsSending(false)
    }
  }

  function stop() {
    if (streamId) void cancelMutation.mutateAsync()
  }

  /** Abandons the currently-bound session and clears every trace of it
   * this hook remembers (persisted localStorage id, cached turns/stream
   * state) so the very next `send()` creates a genuinely NEW session via
   * `createSession` instead of continuing the old one — upstream's
   * `/api/session/new` always mints a fresh session id, so this alone is
   * enough to guarantee the next turn is a real, separate conversation.
   *
   * Does NOT clear an explicit `options.sessionId` (e.g. the caller's own
   * URL `?session=` param) — that is bound at a HIGHER priority than the
   * persisted id in this hook's own derivation (`boundSessionId`), and
   * clearing it is the CALLER's responsibility (it owns that param, this
   * hook only reads it) — see WorkspaceChat's own `newChat` wrapper,
   * which clears both this hook's state AND its own URL param together.
   * Refuses while a turn is actively streaming — abandoning a session
   * with a live turn still writing to it would orphan that turn
   * server-side with nothing left in this tab tracking it. */
  function newChat() {
    if (streamId) return
    if (workspaceId && agent) {
      clearPersistedSessionId(workspaceId, agent)
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.session(workspaceId, agent) })
      queryClient.removeQueries({ queryKey: queryKeys.chat.session(workspaceId, agent) })
    }
    setTurns([])
    processedStreamId.current = null
    seededRef.current = null
    reconnectedRef.current = null
    lastMessageRef.current = null
  }

  /** User-triggered recovery after a dropped connection (see canRetry) —
   * resends the last message as a fresh turn. Not a true replay: partial
   * assistant output from the dropped turn is not resumed. */
  function retry() {
    if (lastMessageRef.current) void send(lastMessageRef.current)
  }

  /** Re-fetch session history from the server — user-triggered refresh. */
  function reloadMessages() {
    if (streamId) return
    void reloadMutation.mutate()
  }

  function respondApproval(choice: ApprovalChoice, approvalId?: string) {
    void approvalMutation.mutateAsync({ choice, approvalId })
  }

  function respondClarify(response: string, clarifyId?: string) {
    void clarifyMutation.mutateAsync({ response, clarifyId })
  }

  return {
    turns,
    isStreaming: Boolean(streamId) && stream.terminal === 'streaming',
    isSending,
    assistantText: streamId ? stream.assistantText : '',
    reasoningText: streamId ? stream.reasoningText : '',
    tools: streamId ? stream.tools : [],
    approval: stream.approval,
    clarify: stream.clarify,
    canRetry: stream.canRetry,
    sessionError: sessionQuery.isError ? errorMessage(sessionQuery.error, 'Could not start a chat session') : null,
    send,
    stop,
    retry,
    newChat,
    reloadMessages,
    isReloadingMessages: reloadMutation.isPending,
    respondApproval,
    respondClarify,
  }
}
