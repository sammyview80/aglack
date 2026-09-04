import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowUp, Mic, Plus, Square, X } from 'lucide-react'
import { chatUi } from '@/features/chat/chat-ui'
import { useSpeechInput } from '@/features/chat/components/use-speech-input'
import { ModelPicker } from '@/features/models/components/model-picker'
import { execCommand, resolveBundleCommand } from '@/features/commands/api'
import {
  CommandAutocomplete,
  suggestionRows,
  useCommandAutocompleteKeys,
} from '@/features/commands/components/command-autocomplete'
import { useSlashCommands } from '@/features/commands/hooks/use-slash-commands'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'

export function ChatComposer({
  workspaceId,
  agent,
  sessionId,
  disabled,
  isStreaming,
  onSend,
  onStop,
  onNewChat,
  onCommandResult,
}: {
  workspaceId: string
  agent: string | null
  sessionId: string | null
  disabled?: boolean
  isStreaming: boolean
  /**
   * `files`, when present, are REAL attachments that `onSend` uploads to
   * Hermes' own attachment inbox and references in the turn (see
   * `useChat.send` and `rust_gateway/docs/hermes-chat-wire-contract.md`
   * §1.1) — this composer no longer fabricates a `[Attached: ...]` text
   * placeholder for a file that was never actually sent anywhere (that was
   * the bug: real file picker + chips + remove button, wired to nothing).
   */
  onSend: (text: string, files?: File[]) => void
  onStop: () => void
  /** Backs `/new`/`/reset` (see `use-slash-commands.ts`'s
   * `isLocalNewChatCommand`) — the SAME action the header's own "New
   * chat" button already calls (`workspace-chat.tsx`'s local `newChat()`
   * wrapper). Optional only so a caller that has no new-chat concept at
   * all (none exists in this codebase today, but kept honest about the
   * dependency rather than assuming every composer usage has one) can
   * omit it; `/new` then falls back to the same "not available" message
   * as `unsupported` — see `submit()`. */
  onNewChat?: () => void
  /**
   * Pushes a slash command's echo + result as a REAL chat message pair
   * (`useChat.pushLocalCommandResult`) — matches upstream Hermes WebUI's
   * own command interception EXACTLY (`backend/upstream/static/
   * messages.js`'s slash-command intercept block pushes
   * `{role:'user',...}` then `{role:'assistant',...}` into `S.messages`
   * directly, never a floating toast/banner, for bundle resolves, exec
   * output, and cli_only/unsupported explanations alike). Optional for
   * the same reason as `onNewChat`; without it, command results have
   * nowhere to render at all (silently dropped) rather than guessing at
   * a fallback UI — a caller that wants command support MUST provide
   * this.
   */
  onCommandResult?: (
    commandText: string,
    resultText: string,
    options?: { echoCommand?: boolean; errored?: boolean },
  ) => void
}) {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const speech = useSpeechInput((text) => {
    setDraft((prev) => (prev ? `${prev} ${text}` : text))
    inputRef.current?.focus()
  })

  const canSend = draft.trim().length > 0 || attachments.length > 0

  // Slash commands — commands feature, kept out of chat's own send/state
  // logic the same way ModelPicker is: this only decides WHAT text reaches
  // the unchanged `onSend`, or short-circuits it for a command whose
  // result is pushed as a chat message via `onCommandResult` instead.
  const slash = useSlashCommands(workspaceId, agent, draft)
  // Escape hides the dropdown until the draft changes again.
  const [autocompleteDismissed, setAutocompleteDismissed] = useState(false)
  useEffect(() => setAutocompleteDismissed(false), [draft])
  const rows = suggestionRows(slash.suggestions.commands, slash.suggestions.bundles)
  const autocompleteVisible = slash.hasSuggestions && !autocompleteDismissed && !disabled
  const autocomplete = useCommandAutocompleteKeys(
    autocompleteVisible ? rows.length : 0,
    (index) => pickSuggestion(rows[index]?.name),
    () => setAutocompleteDismissed(true),
  )
  const [isResolvingCommand, setIsResolvingCommand] = useState(false)

  function pickSuggestion(name: string | undefined) {
    if (!name) return
    setDraft(slash.selectCommand(name))
    autocomplete.setActiveIndex(0)
    inputRef.current?.focus()
  }

  function clearDraft() {
    setDraft('')
    setAttachments([])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  /** Pushes a command result as a real chat message pair, or — only if
   * this composer instance was mounted with no `onCommandResult` at all —
   * drops it with a console warning rather than silently vanishing.
   * Mirrors upstream's own unconditional `S.messages.push(...)`; there is
   * no floating-banner fallback anymore (see this component's own JSDoc
   * on `onCommandResult`). */
  function pushResult(commandText: string, resultText: string, errored: boolean) {
    if (onCommandResult) {
      onCommandResult(commandText, resultText, { echoCommand: true, errored })
    } else if (typeof console !== 'undefined') {
      console.warn(
        '[ChatComposer] onCommandResult not provided — command result dropped:',
        resultText,
      )
    }
  }

  async function submit() {
    const text = draft.trim()
    if (!text && attachments.length === 0) return
    if (disabled || isResolvingCommand) return

    // Attachments always ride a real chat turn — a `/command` typed WITH a
    // file attached is treated as plain text so the file is never dropped.
    //
    // `matchCommandAsync` (not the synchronous `matchCommand`) — a real,
    // reproduced bug: typing `/reload-skills` and hitting Enter fast
    // enough could beat the command list's own fetch (kicked off by the
    // first `/` keystroke), so a synchronous match against the
    // still-loading (empty) list silently fell through to a normal chat
    // message instead of running the command. `matchCommandAsync` awaits
    // the real fetch (a no-op await if it already resolved) before
    // deciding, so a `/`-prefixed submit is NEVER decided against stale
    // or still-loading data. `setIsResolvingCommand(true)` up front (not
    // only inside the bundle/exec branches below) so the send button
    // disables immediately for ANY `/`-prefixed attempt, not just ones
    // that already know they're a command.
    let match: Awaited<ReturnType<typeof slash.matchCommandAsync>> = null
    if (attachments.length === 0 && agent && text.startsWith('/')) {
      setIsResolvingCommand(true)
      try {
        match = await slash.matchCommandAsync(text)
      } finally {
        if (!match) setIsResolvingCommand(false)
      }
    }

    if (match?.kind === 'bundle') {
      // Bundle: expand to its real prompt first, then send THAT through the
      // unchanged onSend path — the raw `/name` never reaches the agent.
      // Matches upstream exactly (messages.js's `_bundleCmd` branch):
      // resolve, then fall into the NORMAL send path with the resolved
      // text — no separate command-result message of its own; the
      // resolved prompt's eventual agent reply IS the visible result.
      setIsResolvingCommand(true)
      try {
        const resolved = await resolveBundleCommand(workspaceId, agent as string, text)
        onSend(resolved.message)
        clearDraft()
      } catch (err) {
        pushResult(text, errorMessage(err, `Could not resolve /${match.name}`), true)
        clearDraft()
      } finally {
        setIsResolvingCommand(false)
      }
      return
    }

    if (match?.kind === 'exec') {
      // Agent-runtime command: run it, push its own echo+result message
      // pair — matches upstream's `_AGENT_COMMANDS_RUN_ON_WEBUI` branch
      // exactly (messages.js pushes the typed command as a user message,
      // then the real /api/commands/exec output as an assistant message;
      // never a floating toast).
      setIsResolvingCommand(true)
      try {
        const result = await execCommand(workspaceId, agent as string, text)
        pushResult(text, result.output || `/${match.name} ran with no output.`, false)
        clearDraft()
      } catch (err) {
        pushResult(text, errorMessage(err, `Could not run /${match.name}`), true)
        clearDraft()
      } finally {
        setIsResolvingCommand(false)
      }
      return
    }

    if (match?.kind === 'local-new-chat') {
      // `/new`/`/reset`: a real, reported case distinct from `unsupported`
      // — the command name genuinely exists in the registry AND this
      // webui already has an equivalent action (the header's own "New
      // chat" button, `onNewChat`). Run that directly instead of either
      // sending it as chat text OR wrongly refusing it as unavailable.
      // No backend call at all — this never touches /api/commands/*.
      // Matches upstream's own `cmdNew` (noEcho:true, toast-only feedback,
      // never a chat message) — no `pushResult` call on success, only on
      // the two refusal paths below, where a silent no-op would look
      // identical to the original bug (nothing visibly happens on Enter).
      //
      // isStreaming guard mirrors the header button's own
      // `disabled={chat.isStreaming}` (workspace-chat.tsx) — `newChat()`
      // itself already no-ops while a turn is live
      // (`if (effectiveStreamId) return`).
      setIsResolvingCommand(false)
      clearDraft()
      if (isStreaming) {
        pushResult(text, `Can't start a new chat while a message is still streaming.`, true)
      } else if (onNewChat) {
        onNewChat()
      } else {
        pushResult(
          text,
          `/${match.name} is not available from this chat — it only works in the Hermes CLI/terminal session.`,
          true,
        )
      }
      return
    }

    if (match?.kind === 'unsupported') {
      // A REAL, reported bug: `/loop` (and similarly `/model`, `/goal`,
      // `/status`, ...) is a real listed command with no server-side
      // exec handler — before this branch existed, matchAgainst returned
      // `null` for it (indistinguishable from "not a command"), so it
      // fell through to onSend and was relayed to the LLM as literal
      // text, which then tried to guess what "/loop" meant instead of
      // the command simply not running. Never send a recognized slash
      // command as a chat message — push why it can't run here instead,
      // as a real assistant message (matches upstream's own `cli_only`
      // branch in messages.js, which pushes a canned explanation via
      // `cliOnlyCommandResponse()` as an assistant message, not a toast).
      // Must reset isResolvingCommand itself (the earlier `if (!match)`
      // reset above only fires for a null match — `unsupported` is
      // truthy) or the send button stays disabled forever after hitting
      // one of these.
      setIsResolvingCommand(false)
      clearDraft()
      pushResult(
        text,
        `/${match.name} is not available from this chat — it only works in the Hermes CLI/terminal session.`,
        true,
      )
      return
    }

    // Plain text (or a name with no match in the registry at all) —
    // unchanged send path: this is the one case that genuinely means
    // "not a recognized command," so treating it as a normal chat
    // message is correct, matching the CLI's own graceful degradation.
    onSend(text, attachments.length > 0 ? attachments : undefined)
    clearDraft()
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void submit()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Discord/Slack behavior: Enter on an ALREADY-complete, unambiguous
    // command name (isExactMatch) submits/runs it directly — it does NOT
    // require a first Enter to "pick" (fill with a trailing space, no
    // visible change while the dropdown was still open) and a SECOND
    // Enter to actually run it. That double-Enter requirement was the
    // real reported bug: a user types the full command, presses Enter
    // once, sees nothing obviously happen (the dropdown just closes /
    // the input gets a trailing space), and never realizes a second
    // Enter is needed — indistinguishable from "commands don't work."
    // Enter still means "pick from the list" for a genuinely AMBIGUOUS
    // prefix (isExactMatch false, e.g. `/re` matching two commands) or
    // when arrow keys already moved the highlight to a non-default row.
    const shouldPickInsteadOfSubmit =
      autocompleteVisible && (!slash.isExactMatch || autocomplete.activeIndex !== 0)
    if (shouldPickInsteadOfSubmit && autocomplete.handleKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (autocompleteVisible) {
      // Arrow keys / Escape / Tab still need to reach the dropdown even
      // when Enter itself is being handled as "submit" above.
      autocomplete.handleKeyDown(e)
    }
  }

  function onFilesSelected(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    if (picked.length === 0) return
    setAttachments((prev) => [...prev, ...picked])
    e.target.value = ''
  }

  function removeAttachment(name: string) {
    setAttachments((prev) => prev.filter((f) => f.name !== name))
  }

  return (
    <form className={chatUi.composer} onSubmit={onSubmit}>
      {/* Fades the transcript's last message(s) into the composer's own
       * background instead of a hard border cut. Purely visual — sits
       * above the pill, inside this same relative container. */}
      <div className={chatUi.composerFade} aria-hidden="true" />

      <div className={chatUi.composerPill}>
        <CommandAutocomplete
          query={draft.slice(1)}
          commands={slash.suggestions.commands}
          bundles={slash.suggestions.bundles}
          onSelect={pickSuggestion}
          visible={autocompleteVisible}
          activeIndex={autocomplete.activeIndex}
          onActiveIndexChange={autocomplete.setActiveIndex}
        />
        {attachments.length > 0 ? (
          <div className={chatUi.composerAttachments} aria-label="Attached files">
            {attachments.map((file) => (
              <span className={chatUi.composerAttachmentChip} key={`${file.name}-${file.size}`}>
                {file.name}
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => removeAttachment(file.name)}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          className={chatUi.composerFileInput}
          multiple
          aria-hidden
          tabIndex={-1}
          onChange={onFilesSelected}
        />
        <button
          type="button"
          className={chatUi.composerAttach}
          aria-label="Attach file"
          title="Attach file"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <Plus size={19} />
        </button>

        <input
          ref={inputRef}
          className={chatUi.composerInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message this agent"
          aria-label="Message this agent"
          aria-autocomplete="list"
          aria-expanded={autocompleteVisible}
          disabled={disabled}
        />

        {/* Model shortlist + quick-switch — models feature, kept out of
         * chat's own state/logic entirely (reads localStorage + its own
         * API module). See features/models/components/model-picker.tsx. */}
        <ModelPicker workspaceId={workspaceId} agent={agent} sessionId={sessionId} />
        <button
          type="button"
          className={cn(chatUi.composerTool, speech.listening && chatUi.composerToolActive)}
          aria-label={speech.listening ? 'Stop voice input' : 'Voice input'}
          title={
            speech.supported
              ? speech.listening
                ? 'Stop voice input'
                : 'Voice input'
              : 'Voice input not supported in this browser'
          }
          disabled={disabled || !speech.supported}
          aria-pressed={speech.listening}
          onClick={speech.toggle}
        >
          <Mic size={18} />
        </button>
        {isStreaming ? (
          <button
            type="button"
            className={chatUi.composerStop}
            onClick={onStop}
            aria-label="Stop"
            title="Stop"
          >
            <Square size={15} fill="currentColor" />
          </button>
        ) : (
          <button
            className={chatUi.composerSend}
            type="submit"
            disabled={disabled || !canSend || isResolvingCommand}
            aria-label="Send"
            title="Send"
          >
            <ArrowUp size={18} strokeWidth={2.4} />
          </button>
        )}
      </div>
      {/* <span className={chatUi.composerHint}>Shift + Return for new line</span> */}
    </form>
  )
}
