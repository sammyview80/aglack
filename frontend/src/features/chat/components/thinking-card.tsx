import { useState } from 'react'
import { ChevronRight, Lightbulb } from 'lucide-react'
import { chatUi } from '@/features/chat/chat-ui'
import { cn } from '@/lib/utils'

/** Collapsed-by-default reasoning trace for one completed turn. */
export function ThinkingCard({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false)
  if (!reasoning.trim()) return null

  return (
    <div className={chatUi.thinkingCard}>
      <button
        type="button"
        className={chatUi.thinkingHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Lightbulb size={14} />
        <span className="flex-1">Thinking</span>
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open ? <pre className={chatUi.thinkingBody}>{reasoning}</pre> : null}
    </div>
  )
}
