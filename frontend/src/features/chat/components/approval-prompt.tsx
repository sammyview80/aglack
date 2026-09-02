import type { ApprovalChoice, ApprovalPrompt as ApprovalPromptType } from '@/features/chat/types'

const CHOICES: { value: ApprovalChoice; label: string }[] = [
  { value: 'once', label: 'Approve once' },
  { value: 'session', label: 'Approve for session' },
  { value: 'always', label: 'Always approve' },
  { value: 'deny', label: 'Deny' },
]

export function ApprovalPrompt({
  prompt,
  onRespond,
}: {
  prompt: ApprovalPromptType
  onRespond: (choice: ApprovalChoice, approvalId?: string) => void
}) {
  return (
    <div className="chat-prompt chat-prompt-approval">
      <p className="chat-prompt-title">Approval requested</p>
      {prompt.description ? <p className="chat-prompt-description">{prompt.description}</p> : null}
      {prompt.command ? <pre className="chat-prompt-command">{prompt.command}</pre> : null}
      <div className="chat-prompt-actions">
        {CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={choice.value === 'deny' ? 'chat-prompt-deny' : 'chat-prompt-approve'}
            onClick={() => onRespond(choice.value, prompt.approvalId)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  )
}
