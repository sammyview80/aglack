import { useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react'
import { Mic, Paperclip, Square, X } from 'lucide-react'
import { chatUi } from '@/features/chat/chat-ui'
import { useSpeechInput } from '@/features/chat/components/use-speech-input'
import { cn } from '@/lib/utils'

export function ChatComposer({
  disabled,
  isStreaming,
  onSend,
  onStop,
  onAttachFiles,
}: {
  disabled?: boolean
  isStreaming: boolean
  onSend: (text: string) => void
  onStop: () => void
  onAttachFiles?: (files: File[]) => void
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
    const attachmentNote =
      attachments.length > 0 ? `[Attached: ${attachments.map((f) => f.name).join(', ')}]` : ''
    const message = text || attachmentNote
    if (!message || disabled) return
    if (attachments.length > 0) {
      onAttachFiles?.(attachments)
    }
    onSend(message)
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
      <div className={chatUi.composerBody}>
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
      </div>

      <div className={chatUi.composerToolbar}>
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
          className={chatUi.composerTool}
          aria-label="Attach file"
          title="Attach file"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={18} />
        </button>
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
        <span className={chatUi.composerHint}>Shift + Return for new line</span>
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
          >
            Send
          </button>
        )}
      </div>
    </form>
  )
}
