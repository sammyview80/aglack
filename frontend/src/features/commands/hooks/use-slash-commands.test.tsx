import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createTestQueryClient } from '@/test/utils'
import { parseSlashName, useSlashCommands } from '@/features/commands/hooks/use-slash-commands'
import * as api from '@/features/commands/api'
import type { CommandBundle, CommandInfo } from '@/features/commands/types'

vi.mock('@/features/commands/api')

const mockedApi = vi.mocked(api)

const COMMANDS: CommandInfo[] = [
  {
    name: 'reload-skills',
    description: 'Reload skills',
    category: 'agent-runtime',
    aliases: ['rs'],
    argsHint: '',
    subcommands: [],
    cliOnly: false,
    gatewayOnly: false,
  },
  {
    name: 'credits',
    description: 'Show credits',
    category: 'agent-runtime',
    aliases: [],
    argsHint: '',
    subcommands: [],
    cliOnly: false,
    gatewayOnly: false,
  },
  {
    name: 'quit',
    description: 'Exit the CLI',
    category: 'cli',
    aliases: [],
    argsHint: '',
    subcommands: [],
    cliOnly: true,
    gatewayOnly: false,
  },
  {
    // Regression fixture: a plain built-in like `/model` — NOT cliOnly (it
    // is genuinely usable from the webui, just not exec-able server-side),
    // NOT in the agent-runtime allowlist, NOT a plugin. Before the
    // isExecEligible fix, `!cliOnly` alone made this match as `kind:
    // 'exec'`, so submitting `/model gpt-4` would 404 instead of sending
    // the text as a normal chat message.
    name: 'model',
    description: 'Switch the active model',
    category: 'cli',
    aliases: [],
    argsHint: '<model-id>',
    subcommands: [],
    cliOnly: false,
    gatewayOnly: false,
  },
  {
    name: 'my-plugin-cmd',
    description: 'A dynamically registered plugin command',
    category: 'Plugin',
    aliases: [],
    argsHint: '',
    subcommands: [],
    cliOnly: false,
    gatewayOnly: false,
  },
]

const BUNDLES: CommandBundle[] = [
  { name: 'review', description: 'Code review bundle', skillCount: 3, source: 'bundle' },
]

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
}

beforeEach(() => {
  mockedApi.listCommands.mockResolvedValue(COMMANDS)
  mockedApi.listBundles.mockResolvedValue(BUNDLES)
})

afterEach(() => vi.clearAllMocks())

describe('parseSlashName', () => {
  it('extracts the command name and ignores args', () => {
    expect(parseSlashName('/review src/')).toBe('review')
    expect(parseSlashName('/')).toBe('')
    expect(parseSlashName('hello')).toBeNull()
  })
})

describe('useSlashCommands', () => {
  it('does not fetch until the draft starts with /', () => {
    const { result } = renderHook(() => useSlashCommands('ws-1', 'agent-a', 'hello'), { wrapper })
    expect(result.current.isSlashActive).toBe(false)
    expect(mockedApi.listCommands).not.toHaveBeenCalled()
    expect(mockedApi.listBundles).not.toHaveBeenCalled()
  })

  it('fetches once on / and filters commands + bundles by prefix, hiding cliOnly', async () => {
    const { result, rerender } = renderHook(
      ({ draft }: { draft: string }) => useSlashCommands('ws-1', 'agent-a', draft),
      { wrapper, initialProps: { draft: '/' } },
    )
    await waitFor(() => expect(result.current.hasSuggestions).toBe(true))
    expect(mockedApi.listCommands).toHaveBeenCalledWith('ws-1', 'agent-a')
    expect(mockedApi.listBundles).toHaveBeenCalledWith('ws-1', 'agent-a')
    // cliOnly `quit` excluded; everything else listed (the dropdown shows
    // every non-cliOnly command, including plain CLI ones like `/model` —
    // only the SUBMIT path (matchCommand, tested below) restricts which
    // of these actually exec).
    expect(result.current.suggestions.commands.map((c) => c.name)).toEqual([
      'reload-skills',
      'credits',
      'model',
      'my-plugin-cmd',
    ])
    expect(result.current.suggestions.bundles.map((b) => b.name)).toEqual(['review'])

    rerender({ draft: '/re' })
    expect(result.current.suggestions.commands.map((c) => c.name)).toEqual(['reload-skills'])
    expect(result.current.suggestions.bundles.map((b) => b.name)).toEqual(['review'])

    // Alias prefix matches too.
    rerender({ draft: '/rs' })
    expect(result.current.suggestions.commands.map((c) => c.name)).toEqual(['reload-skills'])

    // Once args start, the dropdown has nothing to show.
    rerender({ draft: '/review src' })
    expect(result.current.hasSuggestions).toBe(false)
    expect(result.current.isSlashActive).toBe(true)

    expect(mockedApi.listCommands).toHaveBeenCalledTimes(1)
  })

  it('matchCommand resolves bundle vs exec vs unknown from the fetched lists', async () => {
    const { result } = renderHook(() => useSlashCommands('ws-1', 'agent-a', '/'), { wrapper })
    await waitFor(() => expect(result.current.hasSuggestions).toBe(true))

    expect(result.current.matchCommand('/review please')).toMatchObject({ kind: 'bundle', name: 'review' })
    expect(result.current.matchCommand('/credits')).toMatchObject({ kind: 'exec', name: 'credits' })
    expect(result.current.matchCommand('/rs')).toMatchObject({ kind: 'exec', name: 'reload-skills' })
    expect(result.current.matchCommand('/quit')).toBeNull()
    expect(result.current.matchCommand('/nope')).toBeNull()
    expect(result.current.matchCommand('plain text')).toBeNull()
  })

  it('never treats a plain non-exec built-in (e.g. /model) as an exec match — returns unsupported, not null', async () => {
    // Regression test for the isExecEligible fix, updated for the
    // `unsupported` kind: `/model` is not cliOnly, not in the
    // agent-runtime allowlist, not a plugin — it must never be
    // `{kind: 'exec'}` (which would 404 against the backend's real
    // _ALLOWED_AGENT_COMMANDS check). It must ALSO never be `null` — an
    // earlier version of this fix returned null here, which the composer
    // could not tell apart from "not a command at all" and silently sent
    // `/model gpt-4` as a literal chat message (the real `/loop` bug
    // report this `unsupported` kind exists to fix). A recognized,
    // non-executable command must surface as `unsupported` so the
    // composer shows why it can't run instead of sending it.
    const { result } = renderHook(() => useSlashCommands('ws-1', 'agent-a', '/'), { wrapper })
    await waitFor(() => expect(result.current.hasSuggestions).toBe(true))

    expect(result.current.matchCommand('/model gpt-4')).toMatchObject({
      kind: 'unsupported',
      name: 'model',
    })
  })

  it('treats a dynamically-registered plugin command (category: Plugin) as exec-eligible', async () => {
    const { result } = renderHook(() => useSlashCommands('ws-1', 'agent-a', '/'), { wrapper })
    await waitFor(() => expect(result.current.hasSuggestions).toBe(true))

    expect(result.current.matchCommand('/my-plugin-cmd')).toMatchObject({
      kind: 'exec',
      name: 'my-plugin-cmd',
    })
  })

  it('selectCommand yields the filled draft with a trailing space', () => {
    const { result } = renderHook(() => useSlashCommands('ws-1', 'agent-a', '/'), { wrapper })
    expect(result.current.selectCommand('review')).toBe('/review ')
  })
})
