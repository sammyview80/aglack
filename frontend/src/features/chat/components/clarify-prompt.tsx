import { useState, type FormEvent, type RefObject } from 'react'
import { ChatPromptCard } from '@/features/chat/components/chat-prompt-card'
import { chatUi } from '@/features/chat/chat-ui'
import type { ClarifyPrompt as ClarifyPromptType } from '@/features/chat/types'

export function ClarifyPrompt({
  prompt,
  onRespond,
  inputRef,
}: {
  prompt: ClarifyPromptType
  onRespond: (response: string, clarifyId?: string) => void
  inputRef?: RefObject<HTMLInputElement | null>
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
    <ChatPromptCard
      as="form"
      onSubmit={onSubmit}
      title={prompt.question}
      role="region"
      ariaLabel="Clarification required"
      ariaLive="polite"
    >
      {prompt.choicesOffered.length > 0 ? (
        <div className={chatUi.promptChoices}>
          {prompt.choicesOffered.map((choice) => (
            <button
              key={choice}
              type="button"
              className={chatUi.promptChoice}
              onClick={() => onRespond(choice, prompt.clarifyId)}
            >
              {choice}
            </button>
          ))}
        </div>
      ) : null}
      <div className={chatUi.promptAnswer}>
        <input
          ref={inputRef}
          className={chatUi.promptInput}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Type your answer"
          aria-label="Clarify answer"
        />
        <button type="submit" className={chatUi.promptSend} disabled={!answer.trim()}>
          Send
        </button>
      </div>
    </ChatPromptCard>
  )
}
