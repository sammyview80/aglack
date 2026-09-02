import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  applyOnboardingSetup,
  applySelfHostedSetup,
  cancelOAuthFlow,
  completeOnboarding,
  getOnboardingStatus,
  pollOAuthFlow,
  probeProvider,
  startOAuthFlow,
} from '@/features/onboarding/api'
import {
  isSetupNeedsConfirm,
  type OAuthFlow,
  type OnboardingStatus,
  type ProviderCatalogEntry,
  type SetupNeedsConfirm,
} from '@/features/onboarding/types'
import { errorMessage } from '@/lib/api'
import { handleError } from '@/lib/handle-error'
import { queryKeys } from '@/lib/query-keys'
import { GATEWAY_WORKSPACE_ERRORS, isInvalidWorkspace } from '@/lib/workspace-errors'

const ONBOARDING_ERRORS: Record<string, string> = {
  ...GATEWAY_WORKSPACE_ERRORS,
  onboarding_setup_failed: 'Setup failed — check provider, model, and key.',
  oauth_start_failed: 'This provider does not support OAuth here.',
  oauth_poll_failed: 'OAuth session expired or was not found.',
}

const SELF_HOSTED = new Set(['ollama', 'lmstudio'])

type UseOnboardingWizardArgs = {
  workspaceId: string
  onInvalidWorkspace: () => void
  onFinished: () => void
}

export function useOnboardingWizard({
  workspaceId,
  onInvalidWorkspace,
  onFinished,
}: UseOnboardingWizardArgs) {
  const queryClient = useQueryClient()
  const statusKey = queryKeys.onboarding.status(workspaceId)

  const statusQuery = useQuery({
    queryKey: statusKey,
    queryFn: () => getOnboardingStatus(workspaceId),
  })
  const status = statusQuery.data ?? null

  const [error, setError] = useState('')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [confirm, setConfirm] = useState<SetupNeedsConfirm | null>(null)
  const [probeModels, setProbeModels] = useState<{ id: string; label: string }[]>([])

  const initializedFromStatus = useRef(false)

  useEffect(() => {
    initializedFromStatus.current = false
    setProviderId('')
    setModel('')
    setBaseUrl('')
    setApiKey('')
  }, [workspaceId])

  // Onboarding initial load hitting workspace_not_found/workspace_not_ready
  // redirects to /create rather than showing a retry toast.
  useEffect(() => {
    if (!statusQuery.isError) return
    if (isInvalidWorkspace(statusQuery.error)) {
      toast.message(
        'This onboarding link needs a workspace that exists and is ready. Create one first.',
      )
      onInvalidWorkspace()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusQuery.isError, statusQuery.error])

  useEffect(() => {
    if (!status || initializedFromStatus.current) return
    initializedFromStatus.current = true
    const current = status.setup.current?.provider
    if (!current) return
    setProviderId(current)
    const p = (status.setup.providers ?? []).find((row) => row.id === current)
    if (p) {
      setModel(p.defaultModel || p.models?.[0]?.id || '')
      setBaseUrl(p.defaultBaseUrl || '')
    }
  }, [status])

  const loadError =
    statusQuery.isError && !isInvalidWorkspace(statusQuery.error)
      ? errorMessage(statusQuery.error, 'Failed to load onboarding status', ONBOARDING_ERRORS)
      : ''

  const providersById = useMemo(() => {
    const map = new Map<string, ProviderCatalogEntry>()
    for (const p of status?.setup.providers ?? []) map.set(p.id, p)
    return map
  }, [status])

  const selected = providersById.get(providerId)
  const useOauth = Boolean(selected?.oauthProvider)

  // OAuth: the one place polling is correct — poll every few seconds until
  // status leaves 'pending', then stop.
  const [oauthFlowId, setOauthFlowId] = useState<string | null>(null)
  const [oauthInitial, setOauthInitial] = useState<OAuthFlow | null>(null)

  const oauthQuery = useQuery({
    queryKey: ['onboarding', workspaceId, 'oauth', oauthFlowId] as const,
    queryFn: () => pollOAuthFlow(workspaceId, oauthFlowId as string),
    enabled: Boolean(oauthFlowId),
    initialData: oauthInitial ?? undefined,
    retry: 0,
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false
      return query.state.data?.status === 'pending' ? 3000 : false
    },
  })

  useEffect(() => {
    if (oauthQuery.data?.status === 'success') toast.success('OAuth connected.')
  }, [oauthQuery.data?.status])

  useEffect(() => {
    if (!oauthQuery.isError) return
    setError(handleError(oauthQuery.error, { fallback: 'OAuth poll failed', messagesByCode: ONBOARDING_ERRORS }))
  }, [oauthQuery.isError, oauthQuery.error])

  const oauth: OAuthFlow | null = oauthFlowId
    ? oauthQuery.isError
      ? { ...(oauthQuery.data ?? oauthInitial)!, status: 'error' }
      : (oauthQuery.data ?? oauthInitial)
    : null

  async function finish(next?: OnboardingStatus) {
    const done = next ?? (await completeOnboarding(workspaceId))
    queryClient.setQueryData(statusKey, done)
    toast.success('Model setup saved.')
    onFinished()
  }

  const setupMutation = useMutation({
    mutationFn: async (confirmOverwrite: boolean) => {
      if (!selected) throw new Error('No provider selected')
      if (SELF_HOSTED.has(selected.id)) {
        await applySelfHostedSetup(workspaceId, {
          provider: selected.id,
          model,
          apiKey: apiKey || undefined,
          baseUrl: baseUrl || undefined,
          activate: true,
        })
        return { selfHosted: true as const }
      }
      const data = await applyOnboardingSetup(workspaceId, {
        provider: selected.id,
        model,
        apiKey: apiKey || undefined,
        baseUrl: baseUrl || undefined,
        confirmOverwrite: confirmOverwrite || undefined,
      })
      return { selfHosted: false as const, data }
    },
    onSuccess: async (result) => {
      if (result.selfHosted) {
        await finish()
        return
      }
      if (isSetupNeedsConfirm(result.data)) {
        setConfirm(result.data)
        return
      }
      await finish(result.data.completed ? result.data : undefined)
    },
    onError: (err) => {
      setError(handleError(err, { fallback: 'Failed to apply setup', messagesByCode: ONBOARDING_ERRORS }))
    },
  })

  async function submitSetup(confirmOverwrite = false) {
    setError('')
    try {
      await setupMutation.mutateAsync(confirmOverwrite)
    } catch {
      // handled in onError
    }
  }

  const probeMutation = useMutation({
    mutationFn: () =>
      probeProvider(workspaceId, {
        provider: selected?.id,
        baseUrl,
        apiKey: apiKey || undefined,
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error || result.detail || 'Probe failed')
        toast.error(result.error || 'Cannot reach that base URL')
        return
      }
      setProbeModels(result.models ?? [])
      if (result.models?.[0]) setModel(result.models[0].id)
      toast.success('Endpoint reachable.')
    },
    onError: (err) => {
      setError(handleError(err, { fallback: 'Probe failed', messagesByCode: ONBOARDING_ERRORS }))
    },
  })

  async function runProbe() {
    setError('')
    try {
      await probeMutation.mutateAsync()
    } catch {
      // handled in onError
    }
  }

  const startOauthMutation = useMutation({
    mutationFn: () => startOAuthFlow(workspaceId, (selected as ProviderCatalogEntry).id),
    onSuccess: (flow) => {
      setOauthInitial(flow)
      setOauthFlowId(flow.flowId)
    },
    onError: (err) => {
      setError(handleError(err, { fallback: 'Could not start OAuth', messagesByCode: ONBOARDING_ERRORS }))
    },
  })

  async function startOauth() {
    if (!selected) return
    try {
      await startOauthMutation.mutateAsync()
    } catch {
      // handled in onError
    }
  }

  const stopOauthMutation = useMutation({
    mutationFn: () => cancelOAuthFlow(workspaceId, oauthFlowId as string, selected?.id),
    onSuccess: () => {
      setOauthFlowId(null)
      setOauthInitial(null)
    },
    onError: (err) => {
      setError(handleError(err, { fallback: 'Could not cancel OAuth', messagesByCode: ONBOARDING_ERRORS }))
    },
  })

  async function stopOauth() {
    if (!oauthFlowId) return
    try {
      await stopOauthMutation.mutateAsync()
    } catch {
      // handled in onError
    }
  }

  function selectProvider(id: string, p: ProviderCatalogEntry) {
    setProviderId(id)
    setModel(p.defaultModel || p.models?.[0]?.id || '')
    setBaseUrl(p.defaultBaseUrl || '')
    setApiKey('')
    setConfirm(null)
    setProbeModels([])
    setOauthFlowId(null)
    setOauthInitial(null)
    setError('')
  }

  const modelOptions = probeModels.length > 0 ? probeModels : (selected?.models ?? [])

  const busy =
    setupMutation.isPending ||
    probeMutation.isPending ||
    startOauthMutation.isPending ||
    stopOauthMutation.isPending

  return {
    status,
    loadError,
    refetchStatus: statusQuery.refetch,
    busy,
    error,
    providerId,
    model,
    apiKey,
    baseUrl,
    confirm,
    probeModels,
    oauth,
    providersById,
    selected,
    useOauth,
    modelOptions,
    setModel,
    setApiKey,
    setBaseUrl,
    setConfirm,
    selectProvider,
    finish,
    submitSetup,
    runProbe,
    startOauth,
    stopOauth,
  }
}
