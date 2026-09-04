import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach } from 'vitest'
import { ChatComposer } from '@/features/chat/components/chat-composer'
import { renderWithClient } from '@/test/utils'
import * as commandsApi from '@/features/commands/api'
import type { CommandBundle, CommandInfo } from '@/features/commands/types'

vi.mock('@/features/commands/api')

const mockedCommandsApi = vi.mocked(commandsApi)

const COMMANDS: CommandInfo[] = [
  {
    name: 'credits',
    description: 'Show remaining credits',
    category: 'agent-runtime',
    aliases: [],
    argsHint: '',
    subcommands: [],
    cliOnly: false,
    gatewayOnly: false,
  },
  {
    name: 'reload-skills',
    description: 'Reload skills',
    category: 'agent-runtime',
    aliases: [],
    argsHint: '',
    subcommands: [],
    cliOnly: false,
    gatewayOnly: false,
  },
  {
    // Real fixture shape from the actual backend registry (see the /loop
    // bug report this test guards against): a listed, non-cliOnly command
    // with no server-side exec handler and no bundle. Before the
    // `unsupported` SlashMatch kind existed, this silently reached
    // onSend and was relayed to the LLM as literal text.
    name: 'loop',
    description: 'Re-run a prompt on a recurring interval in this session',
    category: 'Session',
    aliases: ['proactive'],
    argsHint: '[interval] <prompt> [--times N] [--until <condition>] | status | pause | resume | stop',
    subcommands: [],
    cliOnly: false,
    gatewayOnly: false,
  },
  {
    // Real fixture shape for the /new bug report: a listed command with
    // an EXISTING client-side UI equivalent (the header's own "New chat"
    // button) — must call onNewChat directly, neither onSend (the
    // original bug) nor the generic "not available" unsupported message
    // (a regression this exact fixture would have caused if
    // isLocalNewChatCommand didn't exist).
    name: 'new',
    description: 'Start a new session (fresh session ID + history)',
    category: 'Session',
    aliases: ['reset'],
    argsHint: '[name]',
    subcommands: [],
    cliOnly: false,
    gatewayOnly: false,
  },
]

const BUNDLES: CommandBundle[] = [
  { name: 'review', description: 'Code review bundle', skillCount: 2, source: 'bundle' },
]

beforeEach(() => {
  mockedCommandsApi.listCommands.mockResolvedValue(COMMANDS)
  mockedCommandsApi.listBundles.mockResolvedValue(BUNDLES)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ChatComposer now renders <ModelPicker> in its toolbar (models feature),
// which reads React Query — every render here needs a QueryClientProvider,
// hence renderWithClient instead of plain render.
//
// `onCommandResult` is mocked to actually render the pushed text into the
// DOM (mirroring what `useChat.pushLocalCommandResult` + the real message
// list would do) so tests can assert on visible content with
// `screen.findByText`, without pulling in the full chat transcript
// component — this fixture is the test's own minimal stand-in for "a real
// chat message now shows this," not a re-implementation of the real thing.
function renderComposer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  function Wrapper() {
    const [results, setResults] = useState<{ text: string; errored?: boolean }[]>([])
    return (
      <>
        <div aria-label="command results">
          {results.map((r, i) => (
            <p key={i} data-errored={r.errored ? 'true' : 'false'}>
              {r.text}
            </p>
          ))}
        </div>
        <ChatComposer
          workspaceId="ws-1"
          agent="agent-a"
          sessionId="sess-1"
          disabled={false}
          isStreaming={false}
          onSend={vi.fn()}
          onStop={vi.fn()}
          onCommandResult={(_cmd, text, options) =>
            setResults((prev) => [...prev, { text, errored: options?.errored }])
          }
          {...props}
        />
      </>
    )
  }
  return renderWithClient(<Wrapper />)
}

describe('ChatComposer attachments and voice', () => {
  it('renders attach file and voice input controls', () => {
    renderComposer()

    expect(screen.getByRole('button', { name: /attach file/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /voice input/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled()
  })

  it('opens the hidden file input when attach is clicked', async () => {
    const user = userEvent.setup()
    renderComposer()

    const fileInput = document.querySelector('.chat-composer-file-input') as HTMLInputElement
    const clickSpy = vi.spyOn(fileInput, 'click')

    await user.click(screen.getByRole('button', { name: /attach file/i }))
    expect(clickSpy).toHaveBeenCalled()
  })

  // Regression coverage for Bug 1 ("File attachments are silently
  // non-functional"): before this fix, submitting with an attachment sent
  // only a `[Attached: name]` text placeholder through `onSend(message)` —
  // the real `File` never left this component. Now the real `File[]` must
  // reach `onSend` as its own argument so the caller (`useChat.send`) can
  // actually upload it.
  it('passes the real File objects to onSend instead of a text placeholder', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    renderComposer({ onSend })

    const file = new File(['file contents'], 'report.pdf', { type: 'application/pdf' })
    const fileInput = document.querySelector('.chat-composer-file-input') as HTMLInputElement
    await user.upload(fileInput, file)

    expect(screen.getByText('report.pdf')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^send$/i }))

    expect(onSend).toHaveBeenCalledTimes(1)
    const [text, files] = onSend.mock.calls[0]
    // No placeholder text was fabricated — the real file is a separate arg.
    expect(text).not.toContain('Attached')
    expect(files).toEqual([file])
  })

  it('clears the attachment chip after a successful send', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    renderComposer({ onSend })

    const file = new File(['x'], 'notes.txt', { type: 'text/plain' })
    const fileInput = document.querySelector('.chat-composer-file-input') as HTMLInputElement
    await user.upload(fileInput, file)
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument()
  })
})

describe('ChatComposer slash commands', () => {
  function input() {
    return screen.getByRole('textbox', { name: /message this agent/i })
  }

  it('shows the autocomplete only once / is typed, and hides it for plain text', async () => {
    const user = userEvent.setup()
    renderComposer()

    await user.type(input(), 'hello')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(mockedCommandsApi.listCommands).not.toHaveBeenCalled()

    await user.clear(input())
    await user.type(input(), '/')
    await screen.findByRole('listbox')
    expect(screen.getByRole('option', { name: /\/review/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /\/credits/ })).toBeInTheDocument()
    expect(screen.getByText('Show remaining credits')).toBeInTheDocument()

    await user.type(input(), 'cr')
    expect(screen.queryByRole('option', { name: /\/review/ })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /\/credits/ })).toBeInTheDocument()

    await user.clear(input())
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('fills the input when a suggestion is picked (mouse and keyboard)', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    renderComposer({ onSend })

    await user.type(input(), '/')
    await screen.findByRole('listbox')
    await user.click(screen.getByRole('option', { name: /\/credits/ }))
    expect(input()).toHaveValue('/credits ')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onSend).not.toHaveBeenCalled()

    await user.clear(input())
    await user.type(input(), '/re')
    await screen.findByRole('listbox')
    // Rows: bundles first (/review), then /reload-skills. ArrowDown -> second.
    await user.keyboard('{ArrowDown}{Enter}')
    expect(input()).toHaveValue('/reload-skills ')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('resolves a bundle command and sends the resolved message, not the raw draft', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    mockedCommandsApi.resolveBundleCommand.mockResolvedValue({
      name: 'review',
      source: 'bundle',
      message: 'EXPANDED REVIEW PROMPT',
      loadedSkills: ['a'],
      missingSkills: [],
    })
    renderComposer({ onSend })

    await user.type(input(), '/')
    await screen.findByRole('listbox')
    await user.type(input(), 'review src{Enter}')

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(mockedCommandsApi.resolveBundleCommand).toHaveBeenCalledWith('ws-1', 'agent-a', '/review src')
    expect(onSend).toHaveBeenCalledWith('EXPANDED REVIEW PROMPT')
    expect(mockedCommandsApi.execCommand).not.toHaveBeenCalled()
    expect(input()).toHaveValue('')
  })

  it('runs an exec command locally, pushes its output as a real chat message, and never calls onSend', async () => {
    // Matches upstream Hermes WebUI exactly (`_AGENT_COMMANDS_RUN_ON_WEBUI`
    // branch in static/messages.js): the exec output is pushed as a real
    // assistant chat message via onCommandResult, not a floating banner.
    const user = userEvent.setup()
    const onSend = vi.fn()
    mockedCommandsApi.execCommand.mockResolvedValue({ output: 'Credits remaining: 42' })
    renderComposer({ onSend })

    await user.type(input(), '/')
    await screen.findByRole('listbox')
    await user.type(input(), 'credits ')
    await user.keyboard('{Enter}')

    await screen.findByText('Credits remaining: 42')
    expect(mockedCommandsApi.execCommand).toHaveBeenCalledWith('ws-1', 'agent-a', '/credits')
    expect(onSend).not.toHaveBeenCalled()
    expect(mockedCommandsApi.resolveBundleCommand).not.toHaveBeenCalled()
    expect(input()).toHaveValue('')
  })

  it('runs an exact-match exec command on a SINGLE Enter, no trailing space needed, Discord/Slack-style', async () => {
    // Regression test for the real reported bug: every existing test in
    // this block above either types a trailing space before Enter
    // (sidestepping the dropdown entirely) or deliberately picks via
    // ArrowDown+Enter — none of them typed the bare exact command name
    // with the dropdown still open and pressed Enter ONCE, which is
    // exactly how a real user types. Before this fix, that first Enter
    // was always intercepted as "pick from dropdown" (filled the input
    // with a trailing space, dropdown closed, nothing else visibly
    // happened) — the user then had to press Enter a SECOND time to
    // actually run it, which looked indistinguishable from "commands
    // don't work" if they only ever pressed Enter once.
    const user = userEvent.setup()
    const onSend = vi.fn()
    mockedCommandsApi.execCommand.mockResolvedValue({ output: 'Credits remaining: 42' })
    renderComposer({ onSend })

    await user.type(input(), '/credits')
    await screen.findByRole('listbox')
    await user.keyboard('{Enter}')

    await screen.findByText('Credits remaining: 42')
    expect(mockedCommandsApi.execCommand).toHaveBeenCalledWith('ws-1', 'agent-a', '/credits')
    expect(onSend).not.toHaveBeenCalled()
    expect(input()).toHaveValue('')
  })

  it('shows "not available" for a recognized command with no exec handler, never sends it as a chat message', async () => {
    // Real, reported bug: `/loop` (a genuine registry command,
    // `cli_only: false`, no bundle, no exec handler) was silently relayed
    // to the LLM as literal chat text instead of being refused. Discord/
    // Slack never post an unsupported slash command as a plain message.
    const user = userEvent.setup()
    const onSend = vi.fn()
    renderComposer({ onSend })

    await user.type(input(), '/loop')
    await screen.findByRole('listbox')
    await user.keyboard('{Enter}')

    await screen.findByText(/\/loop is not available from this chat/i)
    expect(onSend).not.toHaveBeenCalled()
    expect(mockedCommandsApi.execCommand).not.toHaveBeenCalled()
    expect(mockedCommandsApi.resolveBundleCommand).not.toHaveBeenCalled()

    // The send button must not stay disabled forever after this —
    // isResolvingCommand has to be reset on the unsupported path too.
    await user.clear(input())
    await user.type(input(), 'hello')
    expect(screen.getByRole('button', { name: /^send$/i })).not.toBeDisabled()
  })

  it('runs /new (and its alias /reset) via onNewChat, never as chat text and never as "unavailable"', async () => {
    // Real, reported bug: `/new` was refused as `unsupported` even though
    // this webui already has an equivalent action (the header's own "New
    // chat" button). Must call onNewChat directly — not onSend (the
    // original /loop-class bug), not the "not available" message (which
    // would be actively wrong here, unlike for /loop, since the
    // capability genuinely exists in this app).
    const user = userEvent.setup()
    const onSend = vi.fn()
    const onNewChat = vi.fn()
    renderComposer({ onSend, onNewChat })

    await user.type(input(), '/new')
    await screen.findByRole('listbox')
    await user.keyboard('{Enter}')

    expect(onNewChat).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByText(/is not available from this chat/i)).not.toBeInTheDocument()
    expect(input()).toHaveValue('')

    // Alias also resolves to the same action.
    await user.type(input(), '/reset')
    await screen.findByRole('listbox')
    await user.keyboard('{Enter}')
    expect(onNewChat).toHaveBeenCalledTimes(2)
  })

  it('refuses /new with a clear message while a turn is streaming, without calling onNewChat', async () => {
    // Mirrors the header "New chat" button's own disabled={isStreaming}
    // — newChat() itself already no-ops mid-stream, but a silent no-op
    // here would look identical to the ORIGINAL bug (nothing visibly
    // happens on Enter).
    const user = userEvent.setup()
    const onNewChat = vi.fn()
    renderComposer({ onNewChat, isStreaming: true })

    await user.type(input(), '/new')
    await screen.findByRole('listbox')
    await user.keyboard('{Enter}')

    await screen.findByText(/can't start a new chat while a message is still streaming/i)
    expect(onNewChat).not.toHaveBeenCalled()
  })

  it('still requires picking (not a direct submit) for a genuinely ambiguous prefix', async () => {
    // The other half of the same fix: `/re` matches both `/review`
    // (bundle) and `/reload-skills` (command) in this test's fixtures —
    // Enter here must NOT guess which one the user meant. It should pick
    // the keyboard-highlighted row (unchanged existing behavior), never
    // submit blindly.
    const user = userEvent.setup()
    const onSend = vi.fn()
    renderComposer({ onSend })

    await user.type(input(), '/re')
    await screen.findByRole('listbox')
    await user.keyboard('{Enter}')

    expect(input()).toHaveValue('/review ')
    expect(onSend).not.toHaveBeenCalled()
    expect(mockedCommandsApi.execCommand).not.toHaveBeenCalled()
    expect(mockedCommandsApi.resolveBundleCommand).not.toHaveBeenCalled()
  })

  it('waits for a still-loading command list before submitting, never misroutes a fast-typed command to onSend', async () => {
    // Regression test for a real, reproduced bug: typing a full recognized
    // command and hitting Enter fast enough to beat listCommands'/
    // listBundles' own fetch (kicked off by the first `/` keystroke) used
    // to silently fall through to a normal chat message instead of
    // running the command — a synchronous match against the
    // still-empty/loading list found nothing. Deliberately does NOT
    // `await screen.findByRole('listbox')` first (every other test in
    // this block does, which is exactly why this race was never caught)
    // — submits the instant typing finishes, while the mocked fetch is
    // still pending.
    const user = userEvent.setup()
    const onSend = vi.fn()
    let resolveCommands!: (value: CommandInfo[]) => void
    mockedCommandsApi.listCommands.mockReturnValue(
      new Promise((resolve) => {
        resolveCommands = resolve
      }),
    )
    renderComposer({ onSend })

    await user.type(input(), '/reload-skills')
    await user.keyboard('{Enter}')

    // Give the (unresolved) submit a moment to run past any synchronous
    // work — it must be BLOCKED on the pending fetch, not already having
    // decided "not a command" and called onSend.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onSend).not.toHaveBeenCalled()
    expect(mockedCommandsApi.execCommand).not.toHaveBeenCalled()

    // Now let the fetch resolve — the pending submit must pick up the
    // REAL data and run it as an exec command, not have already given up.
    mockedCommandsApi.execCommand.mockResolvedValue({ output: 'Skills reloaded' })
    resolveCommands(COMMANDS)

    await screen.findByText('Skills reloaded')
    expect(mockedCommandsApi.execCommand).toHaveBeenCalledWith('ws-1', 'agent-a', '/reload-skills')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('falls through to plain onSend for an unrecognized /text', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    renderComposer({ onSend })

    await user.type(input(), '/')
    await screen.findByRole('listbox')
    await user.type(input(), 'unknown-thing arg{Enter}')

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend).toHaveBeenCalledWith('/unknown-thing arg', undefined)
    expect(mockedCommandsApi.execCommand).not.toHaveBeenCalled()
    expect(mockedCommandsApi.resolveBundleCommand).not.toHaveBeenCalled()
  })
})

describe('ChatComposer model picker placement', () => {
  it('renders the model picker inside the message box toolbar, next to attach/voice', () => {
    renderComposer()

    // The picker trigger ("Add model" when nothing is ticked yet) lives in
    // the same toolbar row as Attach file / Voice input, not in the thread
    // header above the transcript.
    const attachButton = screen.getByRole('button', { name: /attach file/i })
    const pickerTrigger = screen.getByRole('button', { name: /add model/i })
    expect(attachButton.parentElement).toBe(pickerTrigger.closest('.relative')?.parentElement)
  })
})
