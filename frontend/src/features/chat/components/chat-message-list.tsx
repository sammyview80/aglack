import { AgentAvatar } from '@/features/chat/components/agent-avatar'
import { ChatEmptyState } from '@/features/chat/components/chat-empty-state'
import { MarkdownContent } from '@/features/chat/components/markdown-content'
import { ThinkingCard } from '@/features/chat/components/thinking-card'
import { ToolActivityList, ToolActivitySummary } from '@/features/chat/components/tool-activity'
import { chatUi } from '@/features/chat/chat-ui'
import type { ChatTurn } from '@/features/chat/hooks/use-chat'
import type { ToolActivity } from '@/features/chat/types'
import { AGENT_STATUS_WORDS, CyclingWords, PulseDot, TypingIndicator } from '@/components/motion'
import { cn } from '@/lib/utils'

function messageTimestamp(at: number): number {
  if (!Number.isFinite(at) || at <= 0) return Date.now()
  return at < 1_000_000_000_000 ? at * 1000 : at
}

function formatMessageTime(at: number): string {
  return new Date(messageTimestamp(at)).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function ChatMessageList({
  agent,
  turns,
  isStreaming,
  streamingText,
  reasoningText,
  tools,
  onSuggest,
}: {
  agent: string
  turns: ChatTurn[]
  isStreaming: boolean
  streamingText: string
  reasoningText: string
  tools: ToolActivity[]
  onSuggest?: (text: string) => void
}) {
  const isEmpty = turns.length === 0 && !isStreaming

  return (
    <div
      className={cn(chatUi.messageList, isEmpty && chatUi.messageListEmpty)}
    >
      {isEmpty ? <ChatEmptyState agent={agent} onSuggest={onSuggest} /> : null}
      {turns.map((turn) => {
        const isUser = turn.role === 'user'

        return (
          <div className={cn('flex w-full max-w-full', isUser ? 'justify-end' : 'justify-start')} key={turn.id}>
            <div className={cn(chatUi.messageBlock, isUser && chatUi.messageBlockUser)}>
              <div className={chatUi.messageRow}>
                {!isUser ? <AgentAvatar agent={agent} size="sm" /> : null}
                <div className={chatUi.messageContent}>
                  {!isUser && turn.reasoning ? <ThinkingCard reasoning={turn.reasoning} /> : null}
                  {!isUser && turn.tools && turn.tools.length > 0 ? (
                    <ToolActivitySummary tools={turn.tools} />
                  ) : null}
                  <div
                    data-bubble-tone={turn.errored ? 'error' : isUser ? 'outgoing' : 'incoming'}
                    className={cn(
                      chatUi.bubbleBase,
                      turn.errored
                        ? chatUi.bubbleError
                        : isUser
                          ? chatUi.bubbleOutgoing
                          : chatUi.bubbleIncoming,
                    )}
                  >
                    <MarkdownContent
                      text={turn.text}
                      tone={turn.errored ? 'error' : isUser ? 'outgoing' : 'incoming'}
                    />
                  </div>
                </div>
                {isUser ? <AgentAvatar agent="you" size="sm" /> : null}
              </div>
              <time
                className={cn(
                  chatUi.messageTime,
                  isUser ? chatUi.messageTimeUser : chatUi.messageTimeAssistant,
                )}
                dateTime={String(messageTimestamp(turn.at))}
              >
                {formatMessageTime(turn.at)}
              </time>
            </div>
          </div>
        )
      })}
      {isStreaming ? (
        <div className="flex w-full justify-start">
          <div className={chatUi.messageBlock}>
            <div className={chatUi.messageRow}>
              <div className="relative shrink-0">
                <AgentAvatar agent={agent} size="sm" />
                <PulseDot size="sm" className={chatUi.activeDotSm} label="Agent is responding" />
              </div>
              <div className={chatUi.messageContent}>
                {reasoningText ? (
                  <p className="my-1 text-sm italic text-[var(--th-muted)]">{reasoningText}</p>
                ) : null}
                <ToolActivityList tools={tools} />
                <div className={cn(chatUi.bubbleBase, chatUi.bubbleIncoming, chatUi.bubbleStreaming)}>
                  {streamingText ? (
                    <MarkdownContent text={streamingText} tone="incoming" />
                  ) : (
                    <TypingIndicator className="text-[var(--th-muted)]" />
                  )}
                </div>
              </div>
            </div>
            <span
              className={cn(chatUi.messageTime, chatUi.messageTimeAssistant, 'inline-flex items-baseline')}
            >
              <CyclingWords words={AGENT_STATUS_WORDS} className="text-[11px]" />
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
