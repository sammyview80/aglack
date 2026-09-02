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
