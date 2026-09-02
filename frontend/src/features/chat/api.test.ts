import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachmentFileUrl, createSession, mediaFileUrl, startTurn, uploadAttachment } from '@/features/chat/api'

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

// These prove Bug 1's real fix: a file attached in the composer must
// actually leave the browser as multipart bytes (not a text placeholder
// appended to the message) and its upload result must actually be echoed
// back on the turn — matching upstream's real `/api/upload` +
// `/api/chat/start` `attachments` contract (see
// `rust_gateway/docs/hermes-chat-wire-contract.md` §1.1 and
// `backend/upstream/api/upload.py`). Before this fix there was no
// `uploadAttachment` export at all and `startTurn` had no `attachments`
// parameter — a file could never leave the browser.
describe('uploadAttachment', () => {
  it('POSTs the real file bytes as multipart/form-data with the session id, not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        filename: 'notes.txt',
        path: '/state/attachments/session-a/notes.txt',
        size: 11,
        mime: 'text/plain',
        is_image: false,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' })
    const result = await uploadAttachment('ws-1', 'pm', 'session-a', file)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/upload')
    // The body must be real multipart form data carrying the actual File —
    // never JSON.stringify'd (that would silently drop the file bytes,
    // which is exactly how Bug 1 manifested: a placeholder string instead
    // of the file ever reaching the network).
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get('session_id')).toBe('session-a')
    const uploadedFile = form.get('file') as File
    expect(uploadedFile.name).toBe('notes.txt')
    expect(await uploadedFile.text()).toBe('hello world')

    // The server's real upload result (with its server-assigned `path`) is
    // what the caller gets back — not the raw browser File.
    expect(result).toEqual({
      name: 'notes.txt',
      path: '/state/attachments/session-a/notes.txt',
      mime: 'text/plain',
      size: 11,
      isImage: false,
    })
  })

  it('surfaces the server error message on a failed upload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'File too large (max 20MB)' }, false))
    vi.stubGlobal('fetch', fetchMock)

    const file = new File(['x'], 'big.bin')
    await expect(uploadAttachment('ws-1', 'pm', 'session-a', file)).rejects.toThrow(
      'File too large (max 20MB)',
    )
  })
})

describe('startTurn with attachments', () => {
  it('echoes uploaded attachment records (snake_case) in the /api/chat/start body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        stream_id: 'stream-1',
        session_id: 'session-a',
        pending_started_at: 0,
        turn_id: null,
        title: 'title',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await startTurn('ws-1', 'pm', 'session-a', "I've uploaded 1 file(s): notes.txt", [
      { name: 'notes.txt', path: '/state/attachments/session-a/notes.txt', mime: 'text/plain', size: 11, isImage: false },
    ])

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.attachments).toEqual([
      { name: 'notes.txt', path: '/state/attachments/session-a/notes.txt', mime: 'text/plain', size: 11, is_image: false },
    ])
  })

  it('omits attachments entirely when none were uploaded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        stream_id: 'stream-1',
        session_id: 'session-a',
        pending_started_at: 0,
        turn_id: null,
        title: 'title',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await startTurn('ws-1', 'pm', 'session-a', 'hello')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.attachments).toBeUndefined()
  })
})

// `attachmentFileUrl` builds the URL a real `<img>` thumbnail (or a
// download link for a chip) points at. It must hit the SAME real
// upstream route (`GET /api/file/raw`) upstream's own vanilla client uses
// for the identical purpose (`backend/upstream/static/ui.js:17012`), via
// the same chat proxy every other call in this file goes through — never
// an invented scheme.
describe('attachmentFileUrl', () => {
  it('builds a /api/file/raw URL with session_id, path, and agent query params', () => {
    const url = attachmentFileUrl('ws-1', 'pm', 'session-a', 'photo.png')

    expect(url).toContain('/workspaces/ws-1/chat/api/file/raw')
    expect(url).toContain('session_id=session-a')
    expect(url).toContain('path=photo.png')
    expect(url).toContain('agent=pm')
  })

  it('percent-encodes a filename with special characters', () => {
    const url = attachmentFileUrl('ws-1', 'pm', 'session-a', 'my photo (1).png')

    expect(url).toContain('path=my%20photo%20(1).png')
  })
})

// `mediaFileUrl` builds the URL for a `MEDIA:<path>` token the AGENT
// emits inline in its own reply text — a SEPARATE real upstream route
// (`GET /api/media`) from `attachmentFileUrl`'s `/api/file/raw`, taking
// the full absolute path directly (see that function's own doc comment in
// `features/chat/api.ts` for exactly why the path shape differs).
describe('mediaFileUrl', () => {
  it('builds a /api/media URL with the absolute path, session_id, agent, and inline=1', () => {
    const url = mediaFileUrl(
      'ws-1',
      'pm',
      '49e0d5e71555',
      '/config/.hermes/webui/attachments/49e0d5e71555/router-settings.png',
    )

    expect(url).toContain('/workspaces/ws-1/chat/api/media')
    expect(url).toContain(
      'path=%2Fconfig%2F.hermes%2Fwebui%2Fattachments%2F49e0d5e71555%2Frouter-settings.png',
    )
    expect(url).toContain('session_id=49e0d5e71555')
    expect(url).toContain('agent=pm')
    expect(url).toContain('inline=1')
  })
})
