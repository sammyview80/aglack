import { describe, expect, it } from 'vitest'
import { selectPendingInput } from '@/features/chat/components/pending-input'

describe('selectPendingInput', () => {
  it('returns null when neither approval nor clarify is set', () => {
    expect(selectPendingInput(null, null)).toBeNull()
  })

  it('returns clarify when only clarify is set', () => {
    const clarify = { clarifyId: 'c1', question: 'Q?', choicesOffered: [] }
    expect(selectPendingInput(null, clarify)).toEqual({ kind: 'clarify', prompt: clarify })
  })

  it('returns approval when only approval is set', () => {
    const approval = { approvalId: 'a1', description: 'Deploy', command: 'npm run deploy' }
    expect(selectPendingInput(approval, null)).toEqual({ kind: 'approval', prompt: approval })
  })

  it('prefers approval when both are set', () => {
    const approval = { approvalId: 'a1', description: 'Deploy', command: 'npm run deploy' }
    const clarify = { clarifyId: 'c1', question: 'Q?', choicesOffered: [] }
    expect(selectPendingInput(approval, clarify)).toEqual({ kind: 'approval', prompt: approval })
  })
})
