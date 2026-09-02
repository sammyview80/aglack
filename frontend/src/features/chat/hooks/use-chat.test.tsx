import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChat } from '@/features/chat/hooks/use-chat'
import * as api from '@/features/chat/api'

vi.mock('@/features/chat/api', async () => {
  const actual = await vi.importActual<typeof api>('@/features/chat/api')
  return {
    ...actual,
    createSession: vi.fn(),
    startTurn: vi.fn(),
    cancelTurn: vi.fn(),
    chatStreamUrl: vi.fn(() => 'http://gateway.test/stream'),
  }
})

const mockedApi = vi.mocked(api)

class MockEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.stubGlobal('EventSource', MockEventSource)
  mockedApi.cancelTurn.mockResolvedValue({ ok: true, cancelled: true, streamId: 'irrelevant' })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('useChat agent-switch race', () => {
  it('discards a stale startTurn result that resolves after the agent changed', async () => {
    mockedApi.createSession
      .mockResolvedValueOnce({ sessionId: 'session-a' })
      .mockResolvedValueOnce({ sessionId: 'session-b' })

    const pendingStartTurn = deferred<Awaited<ReturnType<typeof api.startTurn>>>()
    mockedApi.startTurn.mockReturnValueOnce(pendingStartTurn.promise)

    const { result, rerender } = renderHook(({ agent }) => useChat('ws-1', agent), {
      wrapper,
      initialProps: { agent: 'agent-a' as string | null },
    })

    await waitFor(() => expect(mockedApi.createSession).toHaveBeenCalledWith('ws-1', 'agent-a'))

    await act(async () => {
      void result.current.send('hello from A')
    })

    // Switch agents before startTurn (issued for agent-a) resolves.
    rerender({ agent: 'agent-b' })
    await waitFor(() => expect(mockedApi.createSession).toHaveBeenCalledWith('ws-1', 'agent-b'))

    await act(async () => {
      pendingStartTurn.resolve({
        streamId: 'stream-for-a',
        sessionId: 'session-a',
        pendingStartedAt: 0,
        turnId: null,
        title: 'title',
      })
      await pendingStartTurn.promise
    })

    // The stale stream id must never bind to the now-current agent's chat.
    expect(result.current.isStreaming).toBe(false)
    // And it must not leave the UI stuck in a sending state.
    expect(result.current.isSending).toBe(false)
    // The abandoned backend turn is cleaned up rather than left dangling.
    expect(mockedApi.cancelTurn).toHaveBeenCalledWith('ws-1', 'agent-a', 'stream-for-a')
  })

  it('flips isSending back to false once a normal (non-switched) send starts streaming', async () => {
    mockedApi.createSession.mockResolvedValueOnce({ sessionId: 'session-a' })
    mockedApi.startTurn.mockResolvedValueOnce({
      streamId: 'stream-1',
      sessionId: 'session-a',
      pendingStartedAt: 0,
      turnId: null,
      title: 'title',
    })

    const { result } = renderHook(({ agent }) => useChat('ws-1', agent), {
      wrapper,
      initialProps: { agent: 'agent-a' as string | null },
    })

    await waitFor(() => expect(mockedApi.createSession).toHaveBeenCalledWith('ws-1', 'agent-a'))

    await act(async () => {
      await result.current.send('hello')
    })

    expect(result.current.isSending).toBe(false)
    expect(result.current.isStreaming).toBe(true)
  })
})
