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
  /** Blocking actions stay pinned under the scrollable body. */
  footer?: ReactNode
  children?: ReactNode
}

function PromptChrome({
  title,
  description,
  footer,
  children,
}: {
  title: string
  description?: string
  footer?: ReactNode
  children?: ReactNode
}) {
  return (
    <>
      <div className={chatUi.promptHeader}>
        <p className={chatUi.promptTitle}>{title}</p>
        {description ? <p className={chatUi.promptDescription}>{description}</p> : null}
      </div>
      {children ? <div className={chatUi.promptBody}>{children}</div> : null}
      {footer ? <div className={chatUi.promptFooter}>{footer}</div> : null}
    </>
  )
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
      footer,
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
          <PromptChrome title={title} description={description} footer={footer}>
            {children}
          </PromptChrome>
        </form>
      )
    }

    return (
      <div {...shared} ref={ref}>
        <PromptChrome title={title} description={description} footer={footer}>
          {children}
        </PromptChrome>
      </div>
    )
  },
)
