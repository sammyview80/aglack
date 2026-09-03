import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowUp, Mic, Plus, Square, X } from 'lucide-react'
import { chatUi } from '@/features/chat/chat-ui'
import { useSpeechInput } from '@/features/chat/components/use-speech-input'
import { ModelPicker } from '@/features/models/components/model-picker'
import { cn } from '@/lib/utils'

export function ChatComposer({
  workspaceId,
  agent,
  sessionId,
  disabled,
  isStreaming,
  onSend,
  onStop,
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

  function submit() {
    const text = draft.trim()
    if (!text && attachments.length === 0) return
    if (disabled) return
    onSend(text, attachments.length > 0 ? attachments : undefined)
    setDraft('')
    setAttachments([])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    submit()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
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
            disabled={disabled || !canSend}
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
