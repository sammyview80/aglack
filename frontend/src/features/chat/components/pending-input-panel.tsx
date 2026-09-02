import type { RefObject } from 'react'
import { ApprovalPrompt } from '@/features/chat/components/approval-prompt'
import { ClarifyPrompt } from '@/features/chat/components/clarify-prompt'
import type { PendingInput } from '@/features/chat/components/pending-input'
import type { PendingInputFocusTarget } from '@/features/chat/components/use-pending-input-focus'
import type { ApprovalChoice } from '@/features/chat/types'

export function PendingInputPanel({
  pendingInput,
  focusRef,
  onRespondApproval,
  onRespondClarify,
}: {
  pendingInput: PendingInput
  focusRef: RefObject<PendingInputFocusTarget | null>
  onRespondApproval: (choice: ApprovalChoice, approvalId?: string) => void
  onRespondClarify: (response: string, clarifyId?: string) => void
}) {
  if (pendingInput.kind === 'approval') {
    return (
      <ApprovalPrompt
        prompt={pendingInput.prompt}
        onRespond={onRespondApproval}
        panelRef={focusRef as RefObject<HTMLDivElement | null>}
      />
    )
  }

  return (
    <ClarifyPrompt
      prompt={pendingInput.prompt}
      onRespond={onRespondClarify}
      inputRef={focusRef as RefObject<HTMLInputElement | null>}
    />
  )
}
