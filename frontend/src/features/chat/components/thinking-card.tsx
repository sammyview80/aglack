import { useState } from 'react'
import { ChevronRight, Lightbulb } from 'lucide-react'

/** Collapsed-by-default reasoning trace for one completed turn — click the
 * header to expand/collapse. Matches upstream Hermes WebUI's own
 * "Thinking" card convention (collapsed by default, lightbulb icon,
 * chevron toggle — see backend/upstream/static/ui.js's `thinking-card`
 * template) rather than inventing a new interaction pattern.
 *
 * Deliberately separate from the always-visible streaming reasoning line
 * (`.chat-reasoning` in ChatMessageList's isStreaming block) — WHILE a
 * turn is in flight, seeing the model think live is the useful state;
 * ONCE a turn is done, that same text turns into noise that pushes every
 * other message down, so it collapses behind a click instead of vanishing
 * outright (the previous behavior: reasoning was shown only while
 * streaming and permanently discarded once the turn settled). */
export function ThinkingCard({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false)
  if (!reasoning.trim()) return null

  return (
    <div className={open ? 'thinking-card open' : 'thinking-card'}>
      <button
        type="button"
        className="thinking-card-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Lightbulb size={14} />
        <span className="thinking-card-label">Thinking</span>
        <ChevronRight size={12} className="thinking-card-toggle" />
      </button>
      {open ? <pre className="thinking-card-body">{reasoning}</pre> : null}
    </div>
  )
}
