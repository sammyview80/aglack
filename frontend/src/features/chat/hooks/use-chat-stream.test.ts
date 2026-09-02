import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStream } from '@/features/chat/hooks/use-chat-stream'

type Listener = (event: MessageEvent) => void

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  listeners = new Map<string, Set<Listener>>()
  closed = false
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(name: string, handler: Listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name)!.add(handler)
  }

  removeEventListener(name: string, handler: Listener) {
    this.listeners.get(name)?.delete(handler)
  }

  close() {
    this.closed = true
  }

  emit(name: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent
    for (const handler of this.listeners.get(name) ?? []) handler(event)
  }
}

beforeEach(() => {
  MockEventSource.instances = []
  vi.stubGlobal('EventSource', MockEventSource)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function latestSource() {
  return MockEventSource.instances[MockEventSource.instances.length - 1]
}

describe('useChatStream', () => {
  it('appends token deltas rather than replacing them', () => {
    const { result } = renderHook(() =>
      useChatStream({ workspaceId: 'ws-1', agent: 'pm', sessionId: 's-1', streamId: 'stream-1' }),
    )

    act(() => latestSource().emit('token', { text: 'Hello' }))
    act(() => latestSource().emit('token', { text: ', world' }))

    expect(result.current.assistantText).toBe('Hello, world')
  })

  it('ignores an event carrying a different session_id', () => {
    const { result } = renderHook(() =>
      useChatStream({ workspaceId: 'ws-1', agent: 'pm', sessionId: 's-1', streamId: 'stream-1' }),
    )

    act(() => latestSource().emit('token', { text: 'mine', session_id: 's-1' }))
    act(() => latestSource().emit('token', { text: 'not-mine', session_id: 'other-session' }))

    expect(result.current.assistantText).toBe('mine')
  })

  it('does NOT close the EventSource on `done`; only a later `stream_end` closes it', () => {
    const { result } = renderHook(() =>
      useChatStream({ workspaceId: 'ws-1', agent: 'pm', sessionId: 's-1', streamId: 'stream-1' }),
    )
    const source = latestSource()

    act(() => source.emit('done', { terminal_state: 'ok' }))

    expect(source.closed).toBe(false)
    expect(result.current.terminal).toBe('done')
    expect(result.current.connectionClosed).toBe(false)

    act(() => source.emit('stream_end', {}))

    expect(source.closed).toBe(true)
    expect(result.current.connectionClosed).toBe(true)
  })
})
