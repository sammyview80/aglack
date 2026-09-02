import { describe, expect, it } from 'vitest'
import { queryKeys } from '@/lib/query-keys'

describe('queryKeys.agentHistory', () => {
  it('gives different agents in the same workspace different session keys', () => {
    const a = queryKeys.agentHistory.sessions('ws-1', 'agent-a')
    const b = queryKeys.agentHistory.sessions('ws-1', 'agent-b')
    expect(a).not.toEqual(b)
  })

  it('gives the same agent name in different workspaces different session keys', () => {
    const a = queryKeys.agentHistory.sessions('ws-1', 'agent-a')
    const b = queryKeys.agentHistory.sessions('ws-2', 'agent-a')
    expect(a).not.toEqual(b)
  })

  it('gives different sessions of the same agent different message keys', () => {
    const a = queryKeys.agentHistory.messages('ws-1', 'agent-a', 'sess-1')
    const b = queryKeys.agentHistory.messages('ws-1', 'agent-a', 'sess-2')
    expect(a).not.toEqual(b)
  })

  it('nests the hierarchy so a workspace-scoped prefix matches its own session key', () => {
    const sessionsKey = queryKeys.agentHistory.sessions('ws-1', 'agent-a')
    const rootKey: readonly unknown[] = [...queryKeys.agentHistory.all, 'ws-1']
    expect(sessionsKey.slice(0, rootKey.length)).toEqual(rootKey)
  })

  it('nests the hierarchy so the all-root prefix matches every leaf key', () => {
    const messagesKey = queryKeys.agentHistory.messages('ws-1', 'agent-a', 'sess-1')
    expect(messagesKey.slice(0, queryKeys.agentHistory.all.length)).toEqual(queryKeys.agentHistory.all)
  })
})

describe('queryKeys.chat', () => {
  it('gives different sessions of the same agent different sessionStatus keys', () => {
    const a = queryKeys.chat.sessionStatus('ws-1', 'agent-a', 'sess-1')
    const b = queryKeys.chat.sessionStatus('ws-1', 'agent-a', 'sess-2')
    expect(a).not.toEqual(b)
  })

  it('gives different agents in the same workspace different sessionStatus keys', () => {
    const a = queryKeys.chat.sessionStatus('ws-1', 'agent-a', 'sess-1')
    const b = queryKeys.chat.sessionStatus('ws-1', 'agent-b', 'sess-1')
    expect(a).not.toEqual(b)
  })
})

describe('queryKeys.workspaces', () => {
  it('nests list() under the all root', () => {
    expect(queryKeys.workspaces.list().slice(0, queryKeys.workspaces.all.length)).toEqual(
      queryKeys.workspaces.all,
    )
  })
})
