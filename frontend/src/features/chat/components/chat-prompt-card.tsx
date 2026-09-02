import { forwardRef, type FormEventHandler, type ReactNode } from 'react'
import { chatUi } from '@/features/chat/chat-ui'
import { cn } from '@/lib/utils'

type ChatPromptCardProps = {
  title: string
  description?: string
  className?: string
  role?: string
  ariaLabel?: string
  ariaLive?: 'polite' | 'assertive' | 'off'
  tabIndex?: number
  as?: 'div' | 'form'
  onSubmit?: FormEventHandler<HTMLFormElement>
  children: ReactNode
}

/** Shared chrome for blocking chat prompts (approval, clarify, …). */
export const ChatPromptCard = forwardRef<HTMLDivElement, ChatPromptCardProps>(
  function ChatPromptCard(
    {
      title,
      description,
      className,
      role,
      ariaLabel,
      ariaLive,
      tabIndex,
      as = 'div',
      onSubmit,
      children,
    },
    ref,
  ) {
    const shared = {
      className: cn(chatUi.promptCard, className),
      role,
      'aria-label': ariaLabel,
      'aria-live': ariaLive,
      tabIndex,
    }

    if (as === 'form') {
      return (
        <form {...shared} onSubmit={onSubmit}>
          <p className={chatUi.promptTitle}>{title}</p>
          {description ? <p className={chatUi.promptDescription}>{description}</p> : null}
          {children}
        </form>
      )
    }

    return (
      <div {...shared} ref={ref}>
        <p className={chatUi.promptTitle}>{title}</p>
        {description ? <p className={chatUi.promptDescription}>{description}</p> : null}
        {children}
      </div>
    )
  },
)
