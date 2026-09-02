import type { ApprovalPrompt, ClarifyPrompt } from '@/features/chat/types'

export type PendingInput =
  | { kind: 'approval'; prompt: ApprovalPrompt }
  | { kind: 'clarify'; prompt: ClarifyPrompt }

/** One blocking input at a time; approval wins if both are set. */
export function selectPendingInput(
  approval: ApprovalPrompt | null,
  clarify: ClarifyPrompt | null,
): PendingInput | null {
  if (approval) return { kind: 'approval', prompt: approval }
  if (clarify) return { kind: 'clarify', prompt: clarify }
  return null
}
