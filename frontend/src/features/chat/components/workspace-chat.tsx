import { useEffect, useReducer } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDown, RefreshCw, SquarePen } from 'lucide-react'
import { ThreadsShell } from '@/components/threads-shell'
import { Skeleton } from '@/components/ui/skeleton'
import { AgentAvatar } from '@/features/chat/components/agent-avatar'
import { chatUi } from '@/features/chat/chat-ui'
import { threadsUi } from '@/components/threads-ui'
import { Hint } from '@/components/ui/tooltip'
import { AGENT_STATUS_WORDS, AnimatedPanel, CyclingWords, PulseDot, motionPresets } from '@/components/motion'
import { cn } from '@/lib/utils'
import { useAgents } from '@/features/agent-history/hooks/use-agent-history'
import { useChat } from '@/features/chat/hooks/use-chat'
import {
  readSelectedChatSessionId,
  writeSelectedChatSessionId,
} from '@/features/chat/chat-session-store'
import { ChatMessageList } from '@/features/chat/components/chat-message-list'
import { ChatTranscriptSkeleton } from '@/features/chat/components/chat-transcript-skeleton'
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
 * Which agent is active is in the URL as `?agent=<name>` only.
 * Each agent's selected session id lives in tab `sessionStorage` under
 * its own key (`hermano.chat.selected.<workspace>.<agent>`). On agent
 * click we read THAT agent's slot synchronously — never reuse another
 * agent's session. Stored session → load messages + reconnect stream.
 * No stored session → new-chat empty state until first send or history pick.
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
  const [, bumpSessionStore] = useReducer((n: number) => n + 1, 0)
  // Read synchronously from the CURRENT agent's sessionStorage slot every
  // render — never hold a stale session id across agent switches.
  const selectedSessionId = agent ? readSelectedChatSessionId(workspaceId, agent) : null
  const pendingInputFocus = usePendingInputFocus()

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
      return next
    })
  }

  /** Replaces this agent's sessionStorage slot, then binds chat the same
   * way as clicking the agent when that slot already had a value. */
  function selectSession(agentName: string, session: AgentSession) {
    writeSelectedChatSessionId(workspaceId, agentName, session.sessionId)
    bumpSessionStore()
    if (agentName !== agent) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('agent', agentName)
        return next
      })
    }
  }

  const chat = useChat(workspaceId, agent, {
    sessionId: selectedSessionId,
    onSessionIdChange: bumpSessionStore,
  })
  const pendingInput = selectPendingInput(chat.approval, chat.clarify)
  const transcriptScroll = useChatTranscriptScroll({
    turnCount: chat.turns.length,
    isStreaming: chat.isStreaming,
    streamingText: chat.assistantText,
    reasoningText: chat.reasoningText,
    toolCount: chat.tools.length,
    agent,
    sessionId: selectedSessionId,
    isLoadingTranscript: chat.isLoadingTranscript,
  })

  function newChat() {
    chat.newChat()
    bumpSessionStore()
  }

  const transcriptKey = `${agent ?? ''}:${selectedSessionId ?? 'new'}`

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
                  <AnimatedPanel swapKey={agent} animation={motionPresets.contentSwap} className="relative shrink-0">
                    <AgentAvatar agent={agent} size="md" />
                    {chat.isStreaming ? (
                      <PulseDot className={chatUi.activeDotMd} label="Agent is responding" />
                    ) : null}
                  </AnimatedPanel>
                  <AnimatedPanel swapKey={agent} animation={motionPresets.contentSwap} className={chatUi.headerIdentity}>
                    <strong className={chatUi.headerName}>{agent}</strong>
                    <span className={chatUi.headerMeta}>
                      {chat.isStreaming ? (
                        <CyclingWords words={AGENT_STATUS_WORDS} className="text-xs not-italic" />
                      ) : chat.isLoadingTranscript ? (
                        'Loading…'
                      ) : chat.turns.length > 0 ? (
                        `${chat.turns.length} message${chat.turns.length === 1 ? '' : 's'}`
                      ) : (
                        'New conversation'
                      )}
                    </span>
                  </AnimatedPanel>
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
                      disabled={!selectedSessionId || chat.isStreaming || chat.isReloadingMessages}
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
                  <AnimatedPanel swapKey={transcriptKey} className={chatUi.transcriptInner}>
                    {chat.isLoadingTranscript ? (
                      <ChatTranscriptSkeleton />
                    ) : (
                      <>
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
                      </>
                    )}
                  </AnimatedPanel>
                </div>
                {pendingInput ? (
                  <AnimatedPanel swapKey={pendingInput.kind} animation={motionPresets.panelEnter}>
                    <PendingInputPanel
                      pendingInput={pendingInput}
                      focusRef={pendingInputFocus.ref}
                      onRespondApproval={chat.respondApproval}
                      onRespondClarify={chat.respondClarify}
                    />
                  </AnimatedPanel>
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
