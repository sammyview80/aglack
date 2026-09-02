import { useState } from 'react'
import { ChevronRight, Wrench } from 'lucide-react'
import { chatUi } from '@/features/chat/chat-ui'
import { cn } from '@/lib/utils'
import type { ToolActivity } from '@/features/chat/types'

function ToolActivityRow({ tool }: { tool: ToolActivity }) {
  const [expanded, setExpanded] = useState(false)

  const name = (
    <span className="shrink-0 whitespace-nowrap">
      {tool.complete ? '✓' : '…'} {tool.name}
    </span>
  )

  if (!tool.preview) {
    return (
      <div className={cn(chatUi.toolRow, tool.isError && 'text-[#d1435b]')}>{name}</div>
    )
  }

  return (
    <button
      type="button"
      className={cn(
        chatUi.toolRow,
        chatUi.toolRowButton,
        'text-left',
        tool.isError && 'text-[#d1435b]',
        expanded && 'items-start',
      )}
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      aria-label={expanded ? `Collapse ${tool.name} output` : `Expand ${tool.name} output`}
    >
      {name}
      <span
        className={cn(
          'min-w-0 flex-1 text-xs text-[var(--th-muted)]',
          expanded ? 'overflow-visible whitespace-pre-wrap break-words' : 'truncate',
        )}
      >
        {tool.preview}
      </span>
    </button>
  )
}

export function ToolActivityList({ tools }: { tools: ToolActivity[] }) {
  if (tools.length === 0) return null
  return (
    <div className="my-1.5 flex w-full min-w-0 flex-col gap-1">
      {tools.map((tool, i) => (
        <ToolActivityRow key={`${tool.name}-${i}`} tool={tool} />
      ))}
    </div>
  )
}

/** Collapsed-by-default tool-call trace for one COMPLETED turn. */
export function ToolActivitySummary({ tools }: { tools: ToolActivity[] }) {
  const [open, setOpen] = useState(false)
  if (tools.length === 0) return null
  const errorCount = tools.filter((t) => t.isError).length

  return (
    <div className={chatUi.toolSummary}>
      <button
        type="button"
        className={chatUi.toolSummaryHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Wrench size={14} />
        <span className="flex-1">
          {tools.length} tool call{tools.length === 1 ? '' : 's'}
          {errorCount > 0 ? ` · ${errorCount} error${errorCount === 1 ? '' : 's'}` : ''}
        </span>
        <ChevronRight
          size={12}
          className={cn('shrink-0 transition-transform', open && 'rotate-90')}
        />
      </button>
      {open ? (
        <div className="px-2.5 pb-2">
          <ToolActivityList tools={tools} />
        </div>
      ) : null}
    </div>
  )
}
