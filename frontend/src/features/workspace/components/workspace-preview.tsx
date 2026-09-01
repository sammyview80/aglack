type WorkspacePreviewProps = {
  name: string
}

export function WorkspacePreview({ name }: WorkspacePreviewProps) {
  const previewName = name.trim() || 'Hermes'
  const initial = previewName.charAt(0).toUpperCase()

  return (
    <aside
      aria-hidden="true"
      className="hidden min-h-0 overflow-hidden bg-[var(--brand-preview)] p-8 lg:flex lg:items-center lg:justify-center"
    >
      <div className="grid h-[min(72vh,560px)] w-full max-w-lg grid-cols-[48px_minmax(0,9rem)_minmax(0,1fr)] overflow-hidden rounded-xl bg-[var(--slack-bg)] text-[var(--slack-text)] shadow-xl ring-1 ring-black/20">
        <div className="flex flex-col items-center gap-2 bg-[var(--brand-plum)] py-3">
          <span className="grid size-8 place-items-center rounded-lg bg-white/20 text-sm font-bold text-white">
            {initial}
          </span>
          <span className="grid size-8 place-items-center rounded-lg bg-white/10 text-xs text-white/80">
            T
          </span>
          <span className="grid size-8 place-items-center rounded-lg bg-white/10 text-xs text-white/80">
            C
          </span>
        </div>
        <div className="flex flex-col gap-1 border-r border-[var(--slack-border)] p-3">
          <p className="truncate text-sm font-semibold">{previewName}</p>
          <p className="text-[11px] uppercase tracking-wide text-[var(--slack-muted)]">Work</p>
          <span className="rounded-md bg-[var(--slack-selected)] px-2 py-1 text-xs"># chat</span>
          <span className="px-2 py-1 text-xs text-[var(--slack-muted)]"># agents</span>
          <span className="px-2 py-1 text-xs text-[var(--slack-muted)]"># schedule</span>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm font-medium"># chat</p>
          <div className="text-sm">
            <span className="mr-2 font-medium">You</span>
            <span className="text-[var(--slack-muted)]">Plan the next workspace launch.</span>
          </div>
          <div className="text-sm">
            <span className="mr-2 font-medium">PM</span>
            <span className="text-[var(--slack-muted)]">
              On it — I&apos;ll draft the checklist and assign owners.
            </span>
          </div>
        </div>
      </div>
    </aside>
  )
}
