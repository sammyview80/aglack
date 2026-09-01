/**
 * Client for rust_gateway's per-workspace agent-seeder proxy
 * (`ANY /workspaces/:id/agent-seeder/*` — see
 * rust_gateway/src/workspaces/agent_seeder_proxy.rs). The gateway checks
 * the id (exists + status === ready) then forwards to that workspace's
 * wrapper. Envelope parsing is apiFetch — same helper as onboarding/workspace.
 *
 * Base URL comes from VITE_GATEWAY_URL via lib/env.ts. Do not call the
 * wrapper's own base URL from this feature.
 */
import { apiFetch } from '@/lib/api'
import { gatewayUrl } from '@/lib/env'
import type { AppliedAgent, ApplySeederResult } from '@/features/agent-seeder/types'

type WireAppliedAgent = {
  agent: string
  display_name: string
  profile_created: boolean
  soul_updated: boolean
  agent_md_updated: boolean
  agent_md_skipped_reason?: string
  skills_seeded: string[]
  tools_seeded: string[]
  mcp_server_configured: boolean
}

type WireApplyResult = {
  applied: WireAppliedAgent[]
}

function agentSeederPath(workspaceId: string, path: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/agent-seeder/${path}`
}

function modeApplyPath(mode: string): string {
  return `${encodeURIComponent(mode)}/apply`
}

function mapAppliedAgent(row: WireAppliedAgent): AppliedAgent {
  return {
    agent: row.agent,
    displayName: row.display_name,
    profileCreated: row.profile_created,
    soulUpdated: row.soul_updated,
    agentMdUpdated: row.agent_md_updated,
    agentMdSkippedReason: row.agent_md_skipped_reason,
    skillsSeeded: row.skills_seeded,
    toolsSeeded: row.tools_seeded,
    mcpServerConfigured: row.mcp_server_configured,
  }
}

/** Apply every agent declared for `mode` in the wrapper's seeder tree
 * (`backend/seeder/modes/<mode>/agents/*`) to this workspace. */
export async function applySeeder(workspaceId: string, mode: string): Promise<ApplySeederResult> {
  const data = await apiFetch<WireApplyResult>(
    gatewayUrl(),
    agentSeederPath(workspaceId, modeApplyPath(mode)),
    { method: 'POST' },
  )
  return { applied: data.applied.map(mapAppliedAgent) }
}
