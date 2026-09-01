import { useEffect, useMemo, useState } from 'react'
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
import { handleError } from '@/lib/handle-error'
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
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [confirm, setConfirm] = useState<SetupNeedsConfirm | null>(null)
  const [probeModels, setProbeModels] = useState<{ id: string; label: string }[]>([])
  const [oauth, setOauth] = useState<OAuthFlow | null>(null)

  const providersById = useMemo(() => {
    const map = new Map<string, ProviderCatalogEntry>()
    for (const p of status?.setup.providers ?? []) map.set(p.id, p)
    return map
  }, [status])

  const selected = providersById.get(providerId)
  const useOauth = Boolean(selected?.oauthProvider)

  useEffect(() => {
    let cancelled = false
    getOnboardingStatus(workspaceId)
      .then((next) => {
        if (cancelled) return
        setStatus(next)
        const current = next.setup.current?.provider
        if (!current) return
        setProviderId(current)
        const p = (next.setup.providers ?? []).find((row) => row.id === current)
        if (p) {
          setModel(p.defaultModel || p.models?.[0]?.id || '')
          setBaseUrl(p.defaultBaseUrl || '')
        }
      })
      .catch((err) => {
        if (cancelled) return
        if (isInvalidWorkspace(err)) {
          toast.message(
            'This onboarding link needs a workspace that exists and is ready. Create one first.',
          )
          onInvalidWorkspace()
          return
        }
        setLoadError(
          handleError(err, {
            fallback: 'Failed to load onboarding status',
            messagesByCode: ONBOARDING_ERRORS,
          }),
        )
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, onInvalidWorkspace])

  useEffect(() => {
    if (!oauth || oauth.status !== 'pending') return
    const flowId = oauth.flowId
    const id = window.setInterval(() => {
      pollOAuthFlow(workspaceId, flowId)
        .then((next) => {
          setOauth(next)
          if (next.status === 'success') {
            toast.success('OAuth connected.')
          }
        })
        .catch((err) => {
          setError(
            handleError(err, {
              fallback: 'OAuth poll failed',
              messagesByCode: ONBOARDING_ERRORS,
            }),
          )
          setOauth((prev) => (prev ? { ...prev, status: 'error' } : prev))
        })
    }, 3000)
    return () => window.clearInterval(id)
  }, [workspaceId, oauth?.flowId, oauth?.status])

  async function finish(next?: OnboardingStatus) {
    const done = next ?? (await completeOnboarding(workspaceId))
    setStatus(done)
    toast.success('Model setup saved.')
    onFinished()
  }

  async function submitSetup(confirmOverwrite = false) {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      if (SELF_HOSTED.has(selected.id)) {
        await applySelfHostedSetup(workspaceId, {
          provider: selected.id,
          model,
          apiKey: apiKey || undefined,
          baseUrl: baseUrl || undefined,
          activate: true,
        })
        await finish()
        return
      }
      const data = await applyOnboardingSetup(workspaceId, {
        provider: selected.id,
        model,
        apiKey: apiKey || undefined,
        baseUrl: baseUrl || undefined,
        confirmOverwrite: confirmOverwrite || undefined,
      })
      if (isSetupNeedsConfirm(data)) {
        setConfirm(data)
        return
      }
      await finish(data.completed ? data : undefined)
    } catch (err) {
      setError(
        handleError(err, {
          fallback: 'Failed to apply setup',
          messagesByCode: ONBOARDING_ERRORS,
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  async function runProbe() {
    setBusy(true)
    setError('')
    try {
      const result = await probeProvider(workspaceId, {
        provider: selected?.id,
        baseUrl,
        apiKey: apiKey || undefined,
      })
      if (!result.ok) {
        setError(result.error || result.detail || 'Probe failed')
        toast.error(result.error || 'Cannot reach that base URL')
        return
      }
      setProbeModels(result.models ?? [])
      if (result.models?.[0]) setModel(result.models[0].id)
      toast.success('Endpoint reachable.')
    } catch (err) {
      setError(
        handleError(err, {
          fallback: 'Probe failed',
          messagesByCode: ONBOARDING_ERRORS,
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  async function startOauth() {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const flow = await startOAuthFlow(workspaceId, selected.id)
      setOauth(flow)
    } catch (err) {
      setError(
        handleError(err, {
          fallback: 'Could not start OAuth',
          messagesByCode: ONBOARDING_ERRORS,
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  async function stopOauth() {
    if (!oauth) return
    setBusy(true)
    try {
      await cancelOAuthFlow(workspaceId, oauth.flowId, selected?.id)
      setOauth(null)
    } catch (err) {
      setError(
        handleError(err, {
          fallback: 'Could not cancel OAuth',
          messagesByCode: ONBOARDING_ERRORS,
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  function selectProvider(id: string, p: ProviderCatalogEntry) {
    setProviderId(id)
    setModel(p.defaultModel || p.models?.[0]?.id || '')
    setBaseUrl(p.defaultBaseUrl || '')
    setApiKey('')
    setConfirm(null)
    setProbeModels([])
    setOauth(null)
    setError('')
  }

  const modelOptions = probeModels.length > 0 ? probeModels : (selected?.models ?? [])

  return {
    status,
    loadError,
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
