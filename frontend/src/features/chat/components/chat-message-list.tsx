import { PixelAvatar, avatarTone } from '@/components/threads-shell'
import { RandomAvatar } from '@/components/random-avatar'
import { MarkdownContent } from '@/features/chat/components/markdown-content'
import { ThinkingCard } from '@/features/chat/components/thinking-card'
import { ToolActivityList, ToolActivitySummary } from '@/features/chat/components/tool-activity'
import type { ChatTurn } from '@/features/chat/hooks/use-chat'
import type { ToolActivity } from '@/features/chat/types'

function timeAgo(at: number): string {
  const mins = Math.max(1, Math.round((Date.now() - at) / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function ChatMessageList({
  agent,
  turns,
  isStreaming,
  streamingText,
  reasoningText,
  tools,
}: {
  agent: string
  turns: ChatTurn[]
  isStreaming: boolean
  streamingText: string
  reasoningText: string
  tools: ToolActivity[]
}) {
  return (
    <div className="comments-list chat-message-list">
      {turns.length === 0 && !isStreaming ? (
        <p className="empty-search">Say something to {agent} to start the conversation.</p>
      ) : null}
      {turns.map((turn) => (
        <div className={turn.role === 'user' ? 'comment comment-outgoing' : 'comment'} key={turn.id}>
          {turn.role === 'user' ? (
            <PixelAvatar seed="you" tone={avatarTone('you')} />
          ) : (
            // Same RandomAvatar + same seed (agent name) as every other
            // agent-identity avatar in the app (threads-shell.tsx's agent
            // sidebar, agent-history-panel.tsx) — a chat message bubble is
            // not a separate avatar system just because it renders inline.
            <RandomAvatar seed={agent} size={54} />
          )}
          <div className="comment-content">
            <div className="comment-name">
              <strong>{turn.role === 'user' ? 'You' : agent}</strong>
              <span>·</span>
              <span>{timeAgo(turn.at)}</span>
            </div>
            {turn.role === 'assistant' && turn.reasoning ? <ThinkingCard reasoning={turn.reasoning} /> : null}
            {turn.role === 'assistant' && turn.tools && turn.tools.length > 0 ? (
              <ToolActivitySummary tools={turn.tools} />
            ) : null}
            <div className={turn.errored ? 'chat-message-error' : undefined}>
              <MarkdownContent text={turn.text} />
            </div>
          </div>
        </div>
      ))}
      {isStreaming ? (
        <div className="comment">
          <RandomAvatar seed={agent} size={54} />
          <div className="comment-content">
            <div className="comment-name">
              <strong>{agent}</strong>
              <span>·</span>
              <span>now</span>
            </div>
            {reasoningText ? <p className="chat-reasoning">{reasoningText}</p> : null}
            <ToolActivityList tools={tools} />
            {streamingText ? <MarkdownContent text={streamingText} /> : <p>…</p>}
          </div>
        </div>
      ) : null}
    </div>
  )
}
