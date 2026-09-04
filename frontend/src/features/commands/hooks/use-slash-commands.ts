import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listBundles, listCommands } from '@/features/commands/api'
import { queryKeys } from '@/lib/query-keys'
import type { CommandBundle, CommandInfo } from '@/features/commands/types'

/** Filtered lists for the dropdown, kept as their original types so
 * `CommandAutocomplete` renders bundle-vs-command distinctly. */
export type SlashSuggestions = {
  commands: CommandInfo[]
  bundles: CommandBundle[]
}

/** What `submit` should do with a `/text` draft — bundles are decided from
 * the fetched bundle list alone; `exec` additionally requires
 * `isExecEligible` (see its own doc comment for why a blanket "any
 * non-cliOnly command" match would be wrong). `unsupported` is the third,
 * previously-missing case: a name that IS a real, listed command
 * (`GET /commands` returned it, `cli_only: false`) but has no server-side
 * exec handler and is not a bundle — e.g. `/loop`, `/model`, `/goal`.
 * Before this existed, `matchAgainst` returning `null` for these was
 * indistinguishable from "not a command at all," so the composer sent
 * them as a literal chat message — a real, reported bug: `/loop` got
 * relayed to the LLM as English text, which then tried to guess what the
 * user meant instead of the command simply not running. Discord/Slack
 * never silently sends an unrecognized-as-runnable slash command as a
 * plain message either — same rule here. */
export type SlashMatch =
  | { kind: 'bundle'; name: string; bundle: CommandBundle }
  | { kind: 'exec'; name: string; command: CommandInfo }
  | { kind: 'unsupported'; name: string; command: CommandInfo }
  | { kind: 'local-new-chat'; name: string; command: CommandInfo }
  | { kind: 'local-stop'; name: string; command: CommandInfo }
  | { kind: 'local-compress'; name: string; command: CommandInfo; focusTopic?: string }

const EMPTY: SlashSuggestions = { commands: [], bundles: [] }

/** `/foo bar` -> `foo`; `/` -> ``; anything not starting with `/` -> null. */
export function parseSlashName(draft: string): string | null {
  if (!draft.startsWith('/')) return null
  const [head] = draft.slice(1).split(/\s+/, 1)
  return head ?? ''
}

/** `/foo bar baz` -> `bar baz`; `/foo` -> `''`. Only meaningful once the
 * caller already knows `draft` starts with `/` (see `parseSlashName`) —
 * used for commands whose args carry real meaning client-side (e.g.
 * `/compress <focus topic>`), unlike most local commands which ignore
 * everything after the name. */
function parseSlashArgs(draft: string): string {
  if (!draft.startsWith('/')) return ''
  const rest = draft.slice(1).split(/\s+/).slice(1).join(' ')
  return rest.trim()
}

function matchesPrefix(name: string, prefix: string): boolean {
  return name.toLowerCase().startsWith(prefix.toLowerCase())
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** The exact, narrow set `execute_agent_command` (backend
 * `api/commands.py`) actually runs — everything else `GET /commands`'s
 * registry lists (`/model`, `/help`, `/clear`, `/status`, ...) is a
 * CLI/chat-side behavior with NO server-side exec handler and must fall
 * through to a normal chat message, never an exec attempt (a plain
 * `/model gpt-4` submitted as an exec call would 404 instead of being
 * sent). Hardcoded rather than inferred from any `CommandInfo` field —
 * there is no reliable field that says "this one execs"; guessing from
 * `category`/`cliOnly` risks exactly that silent misfire. Keep in sync
 * with `_ALLOWED_AGENT_COMMANDS` in `backend/upstream/api/commands.py` if
 * that set ever changes. */
const AGENT_EXEC_COMMAND_NAMES = new Set(['reload-mcp', 'reload-skills', 'codex-runtime', 'credits'])

/** A dynamically-registered plugin command (`list_commands()` tags these
 * `category: 'Plugin'` — see backend `api/commands.py`) ALSO runs through
 * `POST /exec` (falls to `execute_plugin_command` there) — this set is
 * open-ended, unlike the fixed agent-runtime set above, so it's read from
 * the field instead of hardcoded. */
function isExecEligible(command: CommandInfo): boolean {
  return AGENT_EXEC_COMMAND_NAMES.has(command.name.toLowerCase()) || command.category === 'Plugin'
}

/** Command names (and their real registry aliases) with an EXISTING
 * client-side UI equivalent this app already ships — checked BEFORE
 * `isExecEligible`, since these never touch `/api/commands/exec` at all
 * (the backend has no handler for them and never will; they are pure
 * client actions). `/new` (alias `/reset`) is a real, reported case: the
 * command genuinely exists (`GET /commands`, `cli_only: false`, category
 * `Session`) and this webui already has its own "New chat" button
 * (`workspace-chat.tsx`'s `newChat()`/`chat.newChat()`) that does exactly
 * what the command name promises — refusing it as `unsupported` would be
 * wrong, not just unhelpful, since the capability genuinely exists here,
 * just not as a backend call. Scoped deliberately to ONLY `/new` for now
 * — other Session-category commands (`/resume`, `/branch`, `/sessions`,
 * `/title`) have no existing 1:1 UI action in this app yet; wiring those
 * is new feature scope, not this fix, and they correctly stay
 * `unsupported` until a real UI exists for them. */
const LOCAL_NEW_CHAT_COMMAND_NAMES = new Set(['new', 'reset'])

function isLocalNewChatCommand(command: CommandInfo): boolean {
  return (
    LOCAL_NEW_CHAT_COMMAND_NAMES.has(command.name.toLowerCase()) ||
    command.aliases.some((a) => LOCAL_NEW_CHAT_COMMAND_NAMES.has(a.toLowerCase()))
  )
}

const LOCAL_STOP_COMMAND_NAMES = new Set(['stop', 'cancel', 'interrupt'])

function isLocalStopCommand(command: CommandInfo): boolean {
  return (
    LOCAL_STOP_COMMAND_NAMES.has(command.name.toLowerCase()) ||
    command.aliases.some((a) => LOCAL_STOP_COMMAND_NAMES.has(a.toLowerCase()))
  )
}

/** `/compress` (alias `/compact`) — same "real command, real existing
 * capability, just not via /api/commands/exec" case as `/new` above.
 * Upstream's own `cmdCompress`/`cmdCompact` (`backend/upstream/static/
 * commands.js`) both call `_runManualCompression`, which hits
 * `POST /api/session/compress/start` + polls `GET
 * /api/session/compress/status` — already reachable through this app's
 * existing chat proxy (`chat/api.ts`'s `startCompression`/
 * `getCompressionStatus`; no new gateway/wrapper work needed), so this is
 * wired the same way `/new` is: a real client-side action, never sent as
 * chat text, never refused as unavailable. */
const LOCAL_COMPRESS_COMMAND_NAMES = new Set(['compress', 'compact'])

function isLocalCompressCommand(command: CommandInfo): boolean {
  return (
    LOCAL_COMPRESS_COMMAND_NAMES.has(command.name.toLowerCase()) ||
    command.aliases.some((a) => LOCAL_COMPRESS_COMMAND_NAMES.has(a.toLowerCase()))
  )
}

/**
 * Fetches this agent's command + bundle lists once per (workspaceId,
 * agent) pair (long `staleTime` — the list only changes when skills are
 * reloaded, and `/reload-skills` itself is one of these commands), and
 * derives from `draft` everything the composer needs: whether slash mode
 * is active, the prefix-filtered suggestions, and an exact-name matcher
 * for the submit path.
 *
 * Fetch is gated on `enabled` (draft starts with `/`) the same way
 * `useModelCatalog` gates on `open` — no network until the user actually
 * reaches for a command. React Query keeps the result cached across
 * drafts, so the second `/` is instant.
 */
export function useSlashCommands(workspaceId: string | undefined, agent: string | null, draft: string) {
  const queryClient = useQueryClient()
  const slashName = parseSlashName(draft)
  const isSlashActive = slashName !== null
  const enabled = Boolean(workspaceId && agent) && isSlashActive

  const commandsQueryOptions = {
    queryKey: queryKeys.commands.list(workspaceId ?? '', agent ?? ''),
    queryFn: () => listCommands(workspaceId as string, agent as string),
    staleTime: 5 * 60_000,
  }
  const bundlesQueryOptions = {
    queryKey: queryKeys.commands.bundles(workspaceId ?? '', agent ?? ''),
    queryFn: () => listBundles(workspaceId as string, agent as string),
    staleTime: 5 * 60_000,
  }

  const commandsQuery = useQuery({ ...commandsQueryOptions, enabled })
  const bundlesQuery = useQuery({ ...bundlesQueryOptions, enabled })

  const commands = commandsQuery.data ?? EMPTY.commands
  const bundles = bundlesQuery.data ?? EMPTY.bundles

  // Only while the user is still typing the command NAME (no space yet)
  // — once they start typing args the dropdown gets out of the way.
  const typingName = isSlashActive && !/\s/.test(draft)

  const suggestions = useMemo<SlashSuggestions>(() => {
    if (!typingName || slashName === null) return EMPTY
    return {
      bundles: bundles.filter((b) => matchesPrefix(b.name, slashName)),
      commands: commands.filter(
        (c) =>
          !c.cliOnly &&
          (matchesPrefix(c.name, slashName) || c.aliases.some((a) => matchesPrefix(a, slashName))),
      ),
    }
  }, [typingName, slashName, bundles, commands])

  /** True when `slashName` is a COMPLETE, unambiguous name (or alias) —
   * either the only prefix match left, or an exact case-insensitive
   * equality — for a command or bundle. Drives the same "Enter submits
   * directly instead of just filling the input" behavior Discord/Slack
   * slash commands use: once there is nothing left to disambiguate,
   * Enter should not require a second press just to run what's already
   * fully typed. `false` while genuinely ambiguous (e.g. `/re` matching
   * both `reload-mcp` and `reload-skills`) so Enter still narrows via the
   * dropdown instead of guessing which one the user meant. */
  const isExactMatch = useMemo(() => {
    if (!typingName || slashName === null || slashName === '') return false
    const nameMatches = (name: string) => sameName(name, slashName)
    const bundleHit = bundles.some((b) => nameMatches(b.name))
    const commandHit = commands.some(
      (c) => !c.cliOnly && (nameMatches(c.name) || c.aliases.some(nameMatches)),
    )
    if (bundleHit || commandHit) return true
    // Not an exact hit itself, but if it's the ONLY prefix match across
    // both lists, treat it the same way — one candidate left is just as
    // unambiguous as an exact name.
    return suggestions.commands.length + suggestions.bundles.length === 1
  }, [typingName, slashName, bundles, commands, suggestions])

  /** Exact-name lookup for the submit path, against WHATEVER command/
   * bundle lists are given (see `matchCommandAsync` — never called
   * against stale/still-loading data). Bundles win over plain commands on
   * a name clash (a bundle produces a real chat message; an exec never
   * does — the safer default is the one that still sends). A command
   * name that exists in the registry but isn't exec-eligible returns
   * `unsupported`, NOT `null` — `null` must mean "not a recognized
   * command name at all" (falls through to plain chat), never "recognized
   * but this app can't run it" (must NOT silently become a chat message
   * — see `SlashMatch`'s own doc comment for the `/loop` bug this fixes).
   * cliOnly commands are the one exception that still falls through to
   * `null`: they're CLI-terminal-only concepts (e.g. a display-only
   * toggle) that a webui user typing plain text past an unrecognized `/`
   * word has a real chance of actually meaning as a literal sentence
   * (rare in practice, but `cli_only` commands were never surfaced in the
   * dropdown either — see `suggestions`' own `!c.cliOnly` filter — so
   * treating them identically to "unknown" here is consistent, not a new
   * special case). */
  function matchAgainst(
    text: string,
    candidateCommands: CommandInfo[],
    candidateBundles: CommandBundle[],
  ): SlashMatch | null {
    const name = parseSlashName(text.trim())
    if (!name) return null
    const bundle = candidateBundles.find((b) => sameName(b.name, name))
    if (bundle) return { kind: 'bundle', name: bundle.name, bundle }
    const command = candidateCommands.find(
      (c) =>
        !c.cliOnly && (sameName(c.name, name) || c.aliases.some((a) => sameName(a, name))),
    )
    if (!command) return null
    if (isLocalNewChatCommand(command)) return { kind: 'local-new-chat', name: command.name, command }
    if (isLocalStopCommand(command)) return { kind: 'local-stop', name: command.name, command }
    if (isLocalCompressCommand(command)) {
      const focusTopic = parseSlashArgs(text.trim())
      return { kind: 'local-compress', name: command.name, command, focusTopic: focusTopic || undefined }
    }
    if (isExecEligible(command)) return { kind: 'exec', name: command.name, command }
    return { kind: 'unsupported', name: command.name, command }
  }

  /** Synchronous lookup against whatever is ALREADY in React state right
   * now — correct only when the caller has already confirmed the lists
   * are loaded (`!isLoading`). Kept for the dropdown/suggestions path,
   * which only ever renders after data exists. Submitting a fast-typed
   * command must NOT use this — see `matchCommandAsync`. */
  function matchCommand(text: string): SlashMatch | null {
    return matchAgainst(text, commands, bundles)
  }

  /** The submit-time matcher: a real, reproduced bug (not hypothetical)
   * was a user typing `/reload-skills` and hitting Enter before the
   * command list's fetch (kicked off by the FIRST `/` keystroke) had
   * resolved — `matchCommand` above would read the still-empty `commands`
   * array from THIS render's closure, find nothing, and silently fall
   * through to a normal chat message instead of running the command.
   * `queryClient.ensureQueryData` fetches only if not already
   * fresh/cached (same cache key as the `useQuery` calls above, so this
   * never duplicates an in-flight request — it just awaits it) and
   * returns the REAL resolved data directly, bypassing the stale render
   * closure entirely. Always await this before deciding a `/`-prefixed
   * submit is "not a recognized command." */
  async function matchCommandAsync(text: string): Promise<SlashMatch | null> {
    if (!workspaceId || !agent) return null
    const [freshCommands, freshBundles] = await Promise.all([
      queryClient.ensureQueryData(commandsQueryOptions),
      queryClient.ensureQueryData(bundlesQueryOptions),
    ])
    return matchAgainst(text, freshCommands, freshBundles)
  }

  /** Text the input should hold after picking a suggestion: `/name ` with
   * a trailing space so the user can go straight into args (and so the
   * dropdown closes — see `typingName`). */
  function selectCommand(name: string): string {
    return `/${name} `
  }

  return {
    isSlashActive,
    suggestions,
    hasSuggestions: suggestions.commands.length + suggestions.bundles.length > 0,
    isExactMatch,
    matchCommand,
    matchCommandAsync,
    selectCommand,
    isLoading: enabled && (commandsQuery.isPending || bundlesQuery.isPending),
  }
}
