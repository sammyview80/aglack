/**
 * Client for rust_gateway's per-workspace commands proxy
 * (`ANY /workspaces/:id/commands/*path` -> the wrapper's native
 * `/api/wrapper/v1/commands/*`). Same `{ok,data}` envelope as every other
 * wrapper-native namespace (agent-history, onboarding, agent-seeder), so
 * every call goes through `apiFetch` — unlike `chat/api.ts`, which relays
 * Hermes' own raw bodies and has its own fetch wrapper.
 *
 * `agent` is always sent as `?agent=<name>` on the URL — never in a POST
 * body — matching `chat/api.ts`'s own `?agent=` convention. The gateway
 * still turns it into the `hermes_profile` cookie on the forwarded
 * request (same as chat), though this specific wrapper route never reads
 * that cookie itself — it's a native FastAPI route (see backend
 * `api/v1/commands.py`'s own docstring), which reads `agent` straight off
 * the query string it's forwarded with. One consistent param name either
 * way, so this client doesn't need to know which mechanism actually
 * consumes it server-side.
 *
 * Base URL comes from VITE_GATEWAY_URL via lib/env.ts. Do not call the
 * wrapper's own base URL from this feature.
 */
import { apiFetch } from '@/lib/api'
import { gatewayUrl } from '@/lib/env'
import type {
  CommandBundle,
  CommandInfo,
  ExecCommandResult,
  ResolvedBundleCommand,
} from '@/features/commands/types'

type WireCommandInfo = {
  name: string
  description?: string
  category?: string
  aliases?: string[]
  args_hint?: string
  subcommands?: string[]
  cli_only?: boolean
  gateway_only?: boolean
}

type WireCommandBundle = {
  name: string
  description?: string
  skill_count?: number
  source?: string
}

type WireResolvedBundleCommand = {
  name: string
  source?: string
  message: string
  loaded_skills?: string[]
  missing_skills?: string[]
}

type WireExecCommandResult = { output?: string }

function commandsPath(workspaceId: string, agent: string, path: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return `/workspaces/${encodeURIComponent(workspaceId)}/commands${path}${sep}agent=${encodeURIComponent(agent)}`
}

function mapCommand(row: WireCommandInfo): CommandInfo {
  return {
    name: row.name,
    description: row.description ?? '',
    category: row.category ?? '',
    aliases: row.aliases ?? [],
    argsHint: row.args_hint ?? '',
    subcommands: row.subcommands ?? [],
    cliOnly: row.cli_only === true,
    gatewayOnly: row.gateway_only === true,
  }
}

function mapBundle(row: WireCommandBundle): CommandBundle {
  return {
    name: row.name,
    description: row.description ?? '',
    skillCount: row.skill_count ?? 0,
    source: row.source ?? 'bundle',
  }
}

/** Every slash command the wrapper knows for this agent (`GET /commands`).
 * Wire `data` is a BARE array (`service.list_commands()` returns
 * `list[dict]` directly, not `{commands: [...]}` — confirmed against the
 * real route, not assumed) — do not wrap this in a `{commands}` accessor. */
export async function listCommands(workspaceId: string, agent: string): Promise<CommandInfo[]> {
  const data = await apiFetch<WireCommandInfo[]>(gatewayUrl(), commandsPath(workspaceId, agent, ''))
  return data.map(mapCommand)
}

/** Skill bundles exposed as slash commands (`GET /commands/bundles`). Same
 * bare-array wire shape as `listCommands` — see its doc comment. */
export async function listBundles(workspaceId: string, agent: string): Promise<CommandBundle[]> {
  const data = await apiFetch<WireCommandBundle[]>(
    gatewayUrl(),
    commandsPath(workspaceId, agent, '/bundles'),
  )
  return data.map(mapBundle)
}

/** Expands a `/bundle-name ...` draft into the real prompt text to send as
 * a chat message (`POST /commands/bundles/resolve`). */
export async function resolveBundleCommand(
  workspaceId: string,
  agent: string,
  command: string,
): Promise<ResolvedBundleCommand> {
  const data = await apiFetch<WireResolvedBundleCommand>(
    gatewayUrl(),
    commandsPath(workspaceId, agent, '/bundles/resolve'),
    { method: 'POST', body: JSON.stringify({ command }) },
  )
  return {
    name: data.name,
    source: data.source ?? 'bundle',
    message: data.message,
    loadedSkills: data.loaded_skills ?? [],
    missingSkills: data.missing_skills ?? [],
  }
}

/** Runs an agent-runtime command (e.g. `/reload-skills`) without starting
 * a chat turn (`POST /commands/exec`). */
export async function execCommand(
  workspaceId: string,
  agent: string,
  command: string,
): Promise<ExecCommandResult> {
  const data = await apiFetch<WireExecCommandResult>(
    gatewayUrl(),
    commandsPath(workspaceId, agent, '/exec'),
    { method: 'POST', body: JSON.stringify({ command }) },
  )
  return { output: data.output ?? '' }
}
