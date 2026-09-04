/**
 * Client for rust_gateway's per-workspace chat proxy
 * (`ANY /workspaces/:id/chat/*path` -> Hermes' native `/api/chat/*`,
 * `/api/session/*`, `/api/approval/*`, `/api/clarify/*`). See
 * `rust_gateway/src/workspaces/chat_proxy.rs`.
 *
 * NOTE: unlike workspace/onboarding/agent-seeder/agent-history, this proxy
 * forwards Hermes' *own* JSON bodies whole (`{"error":"..."}` on failure,
 * plain objects on success) — it is not rust_gateway's `{ok,data}` envelope,
 * so calls here do NOT go through `apiFetch` (see that file's own doc
 * comment: proxy::forward-relayed responses are not that envelope). This
 * module has its own thin fetch wrapper instead.
 *
 * Every call takes `workspaceId` first, `agent` second. `agent` is always
 * sent as `?agent=<name>` — the gateway translates that into the
 * `hermes_profile` cookie the container requires for per-agent isolation.
 */
import { gatewayUrl } from '@/lib/env'
import type {
  ApprovalChoice,
  CancelTurnResult,
  ChatAttachment,
  ChatSession,
  StartTurnResult,
} from '@/features/chat/types'

/** Hermes nests the session under a `session` key
 * (`{"session":{"session_id":...}}`); a top-level `session_id` is kept as a
 * defensive fallback in case that shape ever changes. `model`/`model_provider`
 * are read back so a caller that requested an explicit model at creation
 * time (see `createSession`'s optional params) can confirm what the server
 * actually resolved and persisted — the same field the real Hermes WebUI
 * frontend reads back into `S.session.model` right after `POST
 * /api/session/new` (`static/sessions.js`, `newSession()`, ~line 1508). */
type WireSession = {
  session?: { session_id: string; profile?: string; model?: string | null; model_provider?: string | null }
  session_id?: string
  profile?: string
  model?: string | null
  model_provider?: string | null
}
type WireStartTurnResult = {
  stream_id: string
  session_id: string
  pending_started_at: number
  turn_id: string | null
  title: string
  effective_model?: string
  effective_model_provider?: string
}
type WireCancelTurnResult = { ok: boolean; cancelled: boolean; stream_id: string }
/** Success shape of `POST /api/upload` (`backend/upstream/api/upload.py`'s
 * `handle_upload`) — the file's bytes are already written server-side by
 * the time this resolves; `path` is what `startTurn`'s `attachments` must
 * echo back so `/api/chat/start` can find them (see `_normalize_chat_attachments`,
 * `backend/upstream/api/routes.py`). */
type WireUploadResult = { filename: string; path: string; size: number; mime: string; is_image: boolean }
/** Only the fields this app actually uses from upstream's much larger
 * `session_status()` response (api/session_ops.py) — the rest (title,
 * model, token counts, ...) is intentionally not modeled, matching this
 * file's existing partial-view pattern (WireStartTurnResult etc.).
 * `active_stream_id` is upstream's own liveness-checked value (see
 * `_live_active_stream_id`'s doc comment in session_ops.py) — never a raw
 * possibly-stale persisted value, so no staleness check is needed here. */
type WireSessionStatus = { agent_running: boolean; active_stream_id: string | null }

function chatBase(workspaceId: string): string {
  return `${gatewayUrl()}/workspaces/${encodeURIComponent(workspaceId)}/chat`
}

function withAgent(path: string, agent: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}agent=${encodeURIComponent(agent)}`
}

/** Fetch helper for this proxy's raw (non-envelope) Hermes JSON bodies. */
async function chatFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new Error('Cannot reach the gateway. Is rust_gateway running?')
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }

  const errorText =
    body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : undefined

  if (!res.ok || errorText) {
    throw new Error(errorText ?? `Chat request failed (HTTP ${res.status})`)
  }

  return body as T
}

/** Create a session bound to one agent (Hermes profile). Each agent gets
 * its own session — never share one session across agents.
 *
 * `model`/`modelProvider` are OPTIONAL and, when given, are forwarded
 * straight into `POST /api/session/new`'s own `model`/`model_provider`
 * fields — verified against the real Hermes WebUI frontend
 * (`backend/upstream/static/sessions.js`, `newSession()`, ~line
 * 1459-1502) and confirmed server-side
 * (`backend/upstream/api/routes.py` line 15275,
 * `_session_model_state_from_request(body.get("model"), body.get("model_provider"))`
 * feeding straight into `new_session(...)`). This is the ONLY way to pin
 * a brand-new (not-yet-created) session to a specific model: unlike an
 * existing session (`setActiveModel` in `features/models/api.ts`, which
 * calls `POST /api/session/update` against a real `session_id`), there is
 * no session to update yet — the pick has to ride along with creation
 * itself. Omitting both params is a no-op for this field (server falls
 * back to the profile's configured default), so every existing call site
 * is unaffected. */
export async function createSession(
  workspaceId: string,
  agent: string,
  model?: string,
  modelProvider?: string | null,
): Promise<ChatSession> {
  const data = await chatFetch<WireSession>(
    withAgent(`${chatBase(workspaceId)}/api/session/new`, agent),
    {
      method: 'POST',
      body: JSON.stringify({
        profile: agent,
        ...(model ? { model, model_provider: modelProvider ?? null } : {}),
      }),
    },
  )
  const session = data.session ?? data
  return {
    sessionId: session.session_id as string,
    profile: session.profile,
    model: session.model ?? null,
    modelProvider: session.model_provider ?? null,
  }
}

export async function startTurn(
  workspaceId: string,
  agent: string,
  sessionId: string,
  message: string,
  attachments?: ChatAttachment[],
): Promise<StartTurnResult> {
  const data = await chatFetch<WireStartTurnResult>(
    withAgent(`${chatBase(workspaceId)}/api/chat/start`, agent),
    {
      method: 'POST',
      body: JSON.stringify({
        session_id: sessionId,
        message,
        profile: agent,
        // Only sent when non-empty — upstream's normalizer treats an absent
        // key the same as `[]` (`_normalize_chat_attachments`), so this
        // avoids widening every existing call's request body for nothing.
        ...(attachments && attachments.length > 0
          ? {
              attachments: attachments.map((a) => ({
                name: a.name,
                path: a.path,
                mime: a.mime,
                size: a.size,
                is_image: a.isImage,
              })),
            }
          : {}),
      }),
    },
  )
  return {
    streamId: data.stream_id,
    sessionId: data.session_id,
    pendingStartedAt: data.pending_started_at,
    turnId: data.turn_id,
    title: data.title,
    effectiveModel: data.effective_model,
    effectiveModelProvider: data.effective_model_provider,
  }
}

/** Uploads one file into the session's server-side attachment inbox via
 * upstream's real `POST /api/upload` (`backend/upstream/api/upload.py`) —
 * multipart, NOT JSON, so this bypasses `chatFetch` (which always sets
 * `Content-Type: application/json`; a multipart body needs the browser's
 * own boundary-bearing content type, which only happens if we never set
 * the header ourselves). The returned `path` is what must be echoed back
 * in `startTurn`'s `attachments` for the turn to actually see the file —
 * uploading alone does not attach it to anything. */
export async function uploadAttachment(
  workspaceId: string,
  agent: string,
  sessionId: string,
  file: File,
): Promise<ChatAttachment> {
  const form = new FormData()
  form.append('session_id', sessionId)
  form.append('file', file, file.name)

  let res: Response
  try {
    res = await fetch(withAgent(`${chatBase(workspaceId)}/api/upload`, agent), {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
  } catch {
    throw new Error('Cannot reach the gateway. Is rust_gateway running?')
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }

  const errorText =
    body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : undefined

  if (!res.ok || errorText) {
    throw new Error(errorText ?? `Upload failed (HTTP ${res.status})`)
  }

  const data = body as WireUploadResult
  return {
    name: data.filename,
    path: data.path,
    mime: data.mime,
    size: data.size,
    isImage: data.is_image,
  }
}

/** Whether this session already has a turn running server-side right now
 * — used to reconnect to an in-flight stream after a page reload instead
 * of the reload silently losing track of it. Backed by upstream's
 * existing `GET /api/session/status` (`api/session_ops.py::session_status`)
 * — no new backend endpoint needed, already reachable through the
 * proxied chat namespace. */
export async function getSessionStatus(
  workspaceId: string,
  agent: string,
  sessionId: string,
): Promise<{ activeStreamId: string | null }> {
  const data = await chatFetch<WireSessionStatus>(
    withAgent(`${chatBase(workspaceId)}/api/session/status?session_id=${encodeURIComponent(sessionId)}`, agent),
    { method: 'GET' },
  )
  return { activeStreamId: data.agent_running ? data.active_stream_id : null }
}

/** `status` field of `POST /api/session/compress/start` / `GET
 * /api/session/compress/status` (`backend/upstream/api/routes.py`'s
 * `_manual_compression_status_payload`) — `'running'` while the async
 * worker thread is still summarizing, `'done'` once the session's
 * messages have been rewritten server-side, `'idle'` if polled after the
 * in-memory job entry already expired (its own TTL, not modeled here —
 * treated as an error by the caller). `chatFetch` only throws when the
 * response body has an `error` key, so `running`/`done` (neither has one)
 * pass through untouched; `error` does have one and throws via the
 * shared helper, same as every other call in this file. */
type WireCompressionStatus = { status: 'running' | 'done' | 'error' | 'idle'; error?: string }

/** Starts (or observes an already-running) manual context compression for
 * `sessionId` — backed by upstream's existing `POST
 * /api/session/compress/start`, already reachable through the proxied
 * chat namespace (no new backend/gateway work needed). `focusTopic` mirrors
 * `/compress <topic>`'s optional argument (`backend/upstream/static/
 * commands.js`'s `cmdCompress`); omit for a bare `/compress`. The caller
 * must poll `getCompressionStatus` until `status !== 'running'` — this
 * call only ADMITS the job (or reports one already in flight), it does
 * not itself wait for completion (upstream's own `_runManualCompression`
 * does the same: fire `compress/start`, then poll `compress/status`
 * separately). */
export async function startCompression(
  workspaceId: string,
  agent: string,
  sessionId: string,
  focusTopic?: string,
): Promise<{ status: 'running' | 'done' | 'error' }> {
  const data = await chatFetch<WireCompressionStatus>(
    withAgent(`${chatBase(workspaceId)}/api/session/compress/start`, agent),
    {
      method: 'POST',
      body: JSON.stringify({
        session_id: sessionId,
        ...(focusTopic ? { focus_topic: focusTopic } : {}),
      }),
    },
  )
  return { status: data.status === 'idle' ? 'error' : data.status }
}

/** Polls one manual-compression job's status — see `startCompression`'s
 * own doc comment for the full flow. Returns `'error'` for upstream's
 * own `idle` status too (a polled-after-TTL-expiry job) — the caller has
 * no useful distinct action for that case beyond reporting failure. */
export async function getCompressionStatus(
  workspaceId: string,
  agent: string,
  sessionId: string,
): Promise<{ status: 'running' | 'done' | 'error' }> {
  const data = await chatFetch<WireCompressionStatus>(
    withAgent(
      `${chatBase(workspaceId)}/api/session/compress/status?session_id=${encodeURIComponent(sessionId)}`,
      agent,
    ),
    { method: 'GET' },
  )
  return { status: data.status === 'idle' ? 'error' : data.status }
}

/** Stream URL for `EventSource` — kept here so the SSE hook never builds
 * gateway paths itself. */
export function chatStreamUrl(workspaceId: string, agent: string, streamId: string): string {
  return withAgent(
    `${chatBase(workspaceId)}/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`,
    agent,
  )
}

/**
 * Real, servable URL for a previously-uploaded attachment — backed by
 * upstream's existing `GET /api/file/raw` (`backend/upstream/api/routes.py`,
 * `_handle_file_raw`), which falls back to the requesting session's own
 * attachment inbox via `_file_raw_target` (`api/routes.py:20710-20731`,
 * `_session_attachment_dir()`) when the path isn't found under the
 * workspace root — exactly where `uploadAttachment()`'s `POST /api/upload`
 * wrote the file. This is NOT an invented URL scheme: it is the same route
 * upstream's own vanilla client uses for this exact purpose (see
 * `backend/upstream/static/ui.js:17012`,
 * `'api/file/raw?session_id='+sid+'&path='+encodeURIComponent(fname)`).
 *
 * `path` MUST be the bare filename (`ChatAttachment.name`, i.e. `dest.name`
 * from the upload response) — NOT the absolute server-side `ChatAttachment.path`.
 * `_file_raw_target` resolves `path` via `safe_resolve(root, rel)`, which
 * requires `rel` to stay a relative child of `root`
 * (`resolved.relative_to(root)` raises otherwise, `api/helpers.py:62-66`);
 * handing it the full absolute path would fail that containment check and
 * 404/403 instead of finding the file one directory up.
 *
 * Reached through this same chat proxy (`ANY /workspaces/:id/chat/*path`)
 * every other call in this file uses, so it carries the same
 * `?agent=<name>` -> `hermes_profile` cookie translation `_file_raw_target`
 * needs to resolve the right profile's session.
 */
export function attachmentFileUrl(
  workspaceId: string,
  agent: string,
  sessionId: string,
  filename: string,
): string {
  return withAgent(
    `${chatBase(workspaceId)}/api/file/raw?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filename)}`,
    agent,
  )
}

/**
 * Real, servable URL for a `MEDIA:<absolute-path>` (or bare `file://`)
 * reference the AGENT emits inline in its own reply text — a separate
 * mechanism from `attachmentFileUrl` above (that one is for files WE
 * uploaded; this one is for local files the agent points at in prose,
 * e.g. `MEDIA:/config/.hermes/webui/attachments/<sid>/router-settings.png`
 * or a screenshot it wrote to the workspace). Backed by upstream's
 * existing `GET /api/media` (`backend/upstream/api/routes.py:20508`,
 * `_handle_media`) — this is the SAME route upstream's own vanilla client
 * resolves every `MEDIA:`/`file://` token through (see
 * `_inlineMediaHtmlForRef` in `backend/upstream/static/ui.js:2725`,
 * `'api/media?path='+encodeURIComponent(ref)+...'&session_id='+sid`).
 *
 * Unlike `attachmentFileUrl`, `path` here MUST be the file's full
 * ABSOLUTE path exactly as the token carries it — `_handle_media` resolves
 * `path` directly (`Path(raw_path).resolve()`, `api/routes.py:20544`) and
 * checks it against an allow-list of roots (Hermes home, `/tmp`, the
 * active workspace, plus this exact session's own previously-emitted
 * `MEDIA:` refs — see `_session_media_token_allows_path`,
 * `api/routes.py:20258`), not a per-session relative lookup — passing a
 * bare filename here would resolve against the WRONG directory (the
 * gateway process's cwd) and 403/404 instead of finding the file.
 *
 * `?inline=1` requests inline (not `Content-Disposition: attachment`)
 * delivery for the safe preview MIME types `_handle_media` allow-lists —
 * required for an `<img src>` to actually render instead of triggering a
 * download prompt.
 */
export function mediaFileUrl(
  workspaceId: string,
  agent: string,
  sessionId: string,
  absolutePath: string,
): string {
  return withAgent(
    `${chatBase(workspaceId)}/api/media?path=${encodeURIComponent(absolutePath)}&session_id=${encodeURIComponent(sessionId)}&inline=1`,
    agent,
  )
}

/** Terminates the turn. Keyed by `streamId`, not `sessionId`.
 * Note: Hermes handles cancel on GET /api/chat/cancel?stream_id=... */
export async function cancelTurn(
  workspaceId: string,
  agent: string,
  streamId: string,
): Promise<CancelTurnResult> {
  const data = await chatFetch<WireCancelTurnResult>(
    withAgent(`${chatBase(workspaceId)}/api/chat/cancel?stream_id=${encodeURIComponent(streamId)}`, agent),
  )
  return { ok: data.ok, cancelled: data.cancelled, streamId: data.stream_id }
}

/** Decision vocabulary is NOT approve/deny — exactly `once`/`session`/`always`/`deny`. */
export async function respondToApproval(
  workspaceId: string,
  agent: string,
  sessionId: string,
  choice: ApprovalChoice,
  approvalId?: string,
): Promise<void> {
  await chatFetch<unknown>(withAgent(`${chatBase(workspaceId)}/api/approval/respond`, agent), {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, choice, approval_id: approvalId }),
  })
}

export async function respondToClarify(
  workspaceId: string,
  agent: string,
  sessionId: string,
  response: string,
  clarifyId?: string,
): Promise<void> {
  await chatFetch<unknown>(withAgent(`${chatBase(workspaceId)}/api/clarify/respond`, agent), {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, response, clarify_id: clarifyId }),
  })
}
