import { afterEach, describe, expect, it } from 'vitest'
import {
  readSelectedModels,
  toggleSelectedModel,
  writeSelectedModels,
} from '@/features/models/selected-models-store'
import type { SelectedModel } from '@/features/models/types'

const MODEL_A: SelectedModel = { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai' }
const MODEL_B: SelectedModel = { id: 'claude-4', label: 'Claude 4', provider: 'anthropic' }

afterEach(() => {
  window.localStorage.clear()
})

describe('selected-models-store persistence', () => {
  it('returns an empty list when nothing has been stored yet', () => {
    expect(readSelectedModels('ws-1', 'agent-a')).toEqual([])
  })

  it('persists a written list and reads it back', () => {
    writeSelectedModels('ws-1', 'agent-a', [MODEL_A, MODEL_B])
    expect(readSelectedModels('ws-1', 'agent-a')).toEqual([MODEL_A, MODEL_B])
  })

  it('survives a simulated reload (fresh read from the same localStorage key)', () => {
    writeSelectedModels('ws-1', 'agent-a', [MODEL_A])
    // Simulate a reload by reading through the public API again with no
    // in-memory state carried over — the store's only state is
    // localStorage itself.
    const reread = readSelectedModels('ws-1', 'agent-a')
    expect(reread).toEqual([MODEL_A])
  })

  it('ignores malformed JSON instead of throwing', () => {
    window.localStorage.setItem('hermano.models.selected.ws-1.agent-a', '{not json')
    expect(readSelectedModels('ws-1', 'agent-a')).toEqual([])
  })

  it('filters out malformed entries in an otherwise valid array', () => {
    window.localStorage.setItem(
      'hermano.models.selected.ws-1.agent-a',
      JSON.stringify([MODEL_A, { id: 'missing-fields' }, null, 'not-an-object']),
    )
    expect(readSelectedModels('ws-1', 'agent-a')).toEqual([MODEL_A])
  })
})

describe('selected-models-store toggle', () => {
  it('adds a model on first toggle', () => {
    const result = toggleSelectedModel('ws-1', 'agent-a', MODEL_A)
    expect(result).toEqual([MODEL_A])
    expect(readSelectedModels('ws-1', 'agent-a')).toEqual([MODEL_A])
  })

  it('removes a model on second toggle (tick then untick)', () => {
    toggleSelectedModel('ws-1', 'agent-a', MODEL_A)
    const result = toggleSelectedModel('ws-1', 'agent-a', MODEL_A)
    expect(result).toEqual([])
    expect(readSelectedModels('ws-1', 'agent-a')).toEqual([])
  })

  it('treats the same model id under different providers as distinct entries', () => {
    const sameIdDifferentProvider: SelectedModel = { id: 'gpt-4o', label: 'GPT-4o', provider: 'custom' }
    toggleSelectedModel('ws-1', 'agent-a', MODEL_A)
    const result = toggleSelectedModel('ws-1', 'agent-a', sameIdDifferentProvider)
    expect(result).toEqual([MODEL_A, sameIdDifferentProvider])
  })

  it('preserves other selections when toggling one model off', () => {
    toggleSelectedModel('ws-1', 'agent-a', MODEL_A)
    toggleSelectedModel('ws-1', 'agent-a', MODEL_B)
    const result = toggleSelectedModel('ws-1', 'agent-a', MODEL_A)
    expect(result).toEqual([MODEL_B])
  })
})

describe('selected-models-store per-workspace + per-agent isolation', () => {
  it('never leaks one agent selections into another agent in the same workspace', () => {
    writeSelectedModels('ws-1', 'agent-a', [MODEL_A])
    writeSelectedModels('ws-1', 'agent-b', [MODEL_B])

    expect(readSelectedModels('ws-1', 'agent-a')).toEqual([MODEL_A])
    expect(readSelectedModels('ws-1', 'agent-b')).toEqual([MODEL_B])
  })

  it('toggling for one agent does not affect a sibling agent slot', () => {
    writeSelectedModels('ws-1', 'agent-a', [MODEL_A])
    writeSelectedModels('ws-1', 'agent-b', [MODEL_A])

    toggleSelectedModel('ws-1', 'agent-a', MODEL_A) // untick for agent-a only

    expect(readSelectedModels('ws-1', 'agent-a')).toEqual([])
    expect(readSelectedModels('ws-1', 'agent-b')).toEqual([MODEL_A])
  })

  it('never leaks the same agent name across different workspaces', () => {
    writeSelectedModels('ws-1', 'agent-a', [MODEL_A])
    writeSelectedModels('ws-2', 'agent-a', [MODEL_B])

    expect(readSelectedModels('ws-1', 'agent-a')).toEqual([MODEL_A])
    expect(readSelectedModels('ws-2', 'agent-a')).toEqual([MODEL_B])
  })
})
