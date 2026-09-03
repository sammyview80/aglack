import type { RefObject } from 'react'
import { ChatPromptCard } from '@/features/chat/components/chat-prompt-card'
import { chatUi } from '@/features/chat/chat-ui'
import { cn } from '@/lib/utils'
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
  panelRef,
}: {
  prompt: ApprovalPromptType
  onRespond: (choice: ApprovalChoice, approvalId?: string) => void
  panelRef?: RefObject<HTMLDivElement | null>
}) {
  return (
    <ChatPromptCard
      ref={panelRef}
      title="Approval requested"
      description={prompt.description}
      role="region"
      ariaLabel="Approval requested"
      ariaLive="polite"
      tabIndex={panelRef ? -1 : undefined}
      footer={
        <div className={chatUi.promptChoices}>
          {CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className={cn(
                choice.value === 'deny' ? chatUi.promptDeny : chatUi.promptApprove,
              )}
              onClick={() => onRespond(choice.value, prompt.approvalId)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      }
    >
      {prompt.command ? <pre className={chatUi.promptCommand}>{prompt.command}</pre> : null}
    </ChatPromptCard>
  )
}
