import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  cancelTurn,
  createSession,
  respondToApproval,
  respondToClarify,
  startTurn,
} from '@/features/chat/api'
import { useChatStream } from '@/features/chat/hooks/use-chat-stream'
import { queryKeys } from '@/lib/query-keys'
import { errorMessage } from '@/lib/api'
import { handleError } from '@/lib/handle-error'
import type { ApprovalChoice } from '@/features/chat/types'

export type ChatTurn = {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  errored?: boolean
}

/**
 * Ties session creation, turn start, and the SSE stream together for one
 * agent. Switching `agent` switches which session the chat is bound to —
 * each agent has its own React-Query-cached session, keyed by
 * `workspaceId` + `agent` so one agent's session can never leak into
 * another's (see AGENTS.md's chat-key rule).
 */
export function useChat(workspaceId: string | undefined, agent: string | null) {
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

  const sessionQuery = useQuery({
    queryKey: queryKeys.chat.session(workspaceId ?? '', agent ?? ''),
    queryFn: () => createSession(workspaceId as string, agent as string),
    enabled: Boolean(workspaceId && agent),
    staleTime: Infinity,
    retry: false,
  })
  const sessionId = sessionQuery.data?.sessionId ?? null

  useEffect(() => {
    streamIdRef.current = streamId
  }, [streamId])

  useEffect(() => {
    setTurns([])
    setStreamId(null)
    setIsSending(false)
    processedStreamId.current = null
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
  }, [workspaceId, agent])

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

  /** User-triggered recovery after a dropped connection (see canRetry) —
   * resends the last message as a fresh turn. Not a true replay: partial
   * assistant output from the dropped turn is not resumed. */
  function retry() {
    if (lastMessageRef.current) void send(lastMessageRef.current)
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
    respondApproval,
    respondClarify,
  }
}
