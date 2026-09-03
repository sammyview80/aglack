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
import { readPendingModel, clearPendingModel } from '@/features/models/pending-model-store'
import type { AgentSession, ListAgentsResult } from '@/features/agent-history/types'

type WorkspaceChatProps = {
  workspaceId: string
  workspaceName: string
}

function selectDefaultAgentName(data: ListAgentsResult) {
  return data.agents[0]?.name ?? ''
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
  const agentsQuery = useAgents(workspaceId, true, selectDefaultAgentName)
  const defaultAgentName = agentsQuery.data ?? ''
  const [searchParams, setSearchParams] = useSearchParams()
  const agent = searchParams.get('agent')
  const [, bumpSessionStore] = useReducer((n: number) => n + 1, 0)
  // Read synchronously from the CURRENT agent's sessionStorage slot every
  // render — never hold a stale session id across agent switches.
  const selectedSessionId = agent ? readSelectedChatSessionId(workspaceId, agent) : null
  const pendingInputFocus = usePendingInputFocus()

  useEffect(() => {
    if (!agent && defaultAgentName) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('agent', defaultAgentName)
        return next
      }, { replace: true })
    }
  }, [agent, defaultAgentName, setSearchParams])

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

  // A model picked on the still-empty composer (no session yet — see
  // ModelPicker's own doc comment on this exact case) is written into
  // `pending-model-store.ts`'s shared module-level map by ModelPicker
  // (mounted inside ChatComposer, below). `useChat`'s `getPendingModel`
  // is a GETTER read at the exact moment `send()` creates a session —
  // reading `readPendingModel` directly here (not a `usePendingModel`
  // hook snapshot) is what actually honors that contract: a hook
  // snapshot captured at THIS component's last render would go stale the
  // instant ModelPicker (a sibling-ish, separately-rendering subtree)
  // writes a pick without WorkspaceChat itself re-rendering — exactly
  // the bug this getter indirection exists to avoid (see useChat's own
  // doc comment on `getPendingModel`). Reading the raw store function
  // instead guarantees this always sees ModelPicker's LATEST write.
  const chat = useChat(workspaceId, agent, {
    sessionId: selectedSessionId,
    onSessionIdChange: bumpSessionStore,
    getPendingModel: () => {
      if (!agent) return null
      const pending = readPendingModel(workspaceId, agent)
      return pending ? { model: pending.id, modelProvider: pending.provider } : null
    },
    onPendingModelConsumed: () => {
      if (agent) clearPendingModel(workspaceId, agent)
    },
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
    onNearTop: chat.loadOlderMessages,
    canLoadOlder: chat.hasOlderMessages,
    isLoadingOlder: chat.isLoadingOlderMessages,
  })

  function newChat() {
    chat.newChat()
    bumpSessionStore()
  }

  // A user's OWN send must always land at the bottom, unlike an incoming
  // stream update — `useChatTranscriptScroll`'s turnCount-driven autoscroll
  // (see its own effect) only scrolls when the viewport is ALREADY near the
  // bottom, deliberately, so it doesn't yank the view while someone reads
  // older history during a live response. But the user just typed and hit
  // send, so scrolled-up-reading-history no longer applies — force it here
  // instead of waiting on that near-bottom gate.
  function sendAndScroll(text: string, files?: File[]) {
    chat.send(text, files)
    // The new user turn hasn't committed to the DOM yet (state update is
    // async) — scrolling now would just land at the CURRENT bottom, one
    // message short. `requestAnimationFrame` waits for the commit + paint
    // that follows this render, so `scrollHeight` already includes the
    // just-sent message by the time this fires.
    requestAnimationFrame(() => transcriptScroll.scrollToBottom('smooth'))
  }

  const transcriptKey = `${agent ?? ''}:${selectedSessionId ?? 'new'}`

  return (
    <ThreadsShell
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      title="Thread"
      hideDock
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
            ) : !defaultAgentName ? (
              <p className={threadsUi.emptySearch}>No agents are set up for this workspace yet.</p>
            ) : chat.sessionError ? (
              <p className={chatUi.errorText}>{chat.sessionError}</p>
            ) : agent ? (
              <>
                <div className={chatUi.transcript} ref={transcriptScroll.ref}>
                  <AnimatedPanel
                    ref={transcriptScroll.contentRef}
                    swapKey={transcriptKey}
                    className={chatUi.transcriptInner}
                  >
                    {chat.isLoadingTranscript ? (
                      <ChatTranscriptSkeleton />
                    ) : (
                      <>
                        {chat.isLoadingOlderMessages ? (
                          <div className={chatUi.olderMessagesSpinner} aria-label="Loading older messages">
                            <RefreshCw size={14} className={motionPresets.spin} />
                          </div>
                        ) : null}
                        <ChatMessageList
                          agent={agent}
                          turns={chat.turns}
                          isStreaming={chat.isStreaming}
                          streamingText={chat.assistantText}
                          reasoningText={chat.reasoningText}
                          tools={chat.tools}
                          onSuggest={sendAndScroll}
                          workspaceId={workspaceId}
                          sessionId={chat.sessionId}
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
                  <AnimatedPanel
                    swapKey={pendingInput.kind}
                    animation={motionPresets.panelEnter}
                    className={chatUi.promptDock}
                  >
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
              workspaceId={workspaceId}
              agent={agent}
              sessionId={chat.sessionId}
              disabled={chat.isSending || chat.isUploadingAttachments || !agent}
              isStreaming={chat.isStreaming}
              onSend={sendAndScroll}
              onStop={chat.stop}
            />
          ) : null}
        </article>
      </div>
    </ThreadsShell>
  )
}
