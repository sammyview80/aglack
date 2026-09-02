import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChat } from '@/features/chat/hooks/use-chat'
import * as api from '@/features/chat/api'
import * as agentHistoryApi from '@/features/agent-history/api'

vi.mock('@/features/chat/api', async () => {
  const actual = await vi.importActual<typeof api>('@/features/chat/api')
  return {
    ...actual,
    createSession: vi.fn(),
    startTurn: vi.fn(),
    cancelTurn: vi.fn(),
    getSessionStatus: vi.fn(),
    chatStreamUrl: vi.fn(() => 'http://gateway.test/stream'),
  }
})

vi.mock('@/features/agent-history/api', async () => {
  const actual = await vi.importActual<typeof agentHistoryApi>('@/features/agent-history/api')
  return {
    ...actual,
    listAgentMessages: vi.fn(),
  }
})

const mockedApi = vi.mocked(api)
const mockedAgentHistoryApi = vi.mocked(agentHistoryApi)

type Listener = (event: MessageEvent) => void

class MockEventSource {
  static instances: MockEventSource[] = []
  listeners = new Map<string, Set<Listener>>()

  constructor() {
    MockEventSource.instances.push(this)
  }

  addEventListener(name: string, handler: Listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name)!.add(handler)
  }

  removeEventListener(name: string, handler: Listener) {
    this.listeners.get(name)?.delete(handler)
  }

  close() {}

  emit(name: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent
    for (const handler of this.listeners.get(name) ?? []) handler(event)
  }
}

function latestSource() {
  return MockEventSource.instances[MockEventSource.instances.length - 1]
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
  MockEventSource.instances = []
  vi.stubGlobal('EventSource', MockEventSource)
  mockedApi.cancelTurn.mockResolvedValue({ ok: true, cancelled: true, streamId: 'irrelevant' })
  // No session-status/history data by default — most tests below exercise
  // a brand-new session with nothing to reconnect to or seed. Tests that
  // care about reconnect/seeding override these explicitly.
  mockedApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })
  mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({ messages: [], limit: 50, offset: 0, total: 0 })
  // This hook persists session ids to localStorage — clear it so no test
  // leaks a session id into a later, unrelated test via the same
  // workspaceId+agent key.
  window.localStorage.clear()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
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

describe('useChat reasoning/tool persistence', () => {
  it('snapshots reasoning and tool activity into the completed turn instead of discarding them', async () => {
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
      await result.current.send('what model are you using?')
    })

    const source = latestSource()
    act(() => source.emit('reasoning', { text: 'weighing which fact to lead with' }))
    act(() => source.emit('tool', { name: 'web_search', preview: 'searching docs' }))
    act(() => source.emit('tool_complete', { name: 'web_search' }))
    act(() => source.emit('token', { text: "I'm using **nvidia/nemotron**." }))
    act(() => source.emit('done', { terminal_state: 'ok' }))
    act(() => source.emit('stream_end', {}))

    await waitFor(() => expect(result.current.turns.at(-1)?.role).toBe('assistant'))
    const assistantTurn = result.current.turns.at(-1)!

    // The completed turn keeps its own reasoning/tool trace — this is what
    // lets a finished message show only its answer by default while still
    // making the process that produced it available on click (ThinkingCard/
    // ToolActivitySummary), instead of that trace vanishing the moment the
    // turn settles.
    expect(assistantTurn.reasoning).toBe('weighing which fact to lead with')
    expect(assistantTurn.tools).toEqual([
      { name: 'web_search', eventType: undefined, preview: 'searching docs', complete: true, isError: false },
    ])
    expect(assistantTurn.text).toBe("I'm using **nvidia/nemotron**.")

    // Once the turn has settled, the live-streaming reasoning/tools reset to
    // empty for the NEXT turn — a completed turn's snapshot must not leak
    // into a still-in-flight one.
    expect(result.current.reasoningText).toBe('')
    expect(result.current.tools).toEqual([])
  })

  it('leaves reasoning undefined (not empty string) for a turn with no reasoning at all', async () => {
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
      await result.current.send('hi')
    })

    const source = latestSource()
    act(() => source.emit('token', { text: 'hello' }))
    act(() => source.emit('done', { terminal_state: 'ok' }))
    act(() => source.emit('stream_end', {}))

    await waitFor(() => expect(result.current.turns.at(-1)?.role).toBe('assistant'))
    const assistantTurn = result.current.turns.at(-1)!

    expect(assistantTurn.reasoning).toBeUndefined()
    expect(assistantTurn.tools).toEqual([])
  })
})

describe('useChat session persistence across reload', () => {
  it('binds to a persisted session id instead of creating a new one', async () => {
    window.localStorage.setItem('hermano.chat.session.ws-1.agent-a', 'persisted-session')
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValueOnce({
      messages: [{ role: 'user', content: 'earlier message', timestamp: 1 }],
      limit: 50,
      offset: 0,
      total: 1,
    })

    const { result } = renderHook(({ agent }) => useChat('ws-1', agent), {
      wrapper,
      initialProps: { agent: 'agent-a' as string | null },
    })

    await waitFor(() => expect(result.current.turns.length).toBe(1))

    // createSession must NEVER be called when a persisted session id
    // already exists for this exact workspace+agent — calling it would
    // silently mint a second, unrelated session and orphan the real one.
    expect(mockedApi.createSession).not.toHaveBeenCalled()
    expect(mockedAgentHistoryApi.listAgentMessages).toHaveBeenCalledWith('ws-1', 'agent-a', 'persisted-session')
    expect(result.current.turns[0].text).toBe('earlier message')
  })

  it('persists a freshly-created session id so the next mount reuses it', async () => {
    mockedApi.createSession.mockResolvedValueOnce({ sessionId: 'brand-new-session' })

    renderHook(({ agent }) => useChat('ws-1', agent), {
      wrapper,
      initialProps: { agent: 'agent-a' as string | null },
    })

    await waitFor(() =>
      expect(window.localStorage.getItem('hermano.chat.session.ws-1.agent-a')).toBe('brand-new-session'),
    )
  })

  it('reconnects to an already-active stream detected via session status', async () => {
    window.localStorage.setItem('hermano.chat.session.ws-1.agent-a', 'persisted-session')
    mockedApi.getSessionStatus.mockResolvedValueOnce({ activeStreamId: 'still-running-stream' })

    const { result } = renderHook(({ agent }) => useChat('ws-1', agent), {
      wrapper,
      initialProps: { agent: 'agent-a' as string | null },
    })

    // Reconnected without ever calling startTurn — this stream already
    // exists server-side, from before the reload.
    await waitFor(() => expect(result.current.isStreaming).toBe(true))
    expect(mockedApi.startTurn).not.toHaveBeenCalled()
  })

  it('does not reconnect when session status reports no active stream', async () => {
    window.localStorage.setItem('hermano.chat.session.ws-1.agent-a', 'persisted-session')
    mockedApi.getSessionStatus.mockResolvedValueOnce({ activeStreamId: null })

    const { result } = renderHook(({ agent }) => useChat('ws-1', agent), {
      wrapper,
      initialProps: { agent: 'agent-a' as string | null },
    })

    await waitFor(() => expect(mockedApi.getSessionStatus).toHaveBeenCalled())
    expect(result.current.isStreaming).toBe(false)
  })
})
