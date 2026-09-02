import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'

export function ChatComposer({
  disabled,
  isStreaming,
  onSend,
  onStop,
}: {
  disabled?: boolean
  isStreaming: boolean
  onSend: (text: string) => void
  onStop: () => void
}) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function submit() {
    const text = draft.trim()
    if (!text || disabled) return
    onSend(text)
    setDraft('')
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

  return (
    <form className="comment-box chat-composer" onSubmit={onSubmit}>
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Message this agent"
        aria-label="Message this agent"
        disabled={disabled}
      />
      {isStreaming ? (
        <button type="button" className="post-button chat-stop-button" onClick={onStop}>
          <Square size={14} /> Stop
        </button>
      ) : (
        <button className="post-button" type="submit" disabled={disabled || !draft.trim()}>
          <Send size={14} /> Send
        </button>
      )}
    </form>
  )
}
