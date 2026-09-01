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
import { toast } from 'sonner'
import { SlackOnboardingLayout } from '@/components/slack-onboarding-layout'
import { PageFallback } from '@/components/page-fallback'
import { StatusAlert } from '@/components/status-alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { APP_NAME } from '@/lib/brand'
import {
  deleteWorkspace,
  desktopUrl,
  diagnoseWorkspace,
  hermesWebuiUrl,
  listWorkspaces,
} from '@/features/workspace/api'
import type {
  DiagnosisReport,
  DiagnosisSnapshot,
  WorkspaceListItem,
  WorkspaceStatus,
} from '@/features/workspace/types'
import { handleError } from '@/lib/handle-error'
import { cn } from '@/lib/utils'

const LIST_ERRORS: Record<string, string> = {
  invalid_pagination: 'List request used a bad page size.',
  workspace_list_failed: 'Could not load workspaces.',
  workspace_not_found: 'That workspace is already gone.',
  workspace_delete_failed: 'Could not stop the workspace container.',
  workspace_store_failed: 'Could not delete the workspace record.',
  workspace_no_container: 'This workspace has no container to diagnose yet.',
  workspace_diagnosis_failed: 'Could not inspect the workspace container.',
  network: 'Cannot reach the gateway. Is rust_gateway running?',
}

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

function statusLabel(status: WorkspaceStatus, healthy: boolean): string {
  if (status === 'creating') return 'Creating'
  if (status === 'failed') return 'Failed'
  return healthy ? 'Ready' : 'Unhealthy'
}

function snapshotUnhealthy(s: DiagnosisSnapshot): boolean {
  return !s.containerRunning || !s.wrapperHealthy || !s.desktopHealthy
}

function snapshotDetail(s: DiagnosisSnapshot): string {
  const bits: string[] = []
  if (!s.containerRunning) {
    if (s.containerOomKilled) bits.push('container OOM-killed')
    else if (s.containerExitCode != null) {
      bits.push(`container not running (exit ${s.containerExitCode})`)
    } else bits.push('container not running')
  }
  if (!s.wrapperHealthy) bits.push('wrapper down')
  if (!s.desktopHealthy) bits.push('desktop down')
  return bits.join(', ') || 'unhealthy'
}

function diagnosisMessage(report: DiagnosisReport): { ok: boolean; text: string } {
  if (report.action === 'none') {
    return { ok: true, text: 'Already healthy. Nothing restarted.' }
  }
  if (report.action === 'restart_failed') {
    return { ok: false, text: 'Could not restart the container (Docker stop/start failed).' }
  }
  const after = report.after
  if (!after || snapshotUnhealthy(after)) {
    const detail = after ? snapshotDetail(after) : 'still unhealthy'
    return { ok: false, text: `Restarted, still unhealthy: ${detail}.` }
  }
  return { ok: true, text: 'Restarted. Workspace is healthy.' }
}

export function WorkspaceList({ onCreate, onSetup }: WorkspaceListProps) {
  const navigate = useNavigate()
  const [items, setItems] = useState<WorkspaceListItem[]>([])
  const [pageLimit, setPageLimit] = useState<number | null>(null)
  const [lastPageFull, setLastPageFull] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterId>('all')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [isDesktopViewport, setIsDesktopViewport] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  )

  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    const onChange = () => setIsDesktopViewport(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

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
      .finally(() => {
        if (!cancelled) setReady(true)
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

  async function handleDiagnose(row: WorkspaceListItem) {
    setBusyId(row.workspaceId)
    setLoadError('')
    const toastId = toast.loading(`Diagnosing "${row.name}"…`)
    try {
      const report = await diagnoseWorkspace(row.workspaceId)
      const { ok, text } = diagnosisMessage(report)
      toast.dismiss(toastId)
      if (ok) toast.success(text)
      else toast.error(text)
      setLoadError(ok ? '' : text)
      await loadFirst()
    } catch (err) {
      toast.dismiss(toastId)
      setLoadError(
        handleError(err, {
          fallback: 'Failed to diagnose workspace',
          messagesByCode: LIST_ERRORS,
        }),
      )
    } finally {
      setBusyId(null)
    }
  }

  const rowBusy = !ready || busy || busyId !== null

  const { filtered, healthyCount } = useMemo(() => {
    const query = search.trim().toLowerCase()
    let healthy = 0
    const visible = items.filter((item) => {
      if (item.healthy) healthy += 1
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

  const previewRow =
    filtered.find((item) => item.workspaceId === previewId) || filtered[0] || items[0]

  if (loadError && items.length === 0) {
    return (
      <PageFallback
        title="Cannot load workspaces"
        description={loadError}
        actionLabel="Retry"
        onAction={() => window.location.reload()}
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
          <p className="text-sm text-muted-foreground">Loading workspaces…</p>
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
                  onMouseEnter={() => setPreviewId(row.workspaceId)}
                  onFocusCapture={() => setPreviewId(row.workspaceId)}
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
                          onClick={() => void handleDiagnose(row)}
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
