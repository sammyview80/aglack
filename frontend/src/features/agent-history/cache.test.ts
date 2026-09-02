import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { setAgentWorking, touchCachedSession } from '@/features/agent-history/cache'
import { queryKeys } from '@/lib/query-keys'

describe('agent-history cache patches', () => {
  it('skips setAgentWorking when isWorking already matches', () => {
    const client = new QueryClient()
    const key = queryKeys.agentHistory.agents('ws')
    const data = { agents: [{ name: 'a', isWorking: true }] }
    client.setQueryData(key, data)
    setAgentWorking(client, 'ws', 'a', true)
    expect(client.getQueryData(key)).toBe(data)
  })

  it('patches isWorking only for the named agent', () => {
    const client = new QueryClient()
    const key = queryKeys.agentHistory.agents('ws')
    client.setQueryData(key, {
      agents: [
        { name: 'a', isWorking: false },
        { name: 'b', isWorking: false },
      ],
    })
    setAgentWorking(client, 'ws', 'a', true)
    expect(client.getQueryData(key)).toEqual({
      agents: [
        { name: 'a', isWorking: true },
        { name: 'b', isWorking: false },
      ],
    })
  })

  it('skips touchCachedSession when the row is already first with the same title and count', () => {
    const client = new QueryClient()
    const key = queryKeys.agentHistory.sessions('ws', 'a')
    const data = {
      sessions: [{ sessionId: 's1', title: 'hi', messageCount: 2, updatedAt: 1, lastMessageAt: 1 }],
      limit: 50,
      offset: 0,
    }
    client.setQueryData(key, data)
    touchCachedSession(client, 'ws', 'a', 's1', { messageCountDelta: 0, at: 99 })
    expect(client.getQueryData(key)).toBe(data)
  })
})
