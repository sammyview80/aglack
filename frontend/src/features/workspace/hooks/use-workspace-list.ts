import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  deleteWorkspace,
  diagnoseWorkspace,
  listWorkspaces,
} from '@/features/workspace/api'
import type {
  DiagnosisReport,
  DiagnosisSnapshot,
  WorkspaceListItem,
} from '@/features/workspace/types'
import { handleError } from '@/lib/handle-error'

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

export function useWorkspaceList() {
  const [items, setItems] = useState<WorkspaceListItem[]>([])
  const [pageLimit, setPageLimit] = useState<number | null>(null)
  const [lastPageFull, setLastPageFull] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

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

  async function remove(row: WorkspaceListItem): Promise<boolean> {
    if (
      !window.confirm(
        `Delete workspace "${row.name}"? This stops the container and removes its data.`,
      )
    ) {
      return false
    }
    setBusyId(row.workspaceId)
    setLoadError('')
    try {
      await deleteWorkspace(row.workspaceId)
      setItems((prev) => prev.filter((item) => item.workspaceId !== row.workspaceId))
      return true
    } catch (err) {
      setLoadError(
        handleError(err, {
          fallback: 'Failed to delete workspace',
          messagesByCode: LIST_ERRORS,
        }),
      )
      return false
    } finally {
      setBusyId(null)
    }
  }

  async function diagnose(row: WorkspaceListItem) {
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

  return {
    items,
    pageLimit,
    lastPageFull,
    loadError,
    busy,
    busyId,
    ready,
    refresh,
    loadMore,
    remove,
    diagnose,
  }
}
