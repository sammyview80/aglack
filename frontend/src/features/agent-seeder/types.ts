/** camelCase DTOs for rust_gateway's per-workspace agent-seeder proxy
 * (`ANY /workspaces/:id/agent-seeder/*` — see
 * rust_gateway/src/workspaces/agent_seeder_proxy.rs), which forwards to
 * `backend/wrapper`'s `POST /api/wrapper/v1/agent-seeder/apply[/​{name}]`.
 * See `api.ts` for the snake_case -> camelCase remap. */

export type AppliedAgent = {
  agent: string
  displayName: string
  profileCreated: boolean
  soulUpdated: boolean
  agentMdUpdated: boolean
  agentMdSkippedReason?: string
  skillsSeeded: string[]
  toolsSeeded: string[]
  mcpServerConfigured: boolean
}

export type ApplySeederResult = {
  applied: AppliedAgent[]
}
