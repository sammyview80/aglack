import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AppWindow,
  ExternalLink,
  HeartPulse,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { SlackOnboardingLayout } from '@/components/slack-onboarding-layout'
import { PageFallback } from '@/components/page-fallback'
import { StatusAlert } from '@/components/status-alert'
import { Skeleton } from '@/components/ui/skeleton'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { APP_NAME } from '@/lib/brand'
import { desktopUrl, hermesWebuiUrl } from '@/features/workspace/api'
import type { WorkspaceListItem, WorkspaceStatus } from '@/features/workspace/types'
import { useWorkspaceList } from '@/features/workspace/hooks/use-workspace-list'
import { cn } from '@/lib/utils'

type FilterId = 'all' | 'healthy' | WorkspaceStatus

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
  return `hsl(${Math.abs(hash) % 360}, 48%, 46%)`
}

function statusLabel(status: WorkspaceStatus, healthy: boolean | null): string {
  if (status === 'creating') return 'Creating'
  if (status === 'failed') return 'Failed'
  if (healthy === null) return 'Ready'
  return healthy ? 'Ready' : 'Unhealthy'
}

export function WorkspaceList({ onCreate, onSetup }: WorkspaceListProps) {
  const navigate = useNavigate()
  const {
    items,
    lastPageFull,
    loadError,
    busy,
    busyId,
    ready,
    refresh,
    loadMore,
    remove,
    diagnose,
  } = useWorkspaceList()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterId>('all')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [isDesktopViewport, setIsDesktopViewport] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  )

  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    const onChange = () => setIsDesktopViewport(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  async function handleDelete(row: WorkspaceListItem) {
    const deleted = await remove(row)
    if (deleted && previewId === row.workspaceId) setPreviewId(null)
  }

  const rowBusy = !ready || busy || busyId !== null

  const { filtered, healthyCount } = useMemo(() => {
    const query = search.trim().toLowerCase()
    let healthy = 0
    const visible = items.filter((item) => {
      if (item.healthy) healthy += 1
      const matchesFilter =
        filter === 'all' || (filter === 'healthy' ? Boolean(item.healthy) : item.status === filter)
      const matchesSearch =
        !query ||
        item.name.toLowerCase().includes(query) ||
        item.workspaceId.toLowerCase().includes(query) ||
        (item.hostPort != null && String(item.hostPort).includes(query))
      return matchesFilter && matchesSearch
    })
    return { filtered: visible, healthyCount: healthy }
  }, [filter, items, search])

  const previewRow =
    filtered.find((item) => item.workspaceId === previewId) || filtered[0] || items[0]

  if (loadError && items.length === 0) {
    return (
      <PageFallback
        title="Cannot load workspaces"
        description={loadError}
        actionLabel="Retry"
        onAction={() => void refresh()}
        hideBack
      />
    )
  }

  return (
    <SlackOnboardingLayout
      workspaceName={previewRow?.name || APP_NAME}
      title="Workspaces"
    >
      <div className="flex flex-col gap-4">
        <div>
          <div className="flex items-start justify-between gap-3">
            <h2 className="mb-0!">Workspaces</h2>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-mr-1 -mt-1"
              disabled={rowBusy}
              onClick={() => void refresh()}
              title="Refresh"
            >
              <RefreshCw className={cn((!ready || busy) && 'animate-spin')} aria-hidden="true" />
              Refresh
            </Button>
          </div>
          <div className="divider mb-3! mt-3" />
          <p className="post-copy">
            {!ready
              ? 'Loading workspaces…'
              : items.length > 0
                ? `${items.length} workspace${items.length === 1 ? '' : 's'}${
                    healthyCount > 0 ? ` · ${healthyCount} healthy` : ''
                  }`
                : `Create one to launch ${APP_NAME}.`}
          </p>
        </div>

        {items.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                placeholder="Search by name"
                aria-label="Search workspaces"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={!ready}
                className="pl-9"
              />
            </div>
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter by status">
              {(
                [
                  ['all', 'All'],
                  ['healthy', 'Healthy'],
                  ['creating', 'Starting'],
                  ['failed', 'Failed'],
                ] as const
              ).map(([id, label]) => (
                <Button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={filter === id}
                  variant={filter === id ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setFilter(id)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <StatusAlert message={loadError} />

        {!ready ? (
          <ul className="overflow-hidden rounded-xl border border-border" aria-label="Loading workspaces">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-3 w-1/5" />
                </div>
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workspaces yet.</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {search ? `No workspaces match “${search}”.` : 'No workspaces match this filter.'}
          </p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border" aria-label="Your workspaces">
            {filtered.map((row) => {
              const initial = row.name.trim().charAt(0).toUpperCase() || 'W'
              const busyRow = busyId === row.workspaceId
              const label =
                busyRow ? 'Diagnosing…' : statusLabel(row.status, row.healthy)
              return (
                <li
                  key={row.workspaceId}
                  className="border-b border-border last:border-b-0"
                  onMouseEnter={() => {
                    setPreviewId(row.workspaceId)
                  }}
                  onFocusCapture={() => {
                    setPreviewId(row.workspaceId)
                  }}
                >
                  <div className={cn('flex items-center hover:bg-muted', busyRow && 'opacity-55')}>
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-3 py-2.5 text-left text-foreground"
                      disabled={rowBusy}
                      onClick={() =>
                        navigate(`/workspaces/${row.workspaceId}/chat`, {
                          state: { name: row.name },
                        })
                      }
                    >
                      <span
                        className="grid size-9 shrink-0 place-items-center rounded-lg text-sm font-bold text-white"
                        style={{ background: avatarColor(row.workspaceId) }}
                        aria-hidden="true"
                      >
                        {initial}
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm font-semibold">{row.name}</strong>
                        <span className="text-xs text-muted-foreground">{label}</span>
                      </span>
                    </button>
                    <span className="flex shrink-0 gap-0.5 pr-2">
                      <a
                        className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }))}
                        href={hermesWebuiUrl(row.workspaceId)}
                        target="_blank"
                        rel="noreferrer"
                        title="Open Aglack WebUI"
                        aria-label="Open Aglack WebUI"
                      >
                        <AppWindow aria-hidden="true" />
                      </a>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={rowBusy}
                        onClick={() => onSetup(row.workspaceId)}
                        title="Connect provider"
                        aria-label="Connect provider"
                      >
                        <KeyRound aria-hidden="true" />
                      </Button>
                      <a
                        className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }))}
                        href={desktopUrl(row.workspaceId, isDesktopViewport)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open desktop"
                        aria-label="Open desktop"
                      >
                        <ExternalLink aria-hidden="true" />
                      </a>
                      {row.status !== 'creating' ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={rowBusy}
                          onClick={() => void diagnose(row)}
                          title="Diagnose"
                          aria-label="Diagnose"
                        >
                          <HeartPulse aria-hidden="true" />
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon-sm"
                        disabled={rowBusy}
                        onClick={() => void handleDelete(row)}
                        title={`Delete ${row.name}`}
                        aria-label={`Delete ${row.name}`}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {lastPageFull ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={rowBusy}
            onClick={() => void loadMore()}
          >
            {busy ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}

        <Button type="button" size="lg" className="w-full" onClick={onCreate}>
          <Plus aria-hidden="true" />
          New workspace
        </Button>
      </div>
    </SlackOnboardingLayout>
  )
}
