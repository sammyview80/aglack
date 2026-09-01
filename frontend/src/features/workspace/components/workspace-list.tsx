import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
} from 'lucide-react'
import { BrandMark } from '@/components/brand-mark'
import { PageFallback } from '@/components/page-fallback'
import { StatusAlert } from '@/components/status-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ThemeSwitch } from '@/features/theme/theme-switch'
import {
  deleteWorkspace,
  desktopUrl,
  hermesWebuiUrl,
  listWorkspaces,
} from '@/features/workspace/api'
import { WorkspacePreview } from '@/features/workspace/components/workspace-preview'
import type { WorkspaceListItem, WorkspaceStatus } from '@/features/workspace/types'
import { handleError } from '@/lib/handle-error'
import { cn } from '@/lib/utils'

const LIST_ERRORS: Record<string, string> = {
  invalid_pagination: 'List request used a bad page size.',
  workspace_list_failed: 'Could not load workspaces.',
  workspace_not_found: 'That workspace is already gone.',
  workspace_delete_failed: 'Could not stop the workspace container.',
  workspace_store_failed: 'Could not delete the workspace record.',
  network: 'Cannot reach the gateway. Is rust_gateway running?',
}

type FilterId = 'all' | 'healthy' | WorkspaceStatus

const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'healthy', label: 'Healthy' },
  { id: 'creating', label: 'Starting' },
  { id: 'failed', label: 'Failed' },
]

type WorkspaceListProps = {
  onCreate: () => void
  onSetup: (workspaceId: string) => void
}

function avatarColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i)
    hash |= 0
  }
  return `hsl(${Math.abs(hash) % 360}, 62%, 45%)`
}

/**
 * Combines `status` (the DB's last-written state) with `healthy` (the
 * gateway's live check on THIS list call — see
 * rust_gateway/docs/list-workspaces-plan.md) into one label. A `ready`
 * row whose container has since crashed/hung reads as "Unhealthy", not
 * "Ready" — the two fields are independent on the wire, but a user
 * looking at one row needs a single, honest answer to "can I use this
 * right now."
 */
function statusLabel(status: WorkspaceStatus, healthy: boolean): string {
  if (status === 'creating') return 'Creating'
  if (status === 'failed') return 'Failed'
  return healthy ? 'Ready' : 'Unhealthy'
}

/** Dot color for the live health indicator — see `statusLabel` above. */
function healthDotClass(status: WorkspaceStatus, healthy: boolean): string {
  if (status === 'creating') return 'bg-amber-500'
  if (status === 'failed') return 'bg-destructive'
  return healthy ? 'bg-emerald-500' : 'bg-destructive'
}

const TOOL_BTN =
  'grid size-8 shrink-0 place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

export function WorkspaceList({ onCreate, onSetup }: WorkspaceListProps) {
  const [items, setItems] = useState<WorkspaceListItem[]>([])
  const [pageLimit, setPageLimit] = useState<number | null>(null)
  const [lastPageFull, setLastPageFull] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterId>('all')
  const [previewId, setPreviewId] = useState<string | null>(null)

  async function loadFirst() {
    const next = await listWorkspaces()
    setItems(next.workspaces)
    setPageLimit(next.limit)
    setLastPageFull(next.workspaces.length === next.limit)
  }

  useEffect(() => {
    let cancelled = false
    loadFirst()
      .then(() => {
        if (!cancelled) setLoadError('')
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            handleError(err, {
              fallback: 'Failed to load workspaces',
              messagesByCode: LIST_ERRORS,
            }),
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function refresh() {
    setBusy(true)
    setLoadError('')
    try {
      await loadFirst()
    } catch (err) {
      setLoadError(
        handleError(err, {
          fallback: 'Failed to load workspaces',
          messagesByCode: LIST_ERRORS,
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  async function loadMore() {
    if (pageLimit === null || busy) return
    setBusy(true)
    setLoadError('')
    try {
      const next = await listWorkspaces({
        limit: pageLimit,
        offset: items.length,
      })
      setItems((prev) => [...prev, ...next.workspaces])
      setPageLimit(next.limit)
      setLastPageFull(next.workspaces.length === next.limit)
    } catch (err) {
      setLoadError(
        handleError(err, {
          fallback: 'Failed to load more workspaces',
          messagesByCode: LIST_ERRORS,
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(row: WorkspaceListItem) {
    if (
      !window.confirm(
        `Delete workspace "${row.name}"? This stops the container and removes its data.`,
      )
    ) {
      return
    }
    setBusyId(row.workspaceId)
    setLoadError('')
    try {
      await deleteWorkspace(row.workspaceId)
      setItems((prev) => prev.filter((item) => item.workspaceId !== row.workspaceId))
      if (previewId === row.workspaceId) setPreviewId(null)
    } catch (err) {
      setLoadError(
        handleError(err, {
          fallback: 'Failed to delete workspace',
          messagesByCode: LIST_ERRORS,
        }),
      )
    } finally {
      setBusyId(null)
    }
  }

  const rowBusy = busy || busyId !== null

  const { filtered, healthyCount } = useMemo(() => {
    const query = search.trim().toLowerCase()
    let healthy = 0
    const visible = items.filter((item) => {
      if (item.healthy) healthy += 1
      // 'healthy' filters on the LIVE per-request check (item.healthy),
      // not the DB's last-written `status` — a `ready` row whose
      // container has since crashed/hung must not show under "Healthy"
      // (see rust_gateway/docs/list-workspaces-plan.md's "Live health
      // check" section). Every other filter still matches `status`
      // directly (creating/failed have no live check to differ from).
      const matchesFilter =
        filter === 'all' || (filter === 'healthy' ? item.healthy : item.status === filter)
      const matchesSearch =
        !query ||
        item.name.toLowerCase().includes(query) ||
        item.workspaceId.toLowerCase().includes(query) ||
        (item.hostPort != null && String(item.hostPort).includes(query))
      return matchesFilter && matchesSearch
    })
    return { filtered: visible, healthyCount: healthy }
  }, [filter, items, search])

  const previewName =
    filtered.find((item) => item.workspaceId === previewId)?.name ||
    filtered[0]?.name ||
    items[0]?.name ||
    'Hermes'

  if (loadError && items.length === 0) {
    return (
      <PageFallback
        title="Cannot load workspaces"
        description={loadError}
        actionLabel="Retry"
        onAction={() => window.location.reload()}
      />
    )
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(280px,46vw)]">
      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 px-6 pt-4">
          <BrandMark />
          <ThemeSwitch />
        </header>

        <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-4 px-6 py-8">
          <div className="flex items-end justify-between gap-3">
            <h1 className="text-[clamp(1.65rem,3.2vw,2.15rem)] font-bold tracking-tight">
              Workspaces
            </h1>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={rowBusy}
              onClick={() => void refresh()}
              title="Refresh"
            >
              <RefreshCw />
              Refresh
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            {items.length > 0
              ? `${items.length} workspace${items.length === 1 ? '' : 's'}${
                  healthyCount > 0 ? ` · ${healthyCount} healthy` : ''
                }`
              : 'Create one to launch Hermes.'}
          </p>

          <StatusAlert message={loadError} />

          {items.length > 0 ? (
            <>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  placeholder="Search by name or id"
                  aria-label="Search workspaces"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-10 rounded-full pl-10"
                />
              </div>
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter by status">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="tab"
                    aria-selected={filter === f.id}
                    className={cn(
                      'h-7 cursor-pointer rounded-full border px-3 text-xs font-semibold transition-colors',
                      filter === f.id
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input bg-transparent text-muted-foreground hover:bg-muted',
                    )}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No workspaces yet.</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {search ? `No workspaces match “${search}”.` : 'No workspaces match this filter.'}
            </p>
          ) : (
            <ul
              className="max-h-[min(46vh,420px)] overflow-auto rounded-[10px] border border-input"
              aria-label="Your workspaces"
            >
              {filtered.map((row) => {
                const initial = row.name.trim().charAt(0).toUpperCase() || 'W'
                const toolsDisabled = rowBusy
                return (
                  <li
                    key={row.workspaceId}
                    onMouseEnter={() => setPreviewId(row.workspaceId)}
                    onFocusCapture={() => setPreviewId(row.workspaceId)}
                  >
                    <div className="group relative flex items-stretch">
                      <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-r-sm bg-primary opacity-0 transition-opacity group-hover:opacity-100" />
                      <a
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-2.5 no-underline hover:bg-muted"
                        href={hermesWebuiUrl(row.workspaceId)}
                        target="_blank"
                        rel="noreferrer"
                        title="Open Hermes Web"
                      >
                        <span
                          className="grid size-9 shrink-0 place-items-center rounded-md text-sm font-bold text-[var(--brand-cream)]"
                          style={{ background: avatarColor(row.workspaceId) }}
                          aria-hidden="true"
                        >
                          {initial}
                        </span>
                        <span className="grid min-w-0 gap-px">
                          <strong className="truncate text-[0.95rem] font-bold">{row.name}</strong>
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span
                              className={cn('size-1.5 shrink-0 rounded-full', healthDotClass(row.status, row.healthy))}
                              aria-hidden="true"
                            />
                            {statusLabel(row.status, row.healthy)}
                          </span>
                        </span>
                        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[0.82rem] font-bold text-primary">
                          Open
                          <ArrowRight className="size-3.5" aria-hidden="true" />
                        </span>
                      </a>
                      <span className="flex shrink-0 items-center gap-0.5 pr-2.5">
                        <button
                          type="button"
                          className={TOOL_BTN}
                          disabled={toolsDisabled}
                          onClick={() => onSetup(row.workspaceId)}
                          title="Terminal and setup"
                          aria-label="Setup"
                        >
                          <Terminal className="size-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className={TOOL_BTN}
                          disabled={toolsDisabled}
                          onClick={() => onSetup(row.workspaceId)}
                          title="Connect model provider"
                          aria-label="Connect provider"
                        >
                          <KeyRound className="size-3.5" aria-hidden="true" />
                        </button>
                        <a
                          className={cn(TOOL_BTN, toolsDisabled && 'pointer-events-none opacity-40')}
                          href={desktopUrl(row.workspaceId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open desktop UI"
                          aria-label="Open UI"
                          aria-disabled={toolsDisabled}
                        >
                          <ExternalLink className="size-3.5" aria-hidden="true" />
                        </a>
                        <button
                          type="button"
                          className={`${TOOL_BTN} hover:text-destructive`}
                          disabled={toolsDisabled}
                          onClick={() => void handleDelete(row)}
                          title={`Delete ${row.name}`}
                          aria-label={`Delete ${row.name}`}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {lastPageFull ? (
            <Button type="button" variant="outline" disabled={rowBusy} onClick={() => void loadMore()}>
              {busy ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}

          <div className="flex flex-wrap items-center gap-4 pt-1">
            <Button type="button" size="lg" onClick={onCreate}>
              <Plus />
              New workspace
            </Button>
          </div>
        </div>
      </section>

      <WorkspacePreview name={previewName} />
    </div>
  )
}
