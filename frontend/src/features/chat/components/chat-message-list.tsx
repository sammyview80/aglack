import { PixelAvatar, avatarTone } from '@/components/threads-shell'
import { ToolActivityList } from '@/features/chat/components/tool-activity'
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
        <div className="comment" key={turn.id}>
          <PixelAvatar seed={turn.role === 'user' ? 'you' : agent} tone={avatarTone(turn.role === 'user' ? 'you' : agent)} />
          <div className="comment-content">
            <div className="comment-name">
              <strong>{turn.role === 'user' ? 'You' : agent}</strong>
              <span>·</span>
              <span>{timeAgo(turn.at)}</span>
            </div>
            <p className={turn.errored ? 'chat-message-error' : ''}>{turn.text}</p>
          </div>
        </div>
      ))}
      {isStreaming ? (
        <div className="comment">
          <PixelAvatar seed={agent} tone={avatarTone(agent)} />
          <div className="comment-content">
            <div className="comment-name">
              <strong>{agent}</strong>
              <span>·</span>
              <span>now</span>
            </div>
            {reasoningText ? <p className="chat-reasoning">{reasoningText}</p> : null}
            <ToolActivityList tools={tools} />
            <p>{streamingText || '…'}</p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
