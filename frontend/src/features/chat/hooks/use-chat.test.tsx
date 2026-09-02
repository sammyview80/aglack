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
    uploadAttachment: vi.fn(),
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
  window.sessionStorage.clear()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.sessionStorage.clear()
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

    await act(async () => {
      void result.current.send('hello from A')
    })

    await waitFor(() => expect(mockedApi.createSession).toHaveBeenCalledWith('ws-1', 'agent-a'))

    // Switch agents before startTurn (issued for agent-a) resolves.
    rerender({ agent: 'agent-b' })

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

describe('useChat session selection via sessionStorage', () => {
  it('binds to a selected session id instead of creating a new one', async () => {
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValueOnce({
      messages: [{ role: 'user', content: 'earlier message', timestamp: 1 }],
      limit: 50,
      offset: 0,
      total: 1,
    })

    const { result } = renderHook(
      ({ sessionId }) => useChat('ws-1', 'agent-a', { sessionId }),
      { wrapper, initialProps: { sessionId: 'selected-session' as string | null } },
    )

    await waitFor(() => expect(result.current.turns.length).toBe(1))

    expect(mockedApi.createSession).not.toHaveBeenCalled()
    expect(mockedAgentHistoryApi.listAgentMessages).toHaveBeenCalledWith('ws-1', 'agent-a', 'selected-session')
    expect(result.current.turns[0].text).toBe('earlier message')
  })

  it('carries attachment metadata through from a reloaded history turn', async () => {
    // Proves attachments survive a page reload / history reload, not just
    // a same-tab freshly-sent turn — the wrapper's `agent_history`
    // projection now threads `attachments` through instead of dropping
    // them (see `backend/wrapper/.../agent_history/service.py`), and this
    // hook's `historyToTurns` must pass that straight onto `ChatTurn`.
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValueOnce({
      messages: [
        {
          role: 'user',
          content: 'check this out',
          timestamp: 1,
          attachments: [
            { name: 'a.png', path: '/state/attachments/s1/a.png', mime: 'image/png', size: 42, isImage: true },
          ],
        },
      ],
      limit: 50,
      offset: 0,
      total: 1,
    })

    const { result } = renderHook(
      ({ sessionId }) => useChat('ws-1', 'agent-a', { sessionId }),
      { wrapper, initialProps: { sessionId: 'selected-session' as string | null } },
    )

    await waitFor(() => expect(result.current.turns.length).toBe(1))

    expect(result.current.turns[0].attachments).toEqual([
      { name: 'a.png', path: '/state/attachments/s1/a.png', mime: 'image/png', size: 42, isImage: true },
    ])
  })

  it('leaves `attachments` undefined on a reloaded history turn that never had any', async () => {
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValueOnce({
      messages: [{ role: 'user', content: 'no files here', timestamp: 1 }],
      limit: 50,
      offset: 0,
      total: 1,
    })

    const { result } = renderHook(
      ({ sessionId }) => useChat('ws-1', 'agent-a', { sessionId }),
      { wrapper, initialProps: { sessionId: 'selected-session' as string | null } },
    )

    await waitFor(() => expect(result.current.turns.length).toBe(1))

    expect(result.current.turns[0].attachments).toBeUndefined()
  })

  it('writes a freshly-created session id to sessionStorage on first send', async () => {
    mockedApi.createSession.mockReset()
    mockedApi.createSession.mockResolvedValue({ sessionId: 'brand-new-session' })
    mockedApi.startTurn.mockResolvedValueOnce({
      streamId: 'stream-1',
      sessionId: 'brand-new-session',
      pendingStartedAt: 0,
      turnId: null,
      title: 'title',
    })

    const { result } = renderHook(({ agent }) => useChat('ws-1', agent), {
      wrapper,
      initialProps: { agent: 'agent-a' as string | null },
    })

    await act(async () => {
      await result.current.send('hello')
    })

    await waitFor(() =>
      expect(window.sessionStorage.getItem('hermano.chat.selected.ws-1.agent-a')).toBe('brand-new-session'),
    )
  })

  it('reconnects to an already-active stream detected via session status', async () => {
    mockedApi.getSessionStatus.mockResolvedValueOnce({ activeStreamId: 'still-running-stream' })

    const { result } = renderHook(
      ({ sessionId }) => useChat('ws-1', 'agent-a', { sessionId }),
      { wrapper, initialProps: { sessionId: 'selected-session' as string | null } },
    )

    await waitFor(() => expect(result.current.isStreaming).toBe(true))
    expect(mockedApi.startTurn).not.toHaveBeenCalled()
  })

  it('does not reconnect when session status reports no active stream', async () => {
    mockedApi.getSessionStatus.mockResolvedValueOnce({ activeStreamId: null })

    const { result } = renderHook(
      ({ sessionId }) => useChat('ws-1', 'agent-a', { sessionId }),
      { wrapper, initialProps: { sessionId: 'selected-session' as string | null } },
    )

    await waitFor(() => expect(mockedApi.getSessionStatus).toHaveBeenCalled())
    expect(result.current.isStreaming).toBe(false)
  })

  it('keeps transcript loading until session status resolves for an active-stream check', async () => {
    let resolveStatus: (value: { activeStreamId: string | null }) => void = () => {}
    mockedApi.getSessionStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve
      }),
    )
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValueOnce({
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      limit: 50,
      offset: 0,
      total: 1,
    })

    const { result } = renderHook(
      ({ sessionId }) => useChat('ws-1', 'agent-a', { sessionId }),
      { wrapper, initialProps: { sessionId: 'selected-session' as string | null } },
    )

    expect(result.current.isLoadingTranscript).toBe(true)

    await act(async () => {
      resolveStatus({ activeStreamId: null })
    })

    await waitFor(() => expect(result.current.isLoadingTranscript).toBe(false))
  })

  it('reloadMessages refetches history and reconnects SSE when session status reports an active stream', async () => {
    mockedApi.getSessionStatus.mockResolvedValue({ activeStreamId: null })
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValue({
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      limit: 50,
      offset: 0,
      total: 1,
    })

    const { result } = renderHook(
      ({ sessionId }) => useChat('ws-1', 'agent-a', { sessionId }),
      { wrapper, initialProps: { sessionId: 'selected-session' as string | null } },
    )

    await waitFor(() => expect(result.current.isLoadingTranscript).toBe(false))
    expect(result.current.isStreaming).toBe(false)

    mockedAgentHistoryApi.listAgentMessages.mockResolvedValueOnce({
      messages: [
        { role: 'user', content: 'hello', timestamp: 1 },
        { role: 'assistant', content: 'partial…', timestamp: 2 },
      ],
      limit: 50,
      offset: 0,
      total: 2,
    })
    mockedApi.getSessionStatus.mockResolvedValueOnce({ activeStreamId: 'live-stream' })

    await act(async () => {
      result.current.reloadMessages()
    })

    await waitFor(() => expect(result.current.isStreaming).toBe(true))
    expect(mockedAgentHistoryApi.listAgentMessages).toHaveBeenCalledTimes(2)
    expect(mockedApi.getSessionStatus).toHaveBeenCalledTimes(2)
  })
})

// Regression coverage for Bug 1 ("File attachments are silently
// non-functional"): before this fix, `send()` took only `text`, appended a
// literal `[Attached: name]` string, and never called any upload — these
// tests prove the file's bytes are now actually uploaded, and that the
// resulting server path is threaded through to `startTurn`, before any
// turn starts.
describe('useChat attachments', () => {
  it('uploads each attached file before starting the turn, and threads the results into startTurn', async () => {
    mockedApi.createSession.mockResolvedValueOnce({ sessionId: 'session-a' })
    mockedApi.uploadAttachment
      .mockResolvedValueOnce({ name: 'a.txt', path: '/state/attachments/session-a/a.txt', mime: 'text/plain', size: 3, isImage: false })
      .mockResolvedValueOnce({ name: 'b.png', path: '/state/attachments/session-a/b.png', mime: 'image/png', size: 9, isImage: true })
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

    const fileA = new File(['abc'], 'a.txt', { type: 'text/plain' })
    const fileB = new File(['123456789'], 'b.png', { type: 'image/png' })

    await act(async () => {
      await result.current.send('check these out', [fileA, fileB])
    })

    // Real upload calls — one per file, carrying the real File and the
    // session id the turn will run under.
    expect(mockedApi.uploadAttachment).toHaveBeenCalledTimes(2)
    expect(mockedApi.uploadAttachment).toHaveBeenNthCalledWith(1, 'ws-1', 'agent-a', 'session-a', fileA)
    expect(mockedApi.uploadAttachment).toHaveBeenNthCalledWith(2, 'ws-1', 'agent-a', 'session-a', fileB)

    // startTurn must receive the UPLOADED records (server paths), not the
    // raw File objects and not a placeholder string standing in for them.
    expect(mockedApi.startTurn).toHaveBeenCalledWith(
      'ws-1',
      'agent-a',
      'session-a',
      expect.stringContaining('check these out'),
      [
        { name: 'a.txt', path: '/state/attachments/session-a/a.txt', mime: 'text/plain', size: 3, isImage: false },
        { name: 'b.png', path: '/state/attachments/session-a/b.png', mime: 'image/png', size: 9, isImage: true },
      ],
    )
  })

  it('threads the uploaded attachment records onto the pushed local turn, not just into startTurn', async () => {
    // Regression coverage for the gap this fix closes: `ChatTurn` had no
    // structured attachment field at all, so a locally-sent turn's
    // attachments were only ever visible as text baked into
    // `displayMessage` — no name/mime/isImage a UI could actually render
    // a chip or thumbnail from. Assert the SAME upload results sent to
    // `startTurn` also land on `turns.at(-1).attachments`.
    mockedApi.createSession.mockResolvedValueOnce({ sessionId: 'session-a' })
    mockedApi.uploadAttachment.mockResolvedValueOnce({
      name: 'b.png',
      path: '/state/attachments/session-a/b.png',
      mime: 'image/png',
      size: 9,
      isImage: true,
    })
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

    const file = new File(['123456789'], 'b.png', { type: 'image/png' })

    await act(async () => {
      await result.current.send('check this out', [file])
    })

    const pushedTurn = result.current.turns.at(-1)
    expect(pushedTurn?.attachments).toEqual([
      { name: 'b.png', path: '/state/attachments/session-a/b.png', mime: 'image/png', size: 9, isImage: true },
    ])
  })

  it('leaves `attachments` undefined (not an empty array) on a turn sent without files', async () => {
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

    await act(async () => {
      await result.current.send('hello')
    })

    expect(result.current.turns.at(-1)?.attachments).toBeUndefined()
    expect(mockedApi.uploadAttachment).not.toHaveBeenCalled()
  })

  it('synthesizes a real message when only files are sent (no blank message reaches the wire)', async () => {
    mockedApi.createSession.mockResolvedValueOnce({ sessionId: 'session-a' })
    mockedApi.uploadAttachment.mockResolvedValueOnce({
      name: 'a.txt',
      path: '/state/attachments/session-a/a.txt',
      mime: 'text/plain',
      size: 3,
      isImage: false,
    })
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

    const file = new File(['abc'], 'a.txt', { type: 'text/plain' })

    await act(async () => {
      await result.current.send('', [file])
    })

    // The WIRE message still carries the synthesized "I've uploaded..."
    // sentence — required by the backend contract (message can never be
    // blank) and unchanged by this fix.
    const [, , , message] = mockedApi.startTurn.mock.calls[0]
    expect(message.trim().length).toBeGreaterThan(0)
    expect(message).toContain('a.txt')
    expect(message).toMatch(/^I've uploaded/)

    // The DISPLAYED turn must never show that raw synthetic sentence
    // verbatim in the transcript bubble (this was the bug: upstream
    // strips its own equivalent synthetic wording before display — see
    // `backend/upstream/static/sessions.js:3285,7265`).
    const displayedText = result.current.turns.at(-1)?.text ?? ''
    expect(displayedText).not.toMatch(/^I've uploaded \d+ file\(s\)/)
    // It's still fine (and expected) for the clean display text to
    // reference the filename itself, just not the synthesized sentence.
    expect(displayedText).toContain('a.txt')
  })

  it('shows the clean original message (not the "[Attached files: ...]" wire suffix) in the displayed turn for text+files sends', async () => {
    mockedApi.createSession.mockResolvedValueOnce({ sessionId: 'session-a' })
    mockedApi.uploadAttachment.mockResolvedValueOnce({
      name: 'a.txt',
      path: '/state/attachments/session-a/a.txt',
      mime: 'text/plain',
      size: 3,
      isImage: false,
    })
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

    const file = new File(['abc'], 'a.txt', { type: 'text/plain' })

    await act(async () => {
      await result.current.send('hello', [file])
    })

    // Wire message still carries the synthetic suffix, unchanged.
    const [, , , message] = mockedApi.startTurn.mock.calls[0]
    expect(message).toBe('hello\n\n[Attached files: a.txt]')

    // Displayed turn shows the clean original message only — no bracket
    // suffix leaking into the human-visible transcript.
    expect(result.current.turns.at(-1)?.text).toBe('hello')
  })

  it('does not start a turn when an upload fails', async () => {
    mockedApi.createSession.mockResolvedValueOnce({ sessionId: 'session-a' })
    mockedApi.uploadAttachment.mockRejectedValueOnce(new Error('Upload failed'))

    const { result } = renderHook(({ agent }) => useChat('ws-1', agent), {
      wrapper,
      initialProps: { agent: 'agent-a' as string | null },
    })

    const file = new File(['abc'], 'a.txt', { type: 'text/plain' })

    await act(async () => {
      await result.current.send('hi', [file])
    })

    expect(mockedApi.startTurn).not.toHaveBeenCalled()
    expect(result.current.isUploadingAttachments).toBe(false)
  })

  // Regression coverage for Fix 2: `retry()` used to call `send()` with no
  // second argument, so a dropped-connection turn that had attachments
  // would silently resend text-only, losing the files with no indication
  // to the user. This proves the same File objects are re-uploaded (and
  // re-sent) on retry.
  it('retry() resends the same attached files, not just the text', async () => {
    mockedApi.createSession.mockResolvedValueOnce({ sessionId: 'session-a' })
    mockedApi.uploadAttachment.mockResolvedValue({
      name: 'a.txt',
      path: '/state/attachments/session-a/a.txt',
      mime: 'text/plain',
      size: 3,
      isImage: false,
    })
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

    const file = new File(['abc'], 'a.txt', { type: 'text/plain' })

    await act(async () => {
      await result.current.send('hello', [file])
    })

    expect(mockedApi.uploadAttachment).toHaveBeenCalledTimes(1)

    // Simulate the dropped-connection turn ending so a retry send is
    // allowed to start (send() bails out early while a stream is active).
    await act(async () => {
      latestSource().emit('stream_end', {})
    })

    mockedApi.startTurn.mockResolvedValueOnce({
      streamId: 'stream-2',
      sessionId: 'session-a',
      pendingStartedAt: 0,
      turnId: null,
      title: 'title',
    })

    await act(async () => {
      result.current.retry()
    })

    // The file is uploaded again (retry is a fresh turn, not a raw
    // replay) — proving the SAME File reference survived in lastFilesRef
    // and was actually threaded through to send() again.
    expect(mockedApi.uploadAttachment).toHaveBeenCalledTimes(2)
    expect(mockedApi.uploadAttachment).toHaveBeenNthCalledWith(2, 'ws-1', 'agent-a', 'session-a', file)

    const [, , , retryMessage] = mockedApi.startTurn.mock.calls[1]
    expect(retryMessage).toBe('hello\n\n[Attached files: a.txt]')
  })
})

describe('useChat session id stability', () => {
  it('does not reset or cancel when the same session id is set again', async () => {
    mockedApi.getSessionStatus.mockResolvedValue({ activeStreamId: 'live-stream' })

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useChat('ws-1', 'agent-a', { sessionId }),
      { wrapper, initialProps: { sessionId: 'selected-session' } },
    )

    await waitFor(() => expect(result.current.isStreaming).toBe(true))

    mockedApi.cancelTurn.mockClear()
    rerender({ sessionId: 'selected-session' })

    await waitFor(() => expect(result.current.isStreaming).toBe(true))
    expect(mockedApi.cancelTurn).not.toHaveBeenCalled()
  })
})

// Regression coverage for Bug 2 ("No 'load older messages'"): before this
// fix `historyQuery` always fetched with no params (always the newest
// page) and there was no way to fetch anything further back. These tests
// exercise `loadOlderMessages` directly (the transcript-scroll wiring that
// calls it is covered separately in use-chat-transcript-scroll.test.ts).
describe('useChat loadOlderMessages', () => {
  it('fetches the next-older page at offset = current-oldest-offset minus the page size', async () => {
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValueOnce({
      messages: [{ role: 'user', content: 'msg-100', timestamp: 100 }],
      limit: 50,
      offset: 100,
      total: 150,
    })

    const { result } = renderHook(
      ({ sessionId }) => useChat('ws-1', 'agent-a', { sessionId }),
      { wrapper, initialProps: { sessionId: 'selected-session' as string | null } },
    )

    await waitFor(() => expect(result.current.turns.length).toBe(1))
    expect(result.current.hasOlderMessages).toBe(true)

    mockedAgentHistoryApi.listAgentMessages.mockResolvedValueOnce({
      messages: [{ role: 'assistant', content: 'msg-50', timestamp: 50 }],
      limit: 50,
      offset: 50,
      total: 150,
    })

    await act(async () => {
      result.current.loadOlderMessages()
    })

    await waitFor(() => expect(result.current.turns.length).toBe(2))
    expect(mockedAgentHistoryApi.listAgentMessages).toHaveBeenCalledTimes(2)
    expect(mockedAgentHistoryApi.listAgentMessages).toHaveBeenNthCalledWith(2, 'ws-1', 'agent-a', 'selected-session', {
      limit: 50,
      offset: 50,
    })
    // Prepended, not appended — the older message comes first.
    expect(result.current.turns[0].text).toBe('msg-50')
    expect(result.current.turns[1].text).toBe('msg-100')
  })

  it('does not fire a second fetch while one is already in flight', async () => {
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValueOnce({
      messages: [{ role: 'user', content: 'msg-100', timestamp: 100 }],
      limit: 50,
      offset: 100,
      total: 150,
    })

    const { result } = renderHook(
      ({ sessionId }) => useChat('ws-1', 'agent-a', { sessionId }),
      { wrapper, initialProps: { sessionId: 'selected-session' as string | null } },
    )

    await waitFor(() => expect(result.current.turns.length).toBe(1))

    let resolveOlder: (value: Awaited<ReturnType<typeof agentHistoryApi.listAgentMessages>>) => void = () => {}
    mockedAgentHistoryApi.listAgentMessages.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlder = resolve
      }),
    )

    act(() => {
      result.current.loadOlderMessages()
    })
    await waitFor(() => expect(result.current.isLoadingOlderMessages).toBe(true))

    // A second "scroll to top" while the first fetch is still pending must
    // not issue a second request.
    act(() => {
      result.current.loadOlderMessages()
    })
    expect(mockedAgentHistoryApi.listAgentMessages).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveOlder({
        messages: [{ role: 'assistant', content: 'msg-50', timestamp: 50 }],
        limit: 50,
        offset: 50,
        total: 150,
      })
    })

    await waitFor(() => expect(result.current.isLoadingOlderMessages).toBe(false))
    expect(mockedAgentHistoryApi.listAgentMessages).toHaveBeenCalledTimes(2)
  })

  it('stops fetching once the oldest loaded offset reaches 0', async () => {
    mockedAgentHistoryApi.listAgentMessages.mockResolvedValueOnce({
      messages: [{ role: 'user', content: 'only message', timestamp: 1 }],
      limit: 50,
      offset: 0,
      total: 1,
    })

    const { result } = renderHook(
      ({ sessionId }) => useChat('ws-1', 'agent-a', { sessionId }),
      { wrapper, initialProps: { sessionId: 'selected-session' as string | null } },
    )

    await waitFor(() => expect(result.current.turns.length).toBe(1))
    expect(result.current.hasOlderMessages).toBe(false)

    act(() => {
      result.current.loadOlderMessages()
    })

    // Only the initial fetch happened — no attempt to page further back
    // from offset 0.
    expect(mockedAgentHistoryApi.listAgentMessages).toHaveBeenCalledTimes(1)
  })
})
