import { memo } from 'react'
import { AgentAvatar } from '@/features/chat/components/agent-avatar'
import { ChatAttachmentList } from '@/features/chat/components/chat-attachments'
import { ChatEmptyState } from '@/features/chat/components/chat-empty-state'
import { MarkdownContent } from '@/features/chat/components/markdown-content'
import { ThinkingCard } from '@/features/chat/components/thinking-card'
import { ToolActivityList, ToolActivitySummary } from '@/features/chat/components/tool-activity'
import { chatUi } from '@/features/chat/chat-ui'
import type { ChatTurn } from '@/features/chat/hooks/use-chat'
import type { ToolActivity } from '@/features/chat/types'
import { PulseDot, TypingIndicator, motionPresets } from '@/components/motion'
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

const ChatTurnRow = memo(function ChatTurnRow({
  turn,
  index,
  agent,
  workspaceId,
  sessionId,
}: {
  turn: ChatTurn
  index: number
  agent: string
  workspaceId?: string
  sessionId?: string | null
}) {
  const isUser = turn.role === 'user'

  return (
    <div
      className={cn(
        'flex min-w-0 w-full max-w-full',
        isUser ? 'justify-end' : 'justify-start',
        motionPresets.messageEnter,
      )}
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <div className={cn(chatUi.messageBlock, isUser && chatUi.messageBlockUser)}>
        <div className={chatUi.messageRow}>
          {!isUser ? <AgentAvatar agent={agent} size="sm" /> : null}
          <div className={chatUi.messageContent}>
            {!isUser && turn.reasoning ? <ThinkingCard reasoning={turn.reasoning} /> : null}
            {!isUser && turn.tools && turn.tools.length > 0 ? (
              <ToolActivitySummary tools={turn.tools} />
            ) : null}
            {turn.attachments && turn.attachments.length > 0 ? (
              <ChatAttachmentList
                attachments={turn.attachments}
                workspaceId={workspaceId}
                agent={agent}
                sessionId={sessionId}
              />
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
                workspaceId={workspaceId}
                agent={agent}
                sessionId={sessionId}
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
})

export function ChatMessageList({
  agent,
  turns,
  isStreaming,
  streamingText,
  reasoningText,
  tools,
  onSuggest,
  workspaceId,
  sessionId,
}: {
  agent: string
  turns: ChatTurn[]
  isStreaming: boolean
  streamingText: string
  reasoningText: string
  tools: ToolActivity[]
  onSuggest?: (text: string) => void
  /**
   * Needed only to build a real image-thumbnail URL for a turn's
   * attachments (`ChatAttachmentList` -> `attachmentFileUrl`, see that
   * function's doc comment in `features/chat/api.ts`) — optional so
   * every existing test/call site that has no attachments to render
   * keeps working unchanged; a turn WITH attachments but no
   * `workspaceId`/`sessionId` still renders correctly, just as filename
   * chips instead of thumbnails (see `ChatAttachmentList`'s fallback).
   */
  workspaceId?: string
  sessionId?: string | null
}) {
  const isEmpty = turns.length === 0 && !isStreaming

  return (
    <div
      className={cn(chatUi.messageList, isEmpty && chatUi.messageListEmpty)}
    >
      {isEmpty ? (
        <div className={motionPresets.panelEnter}>
          <ChatEmptyState agent={agent} onSuggest={onSuggest} />
        </div>
      ) : null}
      {turns.map((turn, index) => (
        <ChatTurnRow
          key={turn.id}
          turn={turn}
          index={index}
          agent={agent}
          workspaceId={workspaceId}
          sessionId={sessionId}
        />
      ))}
      {isStreaming ? (
        <div className={cn('flex min-w-0 w-full max-w-full justify-start', motionPresets.messageEnter)}>
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
                    <MarkdownContent
                      text={streamingText}
                      tone="incoming"
                      workspaceId={workspaceId}
                      agent={agent}
                      sessionId={sessionId}
                    />
                  ) : (
                    <TypingIndicator className="text-[var(--th-muted)]" />
                  )}
                </div>
              </div>
            </div>
            
          </div>
        </div>
      ) : null}
    </div>
  )
}


