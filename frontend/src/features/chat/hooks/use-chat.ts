import { useCallback, useEffect, useRef, useState } from 'react'
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
import {
  clearSelectedChatSessionId,
  writeSelectedChatSessionId,
} from '@/features/chat/chat-session-store'
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

/**
 * Ties session creation, turn start, and the SSE stream together for one
 * agent. Switching `agent` switches which session the chat is bound to —
 * each agent has its own React-Query-cached session, keyed by
 * `workspaceId` + `agent` so one agent's session can never leak into
 * another's (see AGENTS.md's chat-key rule).
 *
 * `options.sessionId`: the tab's selected session (from sessionStorage via
 * WorkspaceChat). When absent, `createSession` runs once on first send.
 *
 * Selected session id lives in `sessionStorage` per workspace+agent — one
 * slot, replaced on every history click. Survives reload within the same
 * tab but not across tabs.
 */
export function useChat(
  workspaceId: string | undefined,
  agent: string | null,
  options?: { sessionId?: string | null; onSessionIdChange?: () => void },
) {
  const selectedSessionId = options?.sessionId ?? null
  const onSessionIdChange = options?.onSessionIdChange
  const queryClient = useQueryClient()
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [streamId, setStreamId] = useState<string | null>(null)
  // Tracks whether a send is in flight FOR THE CURRENTLY BOUND agent/session
  // — not just whether the startTurn mutation object is pending. Reset
  // immediately on agent switch so the new agent's composer is never stuck
  // showing the old agent's in-flight state.
  const [isSending, setIsSending] = useState(false)
  const [seededSessionId, setSeededSessionId] = useState<string | null>(null)
  const processedStreamId = useRef<string | null>(null)
  const sendSeqRef = useRef(0)
  const streamIdRef = useRef<string | null>(null)
  // Latest agent/workspace snapshot, read by async continuations to detect
  // a switch that happened while they were in flight — same guard shape as
  // the agent-history request-id fix.
  const activeRef = useRef({ workspaceId, agent })
  activeRef.current = { workspaceId, agent }

  const boundSessionId = selectedSessionId

  const sessionQuery = useQuery({
    queryKey: queryKeys.chat.session(workspaceId ?? '', agent ?? ''),
    queryFn: () => createSession(workspaceId as string, agent as string),
    // Lazy — first send creates the session via fetchQuery in send(). Avoids a
    // createSession round trip on every agent open with no stored selection.
    enabled: false,
    staleTime: Infinity,
    retry: false,
  })
  const sessionId = boundSessionId ?? sessionQuery.data?.sessionId ?? null

  useEffect(() => {
    if (workspaceId && agent && sessionQuery.data?.sessionId) {
      writeSelectedChatSessionId(workspaceId, agent, sessionQuery.data.sessionId)
      onSessionIdChange?.()
    }
  }, [workspaceId, agent, sessionQuery.data?.sessionId, onSessionIdChange])

  const messagesQueryKey = queryKeys.agentHistory.messages(
    workspaceId ?? '',
    agent ?? '',
    boundSessionId ?? '',
  )

  const historyQuery = useQuery({
    queryKey: messagesQueryKey,
    queryFn: () => listAgentMessages(workspaceId as string, agent as string, boundSessionId as string),
    enabled: Boolean(workspaceId && agent && boundSessionId),
    initialData: () => queryClient.getQueryData(messagesQueryKey),
    staleTime: 30_000,
  })
  const seededRef = useRef<string | null>(null)

  // Backs the reconnect effect further below — see its own comment for why
  // this exists. One-shot (no polling), fired once `sessionId` resolves.
  const statusQueryKey = queryKeys.chat.sessionStatus(workspaceId ?? '', agent ?? '', sessionId ?? '')

  const sessionStatusQuery = useQuery({
    queryKey: statusQueryKey,
    queryFn: () => getSessionStatus(workspaceId as string, agent as string, sessionId as string),
    enabled: Boolean(workspaceId && agent && sessionId),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  })
  const awaitingActiveStreamCheck = Boolean(
    boundSessionId &&
      sessionId &&
      !streamId &&
      (sessionStatusQuery.isPending || sessionStatusQuery.isFetching),
  )
  const isLoadingTranscript = Boolean(
    boundSessionId &&
      !streamId &&
      (awaitingActiveStreamCheck ||
        (seededSessionId !== boundSessionId &&
          (historyQuery.isPending || historyQuery.isFetching || Boolean(historyQuery.data)))),
  )
  const reconnectedRef = useRef<string | null>(null)
  const prevBindingRef = useRef<{
    workspaceId?: string
    agent: string | null
    session: string | null
  } | undefined>(undefined)

  useEffect(() => {
    streamIdRef.current = streamId
  }, [streamId])

  useEffect(() => {
    const prev = prevBindingRef.current
    const isInitialMount = prev === undefined
    prevBindingRef.current = { workspaceId, agent, session: boundSessionId }

    const agentOrWsChanged = Boolean(
      prev && !isInitialMount && (prev.workspaceId !== workspaceId || prev.agent !== agent),
    )
    const sessionSwitch = Boolean(
      prev &&
        !isInitialMount &&
        prev.agent === agent &&
        prev.session !== boundSessionId &&
        prev.session !== null &&
        boundSessionId !== null,
    )
    const sessionCleared = Boolean(
      prev &&
        !isInitialMount &&
        prev.agent === agent &&
        prev.session !== null &&
        boundSessionId === null,
    )
    const shouldReset = agentOrWsChanged || sessionSwitch || sessionCleared

    if (shouldReset) {
      const cancelAgent = agentOrWsChanged ? prev!.agent : agent
      const abandoned = streamIdRef.current
      if (abandoned && cancelAgent) {
        void cancelTurn(workspaceId as string, cancelAgent, abandoned).catch(() => {})
      }
      setTurns([])
      setStreamId(null)
      setIsSending(false)
      processedStreamId.current = null
      seededRef.current = null
      setSeededSessionId(null)
      reconnectedRef.current = null
    }

    return () => {
      if (!shouldReset) return
      const cancelAgent = agentOrWsChanged ? prev!.agent : agent
      const abandoned = streamIdRef.current
      if (abandoned && cancelAgent) {
        void cancelTurn(workspaceId as string, cancelAgent, abandoned).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agent, boundSessionId])

  // Seed turn history from the bound session's past messages once loaded,
  // before any new turn is sent on top of it.
  useEffect(() => {
    if (!boundSessionId || !historyQuery.data) return
    if (seededRef.current === boundSessionId) return
    seededRef.current = boundSessionId
    setSeededSessionId(boundSessionId)
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
  const bindActiveStream = useCallback((activeStreamId: string | null) => {
    if (!activeStreamId) return
    const current = streamIdRef.current
    if (current === activeStreamId) {
      setStreamId(null)
      requestAnimationFrame(() => setStreamId(activeStreamId))
      return
    }
    setStreamId(activeStreamId)
  }, [])

  useEffect(() => {
    if (!sessionId || !sessionStatusQuery.data) return
    if (reconnectedRef.current === sessionId) return
    reconnectedRef.current = sessionId
    // Never override a stream this tab already knows about (a real local
    // send in flight) — this effect exists only to RECOVER a turn this
    // tab has no local memory of.
    if (streamIdRef.current) return
    bindActiveStream(sessionStatusQuery.data.activeStreamId)
  }, [sessionId, sessionStatusQuery.data, bindActiveStream])

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
    mutationFn: async () => {
      if (!workspaceId || !agent || !sessionId) {
        throw new Error('No active session to reload')
      }
      const [messages, status] = await Promise.all([
        listAgentMessages(workspaceId, agent, sessionId),
        getSessionStatus(workspaceId, agent, sessionId),
      ])
      return { messages, status }
    },
    onSuccess: ({ messages, status }) => {
      if (!sessionId) return
      seededRef.current = sessionId
      setSeededSessionId(sessionId)
      setTurns(historyToTurns(sessionId, messages.messages))
      queryClient.setQueryData(messagesQueryKey, messages)
      queryClient.setQueryData(statusQueryKey, status)
      bindActiveStream(status.activeStreamId)
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
      // The turn just went idle — re-fetch the sidebar's agents list so its
      // busy dot (AgentSummary.isWorking) clears for this agent. Mirrors
      // the `send()` invalidation below that lights it in the first place.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentHistory.agents(workspaceId) })
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
        writeSelectedChatSessionId(workspaceId, agent, activeSessionId)
        onSessionIdChange?.()
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
      // Turn just started server-side — re-fetch the sidebar's agents list
      // so its busy dot lights immediately rather than waiting for this
      // agent's OWN turn-settle invalidation above (which only fires once
      // the turn ends) or another agent's unrelated 30s staleTime to lapse.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentHistory.agents(sentForWorkspaceId) })
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
      clearSelectedChatSessionId(workspaceId, agent)
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.session(workspaceId, agent) })
      queryClient.removeQueries({ queryKey: queryKeys.chat.session(workspaceId, agent) })
    }
    setTurns([])
    processedStreamId.current = null
    seededRef.current = null
    setSeededSessionId(null)
    reconnectedRef.current = null
    lastMessageRef.current = null
  }

  /** User-triggered recovery after a dropped connection (see canRetry) —
   * resends the last message as a fresh turn. Not a true replay: partial
   * assistant output from the dropped turn is not resumed. */
  function retry() {
    if (lastMessageRef.current) void send(lastMessageRef.current)
  }

  /** Re-fetch session history and re-check for a live server-side stream. */
  function reloadMessages() {
    if (streamIdRef.current) return
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
    isLoadingTranscript,
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
