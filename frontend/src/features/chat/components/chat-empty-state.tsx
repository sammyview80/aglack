import { AgentAvatar } from '@/features/chat/components/agent-avatar'
import { chatUi } from '@/features/chat/chat-ui'

const STARTER_PROMPTS = [
  'What can you help me with?',
  'Give me a quick status update',
  'What should we tackle first?',
] as const

export function ChatEmptyState({
  agent,
  onSuggest,
}: {
  agent: string
  onSuggest?: (text: string) => void
}) {
  return (
    <div className={chatUi.emptyState} role="status">
      <div className="mb-3.5">
        <AgentAvatar agent={agent} size="lg" />
      </div>
      <h2 className={chatUi.emptyTitle}>{agent}</h2>
      <p className={chatUi.emptySubtitle}>
        Start a new conversation. Ask a question or pick a prompt below.
      </p>
      {onSuggest ? (
        <div className={chatUi.emptyStarters}>
          {STARTER_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className={chatUi.emptyStarter}
              onClick={() => onSuggest(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
