/** camelCase DTOs for rust_gateway's per-workspace chat proxy
 * (`/workspaces/:id/chat/*` -> Hermes' native `/api/chat/*`, `/api/session/*`,
 * `/api/approval/*`, `/api/clarify/*`). See `api.ts` for the snake_case ->
 * camelCase remap and `rust_gateway/docs/hermes-chat-wire-contract.md` for
 * the authoritative wire semantics this file encodes.
 *
 * Every call takes `workspaceId` first and `agent` second — an "agent" IS a
 * Hermes profile, and the gateway turns `?agent=<name>` into the
 * `hermes_profile` cookie the container needs. Never omit it.
 */

export type ChatSession = {
  sessionId: string
  profile?: string
  /** The model this session actually got created with — echoes back
   * `POST /api/session/new`'s own `model`/`model_provider` response
   * fields. `null` when the server fell back to the profile default
   * (no explicit model was requested at creation, or the request left
   * it unset). See `api.ts`'s `createSession` doc comment. */
  model?: string | null
  modelProvider?: string | null
}

export type StartTurnResult = {
  streamId: string
  sessionId: string
  pendingStartedAt: number
  turnId: string | null
  title: string
  effectiveModel?: string
  effectiveModelProvider?: string
}

export type CancelTurnResult = {
  ok: boolean
  cancelled: boolean
  streamId: string
}

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

export type ApprovalPrompt = {
  approvalId?: string
  description?: string
  command?: string
  pendingCount?: number
  sessionId?: string
}

export type ClarifyPrompt = {
  clarifyId: string
  question: string
  choicesOffered: string[]
  sessionId?: string
  expiresAt?: number
}

export type ToolActivity = {
  name: string
  eventType?: string
  preview?: string
  isError?: boolean
  complete: boolean
}

/** Result of `POST /api/upload` (see `api.ts`'s `uploadAttachment`) — the
 * shape `/api/chat/start`'s `attachments` array expects per-item
 * (`_normalize_chat_attachments` in `backend/upstream/api/routes.py`
 * accepts exactly `{name,path,mime,size?,is_image?}`). This is a real
 * server-side upload result (the file's bytes already landed in the
 * session's attachment inbox at `path`) — never a client-only file name. */
export type ChatAttachment = {
  name: string
  path: string
  mime: string
  size?: number
  isImage?: boolean
}

export type ChatTerminalState = 'idle' | 'streaming' | 'done' | 'cancelled' | 'error'
