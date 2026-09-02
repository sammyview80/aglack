import { useState, type FormEvent } from 'react'
import type { ClarifyPrompt as ClarifyPromptType } from '@/features/chat/types'

export function ClarifyPrompt({
  prompt,
  onRespond,
}: {
  prompt: ClarifyPromptType
  onRespond: (response: string, clarifyId?: string) => void
}) {
  const [answer, setAnswer] = useState('')

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = answer.trim()
    if (!trimmed) return
    onRespond(trimmed, prompt.clarifyId)
    setAnswer('')
  }

  return (
    <form className="chat-prompt chat-prompt-clarify" onSubmit={onSubmit}>
      <p className="chat-prompt-title">{prompt.question}</p>
      {prompt.choicesOffered.length > 0 ? (
        <div className="chat-prompt-choices">
          {prompt.choicesOffered.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => onRespond(choice, prompt.clarifyId)}
            >
              {choice}
            </button>
          ))}
        </div>
      ) : null}
      <div className="chat-prompt-answer">
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Type your answer"
          aria-label="Clarify answer"
        />
        <button type="submit" disabled={!answer.trim()}>
          Send
        </button>
      </div>
    </form>
  )
}
