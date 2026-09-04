import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  cancelTurn,
  createSession,
  getSessionStatus,
  respondToApproval,
  respondToClarify,
  startTurn,
  uploadAttachment,
} from '@/features/chat/api'
import { listAgentMessages } from '@/features/agent-history/api'
import { setAgentWorking, touchCachedSession } from '@/features/agent-history/cache'
import {
  clearSelectedChatSessionId,
  writeSelectedChatSessionId,
} from '@/features/chat/chat-session-store'
import { useChatStream } from '@/features/chat/hooks/use-chat-stream'
import { queryKeys } from '@/lib/query-keys'
import { errorMessage } from '@/lib/api'
import { handleError } from '@/lib/handle-error'
import type { ApprovalChoice, ChatAttachment, ToolActivity } from '@/features/chat/types'
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
  /** User-only in practice (upstream only ever writes `attachments` onto
   * `role: "user"` message dicts — `_checkpoint_user_message_for_eager_session_save`,
   * `backend/upstream/api/routes.py:22499`). Populated two ways, both
   * carrying the SAME normalized `{name,path,mime,size?,isImage?}` shape:
   * (1) a locally-sent turn gets it straight from `uploadAttachment()`'s
   * real upload results in `send()` below — never a placeholder; (2) a
   * history-reloaded turn gets it from the wrapper's `agent_history`
   * projection (`historyToTurns` below), which now threads through
   * upstream's persisted `user_msg["attachments"]` instead of dropping it
   * (see `backend/wrapper/.../agent_history/service.py::_project_attachments`).
   * Absent (not `[]`) means this turn never had attachments. */
  attachments?: ChatAttachment[]
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

/**
 * `baseOffset` is that PAGE's absolute offset into the full session (the
 * server's echoed `offset`, see `ListAgentMessagesResult`) — NOT always 0.
 * Ids are keyed off `baseOffset + <index within this page>` (the index
 * before filtering, so a filtered-out row still reserves its slot and two
 * different pages can never mint the same id) rather than a plain
 * per-page `index`, because "load older messages" (see `loadOlderMessages`
 * below) prepends a second, earlier page onto `turns` — a bare per-page
 * index would restart at 0 for that page and collide with the first
 * page's own ids, corrupting React's `key`-based reconciliation. */
function historyToTurns(sessionKey: string, messages: AgentMessage[], baseOffset = 0): ChatTurn[] {
  return messages
    .map((message, index) => ({ message, absoluteIndex: baseOffset + index }))
    .filter(({ message }) => isDisplayableHistoryMessage(message))
    .map(({ message, absoluteIndex }) => ({
      id: `history-${sessionKey}-${absoluteIndex}`,
      role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
      text: message.content,
      at: message.timestamp,
      // Same `{name,path,mime,size?,isImage?}` shape as a freshly-uploaded
      // `ChatAttachment` — the wrapper's projection (see `AgentMessage`'s
      // own doc comment) already normalizes it to match, so no remap is
      // needed here beyond the field being optional either way.
      attachments: message.attachments,
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
 *
 * `options.getPendingModel`: a GETTER (not a static value) read at the
 * exact moment `createSession` actually fires — never read once up front
 * — so a model picked on an empty composer rides along with the session
 * that gets created for the very first send, exactly like the real
 * Hermes WebUI's own `newSession()` consuming
 * `window._emptyComposerModelOverride`
 * (`backend/upstream/static/sessions.js` ~line 1446). A getter (rather
 * than passing the value itself) avoids a stale closure: `useChat` is
 * called once per render with whatever `options` that render captured,
 * but `send()` can run much later (after the user actually types and
 * hits Enter) — a plain value frozen at that render could be arbitrarily
 * stale by the time a session is actually created. `options.onPendingModelConsumed`
 * fires right after a pending pick was actually sent to the server, so
 * the caller can clear it (mirrors `_clearEmptyComposerModelOverride()`).
 */
export function useChat(
  workspaceId: string | undefined,
  agent: string | null,
  options?: {
    sessionId?: string | null
    onSessionIdChange?: () => void
    getPendingModel?: () => { model: string; modelProvider: string | null } | null
    onPendingModelConsumed?: () => void
  },
) {
  const selectedSessionId = options?.sessionId ?? null
  const onSessionIdChange = options?.onSessionIdChange
  const getPendingModel = options?.getPendingModel
  const onPendingModelConsumed = options?.onPendingModelConsumed
  const queryClient = useQueryClient()
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [streamId, setStreamId] = useState<string | null>(null)
  // Tracks whether a send is in flight FOR THE CURRENTLY BOUND agent/session
  // — not just whether the startTurn mutation object is pending. Reset
  // immediately on agent switch so the new agent's composer is never stuck
  // showing the old agent's in-flight state.
  const [isSending, setIsSending] = useState(false)
  const [seededSessionId, setSeededSessionId] = useState<string | null>(null)
  // Oldest-loaded-page bookkeeping for "load older messages" (see
  // `loadOlderMessages` further below). `oldestLoadedOffset` is the
  // server's echoed `offset` for whichever page currently sits at the
  // FRONT of `turns` — the next-older fetch starts at `oldestLoadedOffset
  // - limit`, never a value this hook invents. `null` means "no page
  // loaded yet" (still loading, or no bound session), deliberately
  // distinct from `0` ("the oldest page IS loaded, nothing more to fetch").
  const [oldestLoadedOffset, setOldestLoadedOffset] = useState<number | null>(null)
  const [totalHistoryMessages, setTotalHistoryMessages] = useState(0)
  const processedStreamId = useRef<string | null>(null)
  const sendSeqRef = useRef(0)
  const streamIdRef = useRef<string | null>(null)
  // Latest agent/workspace snapshot, read by async continuations to detect
  // a switch that happened while they were in flight — same guard shape as
  // the agent-history request-id fix.
  const activeRef = useRef({ workspaceId, agent })
  activeRef.current = { workspaceId, agent }

  const boundSessionId = selectedSessionId
  const bindingKey = `${workspaceId ?? ''}|${agent ?? ''}|${boundSessionId ?? ''}`
  const bindingKeyRef = useRef(bindingKey)
  bindingKeyRef.current = bindingKey
  const streamOwnerKeyRef = useRef<string | null>(null)
  const reconnectBindingRef = useRef<string | null>(null)
  const prevBindingKeyRef = useRef(bindingKey)
  if (prevBindingKeyRef.current !== bindingKey) {
    prevBindingKeyRef.current = bindingKey
    streamOwnerKeyRef.current = null
    reconnectBindingRef.current = null
  }
  const effectiveStreamId =
    streamId && streamOwnerKeyRef.current === bindingKey ? streamId : null

  const claimStream = useCallback((id: string | null) => {
    streamOwnerKeyRef.current = id ? bindingKeyRef.current : null
    setStreamId(id)
  }, [])

  const sessionQuery = useQuery({
    queryKey: queryKeys.chat.session(workspaceId ?? '', agent ?? ''),
    queryFn: () => {
      const pending = getPendingModel?.()
      return createSession(workspaceId as string, agent as string, pending?.model, pending?.modelProvider)
    },
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
  const seededHistoryRef = useRef<unknown>(null)

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
      !effectiveStreamId &&
      (sessionStatusQuery.isPending || sessionStatusQuery.isFetching),
  )
  const isLoadingTranscript = Boolean(
    boundSessionId &&
      !effectiveStreamId &&
      (awaitingActiveStreamCheck ||
        (seededSessionId !== boundSessionId &&
          (historyQuery.isPending || historyQuery.isFetching || Boolean(historyQuery.data)))),
  )
  const prevBindingRef = useRef<{
    workspaceId?: string
    agent: string | null
    session: string | null
  } | undefined>(undefined)

  useEffect(() => {
    streamIdRef.current = effectiveStreamId
  }, [effectiveStreamId])

  useLayoutEffect(() => {
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
      // Switching chat tabs only detaches this pane. Do not cancel the
      // server turn: its session remains the owner and the status check
      // below reattaches the stream when the tab is selected again.
      setTurns([])
      claimStream(null)
      setIsSending(false)
      processedStreamId.current = null
      seededRef.current = null
      setSeededSessionId(null)
      setOldestLoadedOffset(null)
      setTotalHistoryMessages(0)
      reconnectBindingRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agent, boundSessionId, claimStream])

  // Seed turn history from the bound session's past messages once loaded,
  // before any new turn is sent on top of it.
  useEffect(() => {
    if (!boundSessionId || !historyQuery.data) return
    if (seededRef.current === boundSessionId && seededHistoryRef.current === historyQuery.data) return
    seededRef.current = boundSessionId
    seededHistoryRef.current = historyQuery.data
    setSeededSessionId(boundSessionId)
    setTurns(historyToTurns(boundSessionId, historyQuery.data.messages, historyQuery.data.offset))
    setOldestLoadedOffset(historyQuery.data.offset)
    setTotalHistoryMessages(historyQuery.data.total)
  }, [boundSessionId, historyQuery.data])

  // Detect a turn already running server-side for this exact session — a
  // one-shot check (no polling, matches this hook's own no-polling
  // convention elsewhere), fired once `sessionId` resolves. Reload/remount
  // is the only reason this ever finds something: normal in-tab sending
  // already has `streamId` set locally and never needs this. Runs AFTER
  // the agent/session reset effect above (declaration order = commit
  // order for same-render effects) so switching agents can never leave a
  // stale `setStreamId` racing the reset's own `setStreamId(null)`.
  const bindActiveStream = useCallback(
    (activeStreamId: string | null) => {
      if (!activeStreamId) return
      const current = streamIdRef.current
      if (current === activeStreamId) {
        claimStream(null)
        requestAnimationFrame(() => claimStream(activeStreamId))
        return
      }
      claimStream(activeStreamId)
    },
    [claimStream],
  )

  useEffect(() => {
    if (!sessionId || !sessionStatusQuery.isFetched) return
    if (reconnectBindingRef.current === bindingKey) return
    reconnectBindingRef.current = bindingKey
    if (streamIdRef.current) return
    bindActiveStream(sessionStatusQuery.data?.activeStreamId ?? null)
  }, [bindingKey, sessionId, sessionStatusQuery.isFetched, sessionStatusQuery.data, bindActiveStream])

  const stream = useChatStream({ workspaceId, agent, sessionId, streamId: effectiveStreamId })

  const startMutation = useMutation({
    mutationFn: ({
      sessionId: sid,
      message,
      attachments,
    }: {
      sessionId: string
      message: string
      attachments?: ChatAttachment[]
    }) => startTurn(workspaceId as string, agent as string, sid, message, attachments),
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
      setTurns(historyToTurns(sessionId, messages.messages, messages.offset))
      // A manual reload always re-fetches the NEWEST page (no offset arg,
      // same as `historyQuery`'s own first fetch) — reset the older-page
      // bookkeeping to match, or a stale `oldestLoadedOffset` from before
      // the reload would compute the next "load older" fetch from the
      // wrong position.
      setOldestLoadedOffset(messages.offset)
      setTotalHistoryMessages(messages.total)
      queryClient.setQueryData(messagesQueryKey, messages)
      queryClient.setQueryData(statusQueryKey, status)
      bindActiveStream(status.activeStreamId)
    },
    onError: (err) => handleError(err, { fallback: 'Could not reload messages' }),
  })

  /** Whether there is any older page left to fetch — `oldestLoadedOffset`
   * `null` means nothing has loaded yet (nothing to page from); `<= 0`
   * means the oldest page (offset 0) is already loaded, so there is
   * nothing further back. Read by `use-chat-transcript-scroll.ts` to
   * decide whether a near-top scroll should even attempt a fetch. */
  const hasOlderMessages = oldestLoadedOffset !== null && oldestLoadedOffset > 0

  const loadOlderMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId || !agent || !sessionId || oldestLoadedOffset === null) {
        throw new Error('No older messages to load')
      }
      // Same page size the initial/newest fetch used (echoed back by the
      // server on every page, per AGENTS.md's infinite-query convention:
      // "later pages send the echoed limit"), so paging backward never
      // silently changes the page size the user is used to.
      const limit = historyQuery.data?.limit ?? 50
      const nextOffset = Math.max(0, oldestLoadedOffset - limit)
      const page = await listAgentMessages(workspaceId, agent, sessionId, {
        limit: oldestLoadedOffset - nextOffset,
        offset: nextOffset,
      })
      return page
    },
    onSuccess: (page) => {
      if (!sessionId) return
      // Prepend — never replace. `historyToTurns` computes ids from THIS
      // page's own absolute offset, so they can't collide with whatever
      // is already loaded (see that function's doc comment).
      setTurns((prev) => [...historyToTurns(sessionId, page.messages, page.offset), ...prev])
      setOldestLoadedOffset(page.offset)
      setTotalHistoryMessages(page.total)
    },
    onError: (err) => handleError(err, { fallback: 'Could not load older messages' }),
  })

  /** Fetches the next-older page and prepends it to `turns`. Guarded
   * against firing with nothing left to load (`hasOlderMessages`) and
   * against overlapping requests (`isPending` — a second scroll-to-top
   * while one fetch is already in flight must not fire a second one);
   * TanStack Query's own mutation `isPending` is enough here since this
   * hook only ever runs one `loadOlderMutation` at a time (no per-request
   * key), so a stale in-flight fetch can never linger past a session
   * switch — the `boundSessionId` effect above already resets `turns`
   * and `oldestLoadedOffset` on any switch, and this mutation is keyed
   * off the OLD `sessionId` closed over at call time, so its (dropped)
   * result targets a session no longer bound. */
  function loadOlderMessages() {
    if (!hasOlderMessages || loadOlderMutation.isPending) return
    void loadOlderMutation.mutate()
  }

  // Snapshot the assembled assistant reply into turn history once content
  // is final (`done`/`cancelled`/`error`). This does NOT close the
  // connection or release `streamId` — only a genuine connection-final
  // event does that, below.
  useEffect(() => {
    if (!effectiveStreamId || processedStreamId.current === effectiveStreamId) return
    if (stream.terminal !== 'done' && stream.terminal !== 'cancelled' && stream.terminal !== 'error') return
    processedStreamId.current = effectiveStreamId

    if (stream.assistantText.trim() || stream.terminal === 'error') {
      setTurns((prev) => [
        ...prev,
        {
          id: effectiveStreamId,
          role: 'assistant',
          text: stream.assistantText || stream.errorMessage || 'The agent did not respond.',
          at: Date.now(),
          errored: stream.terminal === 'error',
          reasoning: stream.reasoningText.trim() || undefined,
          tools: stream.tools,
        },
      ])
    }

    if (workspaceId && agent && sessionId) {
      setAgentWorking(queryClient, workspaceId, agent, false)
      touchCachedSession(queryClient, workspaceId, agent, sessionId, {
        messageCountDelta: stream.assistantText.trim() || stream.terminal === 'error' ? 1 : 0,
        at: Date.now(),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.terminal, effectiveStreamId])

  // Only release `streamId` (which unmounts the EventSource) once the
  // connection is ACTUALLY over — never on content-final `done` alone.
  // This is what lets a second send start only after `stream_end`/
  // `cancel`/`apperror`/transport-error, per the wire contract.
  useEffect(() => {
    if (effectiveStreamId && stream.connectionClosed) claimStream(null)
  }, [effectiveStreamId, stream.connectionClosed, claimStream])

  const lastMessageRef = useRef<string | null>(null)
  // Files are immutable Blob-backed objects, so it's safe to hold onto the
  // same `File` references across renders/time purely for a later retry —
  // nothing in this hook (or elsewhere in this codebase) revokes or
  // consumes them. Set alongside `lastMessageRef.current` at the same
  // point, so retry() below can resend both together.
  const lastFilesRef = useRef<File[] | undefined>(undefined)
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false)

  /**
   * `files`, when present, are uploaded to Hermes' real per-session
   * attachment inbox (`POST /api/upload`) BEFORE the turn starts, and the
   * resulting `{name,path,mime,...}` records are sent as `startTurn`'s
   * `attachments` — the only wire-contract-supported way to attach a file
   * (see `rust_gateway/docs/hermes-chat-wire-contract.md` §1.1 and
   * `backend/upstream/api/upload.py`). There is no "attach without
   * uploading" — a chip in the composer that never reaches this function
   * would be exactly the silent-no-op bug this replaces.
   */
  async function send(text: string, files?: File[]) {
    const message = text.trim()
    if ((!message && !files?.length) || !workspaceId || !agent) return
    if (effectiveStreamId) return // a turn is already running
    lastMessageRef.current = message
    lastFilesRef.current = files

    let activeSessionId = sessionId
    if (!activeSessionId) {
      // A model picked on the still-empty composer (no session existed to
      // scope it to) rides along with THIS creation call — read fresh
      // right here, not at some earlier render, so the very latest pick
      // wins (see this hook's own doc comment on `getPendingModel`).
      const pending = getPendingModel?.()
      try {
        const session = await queryClient.fetchQuery({
          queryKey: queryKeys.chat.session(workspaceId, agent),
          queryFn: () => createSession(workspaceId, agent, pending?.model, pending?.modelProvider),
          staleTime: Infinity,
        })
        activeSessionId = session.sessionId
        writeSelectedChatSessionId(workspaceId, agent, activeSessionId)
        onSessionIdChange?.()
        if (pending) onPendingModelConsumed?.()
      } catch (err) {
        handleError(err, { fallback: 'Could not start a session for this agent' })
        return
      }
    }

    let attachments: ChatAttachment[] | undefined
    if (files && files.length > 0) {
      setIsUploadingAttachments(true)
      try {
        attachments = await Promise.all(
          files.map((file) => uploadAttachment(workspaceId, agent, activeSessionId as string, file)),
        )
      } catch (err) {
        handleError(err, { fallback: 'Could not upload one or more attached files' })
        return
      } finally {
        setIsUploadingAttachments(false)
      }
    }

    // Mirrors upstream's own vanilla client (`static/messages.js:1660-1662`):
    // `message` alone is never allowed to be empty server-side (trimmed-empty
    // 400s at `/api/chat/start`), so an attachments-only send synthesizes the
    // same "I've uploaded N file(s): ..." text instead of sending a blank/
    // space string, and a message WITH attachments gets the same
    // `[Attached files: ...]` suffix the vanilla client appends. This
    // synthesized text is what actually goes over the wire — required by
    // the backend contract, unchanged here.
    const attachmentNames = attachments?.map((a) => a.name) ?? []
    const effectiveMessage =
      attachments && attachments.length > 0
        ? message
          ? `${message}\n\n[Attached files: ${attachmentNames.join(', ')}]`
          : `I've uploaded ${attachments.length} file(s): ${attachmentNames.join(', ')}`
        : message

    // What the human actually sees in their own chat bubble must never
    // contain the synthetic wire-only wording above. Upstream strips its
    // own equivalent suffix before display (see
    // `backend/upstream/static/sessions.js:3285,7265`:
    // `text.replace(/\n\n\[Attached files: [^\]]+\]$/,'').trim()`) even
    // though the unstripped text is what's stored/sent — same split here:
    // - text+files: show the original typed message, suffix stripped.
    // - files-only: no original message exists to fall back to, so show
    //   the attachment names alone rather than the raw synthesized
    //   "I've uploaded N file(s): ..." sentence.
    const displayMessage =
      attachments && attachments.length > 0
        ? message || `Attached: ${attachmentNames.join(', ')}`
        : message

    setTurns((prev) => [
      ...prev,
      {
        id: `${Date.now()}`,
        role: 'user',
        text: displayMessage,
        at: Date.now(),
        // The SAME `uploadAttachment()` results sent to `startTurn` below,
        // not a re-derived or partial copy — a locally-sent turn's
        // attachment metadata must never drift from what actually reached
        // the wire. `undefined` (not `[]`) when there were no files,
        // matching every other optional field's convention on `ChatTurn`.
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      },
    ])

    const sentForAgent = agent
    const sentForWorkspaceId = workspaceId
    const seq = ++sendSeqRef.current

    setIsSending(true)
    try {
      const result = await startMutation.mutateAsync({
        sessionId: activeSessionId as string,
        message: effectiveMessage,
        attachments,
      })
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
      claimStream(result.streamId)
      setIsSending(false)
      setAgentWorking(queryClient, sentForWorkspaceId, sentForAgent, true)
        touchCachedSession(queryClient, sentForWorkspaceId, sentForAgent, activeSessionId as string, {
          title: result.title,
          messageCountDelta: 1,
          at: Date.now(),
        })
        // The user message is persisted by startTurn asynchronously. Force
        // the session transcript cache to refresh before a tab switch can
        // seed from the stale pre-send page.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.agentHistory.messages(sentForWorkspaceId, sentForAgent, activeSessionId as string),
        })
    } catch {
      /* onError already toasted */
      if (sendSeqRef.current === seq) setIsSending(false)
    }
  }

  function stop() {
    if (effectiveStreamId) void cancelMutation.mutateAsync()
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
    if (effectiveStreamId) return
    if (workspaceId && agent) {
      clearSelectedChatSessionId(workspaceId, agent)
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.session(workspaceId, agent) })
      queryClient.removeQueries({ queryKey: queryKeys.chat.session(workspaceId, agent) })
    }
    setTurns([])
    processedStreamId.current = null
    seededRef.current = null
    setSeededSessionId(null)
    setOldestLoadedOffset(null)
    setTotalHistoryMessages(0)
    reconnectBindingRef.current = null
    lastMessageRef.current = null
    lastFilesRef.current = undefined
  }

  /** Local-only user+assistant turn pair for a slash command's echo +
   * result — mirrors upstream Hermes WebUI's own command interception
   * EXACTLY (`backend/upstream/static/messages.js`'s slash-command
   * intercept block): `S.messages.push({role:'user',...})` for the typed
   * command text, then `S.messages.push({role:'assistant',...})` for its
   * result (bundle/exec output, a cli_only explanation, etc.) — a real
   * chat message pair, not a floating toast/banner. Never touches the
   * server or any session id: purely client-side state, exactly like
   * upstream's own in-memory `S.messages` push for these. `echoCommand`
   * mirrors upstream's `noEcho` flag inverted — most of upstream's
   * COMMANDS table sets `noEcho:true` for pure actions (e.g. `/new`
   * itself never appears in the transcript, see `cmdNew`'s own toast-only
   * feedback) so the default here is to skip the user-message half for a
   * pure local action; pass `true` for anything that actually produces
   * a result worth seeing in context (bundle resolve, exec output). */
  function pushLocalCommandResult(
    commandText: string,
    resultText: string,
    options?: { echoCommand?: boolean; errored?: boolean },
  ) {
    const now = Date.now()
    setTurns((prev) => [
      ...prev,
      ...(options?.echoCommand
        ? [{ id: `local-cmd-${now}`, role: 'user' as const, text: commandText, at: now }]
        : []),
      {
        id: `local-cmd-${now}-result`,
        role: 'assistant' as const,
        text: resultText,
        at: now,
        errored: options?.errored,
      },
    ])
  }

  /** User-triggered recovery after a dropped connection (see canRetry) —
   * resends the last message (and any attachments it had) as a fresh
   * turn. Not a true replay: partial assistant output from the dropped
   * turn is not resumed. */
  function retry() {
    if (lastMessageRef.current) void send(lastMessageRef.current, lastFilesRef.current)
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
    // The session a turn's attachments actually live under server-side
    // (`_session_attachment_dir(sessionId)`) — NOT always the same as the
    // caller's own `options.sessionId` (`boundSessionId`): a brand-new
    // chat's first send creates a session lazily inside `send()` above,
    // so `boundSessionId` stays `null` until `writeSelectedChatSessionId`
    // runs on the NEXT render, while `sessionId` here already resolves via
    // `sessionQuery.data?.sessionId` the same render `createSession`
    // settles. Exposed so callers building a real attachment file URL
    // (`attachmentFileUrl`, needs `session_id`) always have the CURRENT
    // session, not a one-render-stale one.
    sessionId,
    isStreaming: Boolean(effectiveStreamId) && stream.terminal === 'streaming',
    isSending,
    assistantText: effectiveStreamId ? stream.assistantText : '',
    reasoningText: effectiveStreamId ? stream.reasoningText : '',
    tools: effectiveStreamId ? stream.tools : [],
    approval: stream.approval,
    clarify: stream.clarify,
    canRetry: stream.canRetry,
    isLoadingTranscript,
    sessionError: sessionQuery.isError ? errorMessage(sessionQuery.error, 'Could not start a chat session') : null,
    isUploadingAttachments,
    send,
    stop,
    retry,
    newChat,
    pushLocalCommandResult,
    reloadMessages,
    isReloadingMessages: reloadMutation.isPending,
    loadOlderMessages,
    isLoadingOlderMessages: loadOlderMutation.isPending,
    hasOlderMessages,
    totalHistoryMessages,
    respondApproval,
    respondClarify,
  }
}
