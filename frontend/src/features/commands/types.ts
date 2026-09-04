/** camelCase DTOs for rust_gateway's per-workspace commands proxy
 * (`ANY /workspaces/:id/commands/*` -> the wrapper's native
 * `/api/wrapper/v1/commands/*`). See `api.ts` for the snake_case ->
 * camelCase remap. */

export type CommandInfo = {
  name: string
  description: string
  category: string
  aliases: string[]
  argsHint: string
  subcommands: string[]
  /** Only meaningful inside the Hermes CLI (e.g. terminal-only toggles) —
   * listed for completeness but never executable from this composer. */
  cliOnly: boolean
  /** Only exists on the gateway side (no CLI counterpart). */
  gatewayOnly: boolean
}

export type CommandBundle = {
  name: string
  description: string
  skillCount: number
  source: string
}

export type ResolvedBundleCommand = {
  name: string
  source: string
  /** The expanded prompt text that replaces the raw `/name` draft as the
   * actual chat message. */
  message: string
  loadedSkills: string[]
  missingSkills: string[]
}

export type ExecCommandResult = {
  output: string
}
