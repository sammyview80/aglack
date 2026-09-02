import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSession, startTurn } from '@/features/chat/api'

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: () => Promise.resolve(body),
  } as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createSession', () => {
  it('parses the NESTED {"session":{...}} shape Hermes actually returns', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ session: { session_id: '3a7da22dbb53', profile: 'pm' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const session = await createSession('ws-1', 'pm')

    expect(session.sessionId).toBe('3a7da22dbb53')
    expect(session.profile).toBe('pm')
  })

  it('falls back to a top-level session_id if Hermes ever sends that shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ session_id: 'flat-id', profile: 'pm' }))
    vi.stubGlobal('fetch', fetchMock)

    const session = await createSession('ws-1', 'pm')

    expect(session.sessionId).toBe('flat-id')
  })

  it('a send therefore carries a real session_id instead of undefined', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ session: { session_id: 'real-session-id' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          stream_id: 'stream-1',
          session_id: 'real-session-id',
          pending_started_at: 0,
          turn_id: null,
          title: 'title',
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const session = await createSession('ws-1', 'pm')
    await startTurn('ws-1', 'pm', session.sessionId, 'hello')

    const startCall = fetchMock.mock.calls[1]
    const body = JSON.parse(startCall[1].body as string)
    expect(body.session_id).toBe('real-session-id')
    expect(body.session_id).not.toBeUndefined()
  })
})
