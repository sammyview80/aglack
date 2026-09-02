import { useEffect, useRef, useState } from 'react'
import { chatStreamUrl } from '@/features/chat/api'
import type {
  ApprovalPrompt,
  ChatTerminalState,
  ClarifyPrompt,
  ToolActivity,
} from '@/features/chat/types'

type UseChatStreamArgs = {
  workspaceId: string | undefined
  agent: string | null
  sessionId: string | null
  streamId: string | null
}

type ChatStreamState = {
  assistantText: string
  reasoningText: string
  tools: ToolActivity[]
  terminal: ChatTerminalState
  approval: ApprovalPrompt | null
  clarify: ClarifyPrompt | null
  errorMessage: string | null
  /** True only once the CONNECTION itself is over (`stream_end`, `cancel`,
   * `apperror`, or transport `error`) — never on content-final `done`. Gate
   * "can the user send again" on this, not on `terminal`. */
  connectionClosed: boolean
  /** True once transport dropped mid-turn with recoverable partial content;
   * lets the UI offer a retry instead of silently discarding the turn. */
  canRetry: boolean
}

const INITIAL_STATE: ChatStreamState = {
  assistantText: '',
  reasoningText: '',
  tools: [],
  terminal: 'idle',
  approval: null,
  clarify: null,
  errorMessage: null,
  connectionClosed: false,
  canRetry: false,
}

function safeParse(data: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function matchesSession(payload: Record<string, unknown>, sessionId: string | null): boolean {
  if (!sessionId) return true
  const eventSessionId = payload.session_id
  return eventSessionId === undefined || eventSessionId === sessionId
}

/**
 * Owns one `EventSource` connection for the active turn. Per the wire
 * contract (`rust_gateway/docs/hermes-chat-wire-contract.md`): `token`
 * deltas are APPENDED, never replace; `done` marks content final but does
 * NOT close the connection; the close set is exactly
 * `{stream_end, cancel, apperror}` (native transport `error` is treated as
 * terminal here too, since this hook does not implement journal-replay
 * reconnection). Never reset accumulated text except when `streamId`
 * itself changes to a new turn.
 */
export function useChatStream({ workspaceId, agent, sessionId, streamId }: UseChatStreamArgs) {
  const [state, setState] = useState<ChatStreamState>(INITIAL_STATE)
  const contentFinalRef = useRef(false)

  useEffect(() => {
    setState(INITIAL_STATE)
    contentFinalRef.current = false

    if (!workspaceId || !agent || !streamId) return

    const source = new EventSource(chatStreamUrl(workspaceId, agent, streamId), {
      withCredentials: true,
    })
    setState((prev) => ({ ...prev, terminal: 'streaming' }))

    function on(name: string, handler: (payload: Record<string, unknown>) => void) {
      source.addEventListener(name, (event) => {
        const payload = safeParse((event as MessageEvent<string>).data)
        if (!matchesSession(payload, sessionId)) return
        handler(payload)
      })
    }

    on('token', (payload) => {
      const text = typeof payload.text === 'string' ? payload.text : ''
      setState((prev) => ({ ...prev, assistantText: prev.assistantText + text }))
    })

    on('interim_assistant', (payload) => {
      const text = typeof payload.text === 'string' ? payload.text : ''
      setState((prev) => ({ ...prev, assistantText: prev.assistantText + text }))
    })

    on('reasoning', (payload) => {
      const text = typeof payload.text === 'string' ? payload.text : ''
      setState((prev) => ({ ...prev, reasoningText: prev.reasoningText + text }))
    })

    on('tool', (payload) => {
      const name = typeof payload.name === 'string' ? payload.name : 'tool'
      setState((prev) => ({
        ...prev,
        tools: [
          ...prev.tools,
          {
            name,
            eventType: typeof payload.event_type === 'string' ? payload.event_type : undefined,
            preview: typeof payload.preview === 'string' ? payload.preview : undefined,
            complete: false,
          },
        ],
      }))
    })

    on('tool_complete', (payload) => {
      const name = typeof payload.name === 'string' ? payload.name : 'tool'
      setState((prev) => {
        const idx = [...prev.tools].reverse().findIndex((t) => t.name === name && !t.complete)
        if (idx === -1) {
          return {
            ...prev,
            tools: [
              ...prev.tools,
              {
                name,
                eventType: typeof payload.event_type === 'string' ? payload.event_type : undefined,
                preview: typeof payload.preview === 'string' ? payload.preview : undefined,
                isError: payload.is_error === true,
                complete: true,
              },
            ],
          }
        }
        const realIdx = prev.tools.length - 1 - idx
        const tools = [...prev.tools]
        tools[realIdx] = {
          ...tools[realIdx],
          preview: typeof payload.preview === 'string' ? payload.preview : tools[realIdx].preview,
          isError: payload.is_error === true,
          complete: true,
        }
        return { ...prev, tools }
      })
    })

    on('done', (payload) => {
      // Content is final, but the CONNECTION stays open — only stream_end
      // (or cancel/apperror) closes it. Do not touch the EventSource here.
      contentFinalRef.current = true
      setState((prev) => ({
        ...prev,
        terminal: prev.terminal === 'streaming' ? 'done' : prev.terminal,
        errorMessage:
          typeof payload.terminal_reason === 'string' && payload.terminal_state !== 'ok'
            ? payload.terminal_reason
            : prev.errorMessage,
      }))
    })

    on('stream_end', () => {
      setState((prev) => ({
        ...prev,
        terminal: prev.terminal === 'streaming' ? 'done' : prev.terminal,
        connectionClosed: true,
      }))
      source.close()
    })

    on('cancel', () => {
      setState((prev) => ({ ...prev, terminal: 'cancelled', connectionClosed: true }))
      source.close()
    })

    on('apperror', (payload) => {
      const message = typeof payload.message === 'string' ? payload.message : 'The agent hit an error.'
      setState((prev) => ({ ...prev, terminal: 'error', errorMessage: message, connectionClosed: true }))
      source.close()
    })

    on('warning', () => {
      /* non-fatal; surfaced via tool/approval UI already covers the common cases */
    })

    on('approval', (payload) => {
      setState((prev) => ({
        ...prev,
        approval: {
          approvalId: typeof payload.approval_id === 'string' ? payload.approval_id : undefined,
          description: typeof payload.description === 'string' ? payload.description : undefined,
          command: typeof payload.command === 'string' ? payload.command : undefined,
          pendingCount: typeof payload.pending_count === 'number' ? payload.pending_count : undefined,
          sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
        },
      }))
    })

    on('clarify', (payload) => {
      setState((prev) => ({
        ...prev,
        clarify: {
          clarifyId: typeof payload.clarify_id === 'string' ? payload.clarify_id : '',
          question: typeof payload.question === 'string' ? payload.question : '',
          choicesOffered: Array.isArray(payload.choices_offered)
            ? (payload.choices_offered as string[])
            : [],
          sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
          expiresAt: typeof payload.expires_at === 'number' ? payload.expires_at : undefined,
        },
      }))
    })

    source.onerror = () => {
      // TODO(stream-replay): reconnect with `&replay=1&after_seq=N&after_event_id=...`
      // per the wire contract instead of abandoning the turn outright. Until
      // that lands, keep whatever text already accumulated (never reset it —
      // that would be silent data loss) and surface a retryable error.
      setState((prev) =>
        contentFinalRef.current
          ? { ...prev, connectionClosed: true }
          : prev.terminal === 'streaming'
            ? { ...prev, terminal: 'error', errorMessage: 'Connection lost.', connectionClosed: true, canRetry: true }
            : prev,
      )
      source.close()
    }

    return () => {
      source.close()
    }
  }, [workspaceId, agent, sessionId, streamId])

  return {
    ...state,
    clearApproval: () => setState((prev) => ({ ...prev, approval: null })),
    clearClarify: () => setState((prev) => ({ ...prev, clarify: null })),
  }
}

