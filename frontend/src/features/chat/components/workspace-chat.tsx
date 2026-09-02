import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDown, RefreshCw, SquarePen } from 'lucide-react'
import { ThreadsShell } from '@/components/threads-shell'
import { Skeleton } from '@/components/ui/skeleton'
import { AgentAvatar } from '@/features/chat/components/agent-avatar'
import { chatUi } from '@/features/chat/chat-ui'
import { threadsUi } from '@/components/threads-ui'
import { Hint } from '@/components/ui/tooltip'
import { AGENT_STATUS_WORDS, CyclingWords, PulseDot, motionPresets } from '@/components/motion'
import { cn } from '@/lib/utils'
import { useAgents } from '@/features/agent-history/hooks/use-agent-history'
import { useChat } from '@/features/chat/hooks/use-chat'
import { ChatMessageList } from '@/features/chat/components/chat-message-list'
import { ChatComposer } from '@/features/chat/components/chat-composer'
import { PendingInputPanel } from '@/features/chat/components/pending-input-panel'
import { selectPendingInput } from '@/features/chat/components/pending-input'
import { usePendingInputFocus } from '@/features/chat/components/use-pending-input-focus'
import { useChatTranscriptScroll } from '@/features/chat/components/use-chat-transcript-scroll'
import type { AgentSession } from '@/features/agent-history/types'

type WorkspaceChatProps = {
  workspaceId: string
  workspaceName: string
}

/**
 * Real streaming chat, per agent (Hermes profile). Each agent gets its own
 * session and SSE stream — `useChat` threads `agent` through every gateway
 * call as `?agent=<name>`, never a hidden global.
 *
 * Which agent + session is active is reflected in the URL as
 * `?agent=<name>&session=<id>` (see `useSearchParams` below), so a reload
 * lands back on the exact same conversation instead of silently falling
 * back to the first agent's default session. This URL is the SINGLE
 * source of truth for "which agent is this chat showing" — both of
 * ThreadsShell's own agent-selection surfaces (the CHAT sidebar list AND
 * the AUDIENCE panel) are wired as CONTROLLED views of this same state
 * (`selectedAgent`/`onSelectAgent`, `onSelectSession`), not independent
 * selections of their own. Clicking an agent in either the sidebar or
 * AUDIENCE, or a session in AUDIENCE, all funnel through the same
 * `selectAgent`/`selectSession` functions below and update the same URL.
 *
 * This screen itself has NO agent picker of its own anymore — the
 * sidebar/AUDIENCE ARE the picker, and duplicating that choice here
 * (a second dropdown showing the same selection) was redundant UI, not a
 * second real control. The header instead shows the agent identity
 * plainly (avatar + name, not clickable) and a "New chat" action —
 * genuinely new, not a duplicate of agent selection.
 */
export function WorkspaceChat({ workspaceId, workspaceName }: WorkspaceChatProps) {
  const agentsQuery = useAgents(workspaceId, true)
  const agents = agentsQuery.data?.agents ?? []
  const [searchParams, setSearchParams] = useSearchParams()
  const agent = searchParams.get('agent')
  const sessionId = searchParams.get('session')
  const pendingInputFocus = usePendingInputFocus()

  // Default to the first real agent only once the list loads AND the URL
  // doesn't already name one — never override an explicit `?agent=` (e.g.
  // from a reload or a shared link) with the list's own ordering.
  useEffect(() => {
    if (!agent && agents.length > 0) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('agent', agents[0].name)
        return next
      }, { replace: true })
    }
  }, [agent, agents, setSearchParams])

  function selectAgent(name: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('agent', name)
      // Switching agents leaves the old agent's session behind — a
      // different agent's session id is meaningless once bound here.
      next.delete('session')
      return next
    })
  }

  /** Wired to ThreadsShell's `onSelectSession` (-> AgentHistoryPanel).
   * Clicking a session in AUDIENCE both switches this chat pane to that
   * exact agent+session AND updates the URL to match — the two were
   * previously disconnected: clicking a session only changed the panel's
   * own separate read-only viewer, never the real, sendable chat. */
  function selectSession(agentName: string, session: AgentSession) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('agent', agentName)
      next.set('session', session.sessionId)
      return next
    })
  }

  const chat = useChat(workspaceId, agent, { sessionId })
  const pendingInput = selectPendingInput(chat.approval, chat.clarify)
  const transcriptScroll = useChatTranscriptScroll({
    turnCount: chat.turns.length,
    isStreaming: chat.isStreaming,
    streamingText: chat.assistantText,
    reasoningText: chat.reasoningText,
    toolCount: chat.tools.length,
    agent,
    sessionId,
  })

  /** Starts a genuinely new, separate session for the CURRENT agent —
   * clears this hook's own persisted/cached session state (`chat.newChat`)
   * AND this component's own `?session=` URL param together, since
   * `useChat` binds an explicit `options.sessionId` at higher priority
   * than anything it clears internally (see `useChat`'s own doc comment
   * on `newChat`) — clearing only one half would leave the chat still
   * bound to the old session. The old session itself is not deleted; it
   * remains fully visible via AUDIENCE, just no longer the active one. */
  function newChat() {
    chat.newChat()
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('session')
      return next
    })
  }

  return (
    <ThreadsShell
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      title="Thread"
      onSelectSession={selectSession}
      selectedAgent={agent}
      onSelectAgent={selectAgent}
    >
      <div className={chatUi.threadScroll}>
        <article className={chatUi.threadCard}>
          <div className={chatUi.threadMain}>
            <div className={chatUi.headerRow}>
              {agent ? (
                <>
                  <div className="relative shrink-0">
                    <AgentAvatar agent={agent} size="md" />
                    {chat.isStreaming ? (
                      <PulseDot className={chatUi.activeDotMd} label="Agent is responding" />
                    ) : null}
                  </div>
                  <div className={chatUi.headerIdentity}>
                    <strong className={chatUi.headerName}>{agent}</strong>
                    <span className={chatUi.headerMeta}>
                      {chat.isStreaming ? (
                        <CyclingWords words={AGENT_STATUS_WORDS} className="text-xs not-italic" />
                      ) : chat.turns.length > 0 ? (
                        `${chat.turns.length} message${chat.turns.length === 1 ? '' : 's'}`
                      ) : (
                        'New conversation'
                      )}
                    </span>
                  </div>
                </>
              ) : (
                <span className={chatUi.headerMeta}>Chat</span>
              )}
              {agent ? (
                <div className={chatUi.headerActions}>
                  <Hint label="Reload messages" side="top">
                    <button
                      type="button"
                      className={chatUi.headerButton}
                      onClick={chat.reloadMessages}
                      disabled={chat.isStreaming || chat.isReloadingMessages}
                      aria-label="Reload messages"
                    >
                      <RefreshCw
                        size={16}
                        className={cn(chat.isReloadingMessages && motionPresets.spin)}
                      />
                    </button>
                  </Hint>
                  <Hint label="New chat" side="top">
                    <button
                      type="button"
                      className={cn(chatUi.headerButton, 'px-3')}
                      onClick={newChat}
                      disabled={chat.isStreaming}
                      aria-label="Start a new chat"
                    >
                      <SquarePen size={16} />
                      New chat
                    </button>
                  </Hint>
                </div>
              ) : null}
            </div>
            <div className={chatUi.divider} />

            {agentsQuery.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : agents.length === 0 ? (
              <p className={threadsUi.emptySearch}>No agents are set up for this workspace yet.</p>
            ) : chat.sessionError ? (
              <p className={chatUi.errorText}>{chat.sessionError}</p>
            ) : agent ? (
              <>
                <div className={chatUi.transcript} ref={transcriptScroll.ref}>
                  <div className={chatUi.transcriptInner}>
                    <ChatMessageList
                      agent={agent}
                      turns={chat.turns}
                      isStreaming={chat.isStreaming}
                      streamingText={chat.assistantText}
                      reasoningText={chat.reasoningText}
                      tools={chat.tools}
                      onSuggest={chat.send}
                    />
                    {pendingInput?.kind === 'clarify' ? (
                      <button
                        type="button"
                        className={chatUi.scrollFab}
                        onClick={pendingInputFocus.scrollToAndFocus}
                        aria-label="Scroll to required clarification input"
                      >
                        Answer required
                        <ArrowDown size={14} />
                      </button>
                    ) : transcriptScroll.showScrollButton ? (
                      <button
                        type="button"
                        className={chatUi.scrollFab}
                        onClick={() => transcriptScroll.scrollToBottom('smooth')}
                        aria-label="Scroll to latest messages"
                      >
                        Latest
                        <ArrowDown size={14} />
                      </button>
                    ) : null}
                  </div>
                </div>
                {pendingInput ? (
                  <PendingInputPanel
                    pendingInput={pendingInput}
                    focusRef={pendingInputFocus.ref}
                    onRespondApproval={chat.respondApproval}
                    onRespondClarify={chat.respondClarify}
                  />
                ) : null}
                {chat.canRetry ? (
                  <p className={chatUi.errorText}>
                    Connection lost.{' '}
                    <button type="button" className={chatUi.retryButton} onClick={chat.retry}>
                      Retry
                    </button>
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          {agent ? (
            <ChatComposer
              disabled={chat.isSending || !agent}
              isStreaming={chat.isStreaming}
              onSend={chat.send}
              onStop={chat.stop}
            />
          ) : null}
        </article>
      </div>
    </ThreadsShell>
  )
}
