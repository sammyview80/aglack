import { useState } from 'react'
import { ChevronRight, Wrench } from 'lucide-react'
import type { ToolActivity } from '@/features/chat/types'

export function ToolActivityList({ tools }: { tools: ToolActivity[] }) {
  if (tools.length === 0) return null
  return (
    <div className="tool-activity-list">
      {tools.map((tool, i) => (
        <div key={`${tool.name}-${i}`} className={tool.isError ? 'tool-activity tool-activity-error' : 'tool-activity'}>
          <span className="tool-activity-name">{tool.complete ? '✓' : '…'} {tool.name}</span>
          {tool.preview ? <span className="tool-activity-preview">{tool.preview}</span> : null}
        </div>
      ))}
    </div>
  )
}

/** Collapsed-by-default tool-call trace for one COMPLETED turn — same
 * click-to-expand convention as ThinkingCard, so a finished turn shows
 * only its final answer by default; the process that produced it (tool
 * calls) is one click away, not gone. Live/in-progress turns keep using
 * the always-expanded `ToolActivityList` directly — collapsing an
 * in-progress trace would hide useful "what is it doing right now"
 * signal. */
export function ToolActivitySummary({ tools }: { tools: ToolActivity[] }) {
  const [open, setOpen] = useState(false)
  if (tools.length === 0) return null
  const errorCount = tools.filter((t) => t.isError).length

  return (
    <div className={open ? 'thinking-card open' : 'thinking-card'}>
      <button
        type="button"
        className="thinking-card-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Wrench size={14} />
        <span className="thinking-card-label">
          {tools.length} tool call{tools.length === 1 ? '' : 's'}
          {errorCount > 0 ? ` · ${errorCount} error${errorCount === 1 ? '' : 's'}` : ''}
        </span>
        <ChevronRight size={12} className="thinking-card-toggle" />
      </button>
      {open ? (
        <div className="thinking-card-body thinking-card-body-tools">
          <ToolActivityList tools={tools} />
        </div>
      ) : null}
    </div>
  )
}
