import { APP_NAME } from '@/lib/brand'

type WorkspacePreviewProps = {
  name: string
  status?: string
  hint?: string
}

export function WorkspacePreview({ name, status, hint }: WorkspacePreviewProps) {
  const previewName = name.trim() || APP_NAME
  const initial = previewName.charAt(0).toUpperCase()

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Workspace
      </p>
      <div className="mt-3 flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-11 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
        >
          {initial}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold">{previewName}</p>
          {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
        </div>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {hint || `Open a name for ${APP_NAME} Web. Chat is in the ⋯ menu for this workspace.`}
      </p>
    </div>
  )
}
