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

export type ChatTerminalState = 'idle' | 'streaming' | 'done' | 'cancelled' | 'error'
