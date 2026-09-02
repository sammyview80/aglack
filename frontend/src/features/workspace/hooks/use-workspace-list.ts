import { useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { deleteWorkspace, diagnoseWorkspace, listWorkspaces } from '@/features/workspace/api'
import type {
  DiagnosisReport,
  DiagnosisSnapshot,
  WorkspaceListItem,
} from '@/features/workspace/types'
import { errorMessage } from '@/lib/api'
import { handleError } from '@/lib/handle-error'
import { queryKeys } from '@/lib/query-keys'

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
  const queryClient = useQueryClient()
  const [mutationError, setMutationError] = useState('')

  const query = useInfiniteQuery({
    queryKey: queryKeys.workspaces.list(),
    queryFn: ({ pageParam }) =>
      listWorkspaces(pageParam === null ? {} : { limit: pageParam.limit, offset: pageParam.offset }),
    initialPageParam: null as { limit: number; offset: number } | null,
    getNextPageParam: (lastPage) => {
      if (lastPage.workspaces.length < lastPage.limit) return undefined
      return { limit: lastPage.limit, offset: lastPage.offset + lastPage.workspaces.length }
    },
  })

  const items: WorkspaceListItem[] = query.data?.pages.flatMap((page) => page.workspaces) ?? []

  const removeMutation = useMutation({
    mutationFn: (row: WorkspaceListItem) => deleteWorkspace(row.workspaceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
    },
    onError: (err) => {
      setMutationError(
        handleError(err, { fallback: 'Failed to delete workspace', messagesByCode: LIST_ERRORS }),
      )
    },
  })

  const diagnoseMutation = useMutation({
    mutationFn: (row: WorkspaceListItem) => diagnoseWorkspace(row.workspaceId),
    onMutate: async (row) => {
      const toastId = toast.loading(`Diagnosing "${row.name}"…`)
      return { toastId }
    },
    onSuccess: (report, _row, context) => {
      const { ok, text } = diagnosisMessage(report)
      if (context) toast.dismiss(context.toastId)
      if (ok) toast.success(text)
      else toast.error(text)
      setMutationError(ok ? '' : text)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
    },
    onError: (err, _row, context) => {
      if (context) toast.dismiss(context.toastId)
      setMutationError(
        handleError(err, { fallback: 'Failed to diagnose workspace', messagesByCode: LIST_ERRORS }),
      )
    },
  })

  async function remove(row: WorkspaceListItem): Promise<boolean> {
    if (
      !window.confirm(
        `Delete workspace "${row.name}"? This stops the container and removes its data.`,
      )
    ) {
      return false
    }
    setMutationError('')
    try {
      await removeMutation.mutateAsync(row)
      return true
    } catch {
      return false
    }
  }

  async function diagnose(row: WorkspaceListItem) {
    setMutationError('')
    try {
      await diagnoseMutation.mutateAsync(row)
    } catch {
      // handled in onError
    }
  }

  const loadError = query.isError
    ? errorMessage(query.error, 'Failed to load workspaces', LIST_ERRORS)
    : mutationError

  const busyId =
    removeMutation.isPending
      ? (removeMutation.variables?.workspaceId ?? null)
      : diagnoseMutation.isPending
        ? (diagnoseMutation.variables?.workspaceId ?? null)
        : null

  return {
    items,
    lastPageFull: Boolean(query.hasNextPage),
    loadError,
    busy: query.isFetching,
    busyId,
    ready: !query.isPending,
    refresh: () => query.refetch(),
    loadMore: () => query.fetchNextPage(),
    remove,
    diagnose,
  }
}
