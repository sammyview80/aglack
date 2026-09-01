import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { SlackOnboardingLayout } from '@/components/slack-onboarding-layout'
import { FormField } from '@/components/form-field'
import { PageFallback } from '@/components/page-fallback'
import { PasswordInput } from '@/components/password-input'
import { StatusAlert } from '@/components/status-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { APP_NAME } from '@/lib/brand'
import { cn } from '@/lib/utils'
import { GATEWAY_WORKSPACE_ERRORS, isInvalidWorkspace } from '@/lib/workspace-errors'

const ONBOARDING_ERRORS: Record<string, string> = {
  ...GATEWAY_WORKSPACE_ERRORS,
  onboarding_setup_failed: 'Setup failed — check provider, model, and key.',
  oauth_start_failed: 'This provider does not support OAuth here.',
  oauth_poll_failed: 'OAuth session expired or was not found.',
}

const SELF_HOSTED = new Set(['ollama', 'lmstudio'])

type OnboardingWizardProps = {
  workspaceId: string
  onFinished: () => void
  onInvalidWorkspace: () => void
  onBack: () => void
}

export function OnboardingWizard({
  workspaceId,
  onFinished,
  onInvalidWorkspace,
  onBack,
}: OnboardingWizardProps) {
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

  if (loadError && !status) {
    return (
      <PageFallback
        title="Cannot load onboarding"
        description={loadError}
        actionLabel="Retry"
        onAction={() => window.location.reload()}
        onBack={onBack}
      />
    )
  }

  if (!status) {
    return (
      <PageFallback
        title="Loading onboarding"
        description="Fetching provider catalog through the gateway."
        onBack={onBack}
      />
    )
  }

  if (status.completed) {
    return (
      <Shell>
        <CompleteCard status={status} onDone={onFinished} onBack={onBack} />
      </Shell>
    )
  }

  const rawCats = status.setup.categories ?? []
  const fallbackIds = (status.setup.providers ?? []).map((p) => p.id)
  const categories = [
    ...(rawCats.length > 0 ? rawCats : [{ id: 'all', label: 'Providers', providers: fallbackIds }]),
  ].sort((a, b) => {
    const order = ['easy_start', 'self_hosted', 'specialized']
    return order.indexOf(a.id) - order.indexOf(b.id)
  })

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

  const modelOptions = probeModels.length > 0 ? probeModels : (selected?.models ?? [])

  return (
    <Shell>
      <form
        className="flex w-full flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          void submitSetup(false)
        }}
      >
        <div className="space-y-1">
          <h2>Set up {APP_NAME}</h2>
          <div className="divider" />
          <p className="post-copy">Chat/text models only. Pick a provider, then save.</p>
        </div>

        <StatusAlert message={error} />

        {confirm ? (
          <div className="space-y-3 rounded-lg border border-input p-3">
            <p className="text-sm">{confirm.message}</p>
            <div className="flex gap-2">
              <Button type="button" disabled={busy} onClick={() => void submitSetup(true)}>
                Overwrite
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {categories.map((cat) => (
          <div key={cat.id} className="space-y-2">
            <p className="text-sm font-medium">{cat.label}</p>
            <div className="flex flex-wrap gap-2">
              {cat.providers.map((id) => {
                const p = providersById.get(id)
                if (!p) return null
                return (
                  <Button
                    key={id}
                    type="button"
                    variant={providerId === id ? 'default' : 'outline'}
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setProviderId(id)
                      setModel(p.defaultModel || p.models?.[0]?.id || '')
                      setBaseUrl(p.defaultBaseUrl || '')
                      setApiKey('')
                      setConfirm(null)
                      setProbeModels([])
                      setOauth(null)
                      setError('')
                    }}
                  >
                    {p.label}
                  </Button>
                )
              })}
            </div>
          </div>
        ))}

        {selected && useOauth ? (
          <div className="space-y-3">
            {oauth ? (
              <>
                <p className="text-sm">Status: {oauth.status}</p>
                {oauth.userCode ? (
                  <p className="text-sm">
                    Code: <span className="font-mono">{oauth.userCode}</span>
                  </p>
                ) : null}
                {oauth.verificationUri ? (
                  <a
                    className="text-sm underline"
                    href={oauth.verificationUriComplete || oauth.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open verification
                  </a>
                ) : null}
                <Button type="button" variant="ghost" disabled={busy} onClick={() => void stopOauth()}>
                  Cancel OAuth
                </Button>
                {oauth.status === 'success' ? (
                  <Button type="button" disabled={busy} onClick={() => void finish()}>
                    Continue
                  </Button>
                ) : null}
              </>
            ) : (
              <Button type="button" disabled={busy} onClick={() => void startOauth()}>
                {selected.oauthLabel || 'Connect with OAuth'}
              </Button>
            )}
          </div>
        ) : null}

        {selected && !useOauth ? (
          <>
            {selected.requiresBaseUrl || SELF_HOSTED.has(selected.id) ? (
              <FormField label="Base URL" htmlFor="ob-base">
                <div className="flex gap-2">
                  <Input
                    id="ob-base"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    disabled={busy}
                    required={Boolean(selected.requiresBaseUrl) || SELF_HOSTED.has(selected.id)}
                  />
                  {selected.requiresBaseUrl || SELF_HOSTED.has(selected.id) ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || !baseUrl}
                      onClick={() => void runProbe()}
                    >
                      Probe
                    </Button>
                  ) : null}
                </div>
              </FormField>
            ) : null}

            {!selected.keyOptional ? (
              <FormField label="API key" htmlFor="ob-key" hint={selected.envVar}>
                <PasswordInput
                  id="ob-key"
                  value={apiKey}
                  onChange={setApiKey}
                  disabled={busy}
                  autoComplete="off"
                />
              </FormField>
            ) : (
              <FormField label="API key" htmlFor="ob-key" optional="Optional">
                <PasswordInput id="ob-key" value={apiKey} onChange={setApiKey} disabled={busy} autoComplete="off" />
              </FormField>
            )}

            <FormField label="Model" htmlFor="ob-model">
              {modelOptions.length > 0 ? (
                <select
                  id="ob-model"
                  className={cn(
                    'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm',
                  )}
                  value={model}
                  disabled={busy}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label || m.id}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="ob-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={busy}
                  required
                />
              )}
            </FormField>

            <Button type="submit" size="lg" disabled={busy || !model} className="w-full">
              {busy ? 'Saving…' : 'Save and continue'}
            </Button>
          </>
        ) : null}

        <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
          Back
        </Button>

        {status.setup.unsupportedNote ? (
          <p className="text-xs text-muted-foreground">{status.setup.unsupportedNote}</p>
        ) : null}
      </form>
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return <SlackOnboardingLayout>{children}</SlackOnboardingLayout>
}

function CompleteCard({
  status,
  onDone,
  onBack,
}: {
  status: OnboardingStatus
  onDone: () => void
  onBack: () => void
}) {
  const current = status.setup.current
  const provider = (status.setup.providers ?? []).find((p) => p.id === current?.provider)
  const rows = [
    current?.provider
      ? { label: 'Provider', value: provider?.label || current.provider }
      : null,
    current?.model ? { label: 'Model', value: current.model } : null,
    current?.baseUrl ? { label: 'Endpoint', value: current.baseUrl } : null,
    status.setup.currentIsOauth ? { label: 'Sign-in', value: 'Connected with OAuth' } : null,
  ].filter((row): row is { label: string; value: string } => Boolean(row))

  return (
    <>
      <span className="mb-4 grid size-10 place-items-center rounded-full bg-primary/10 text-primary">
        <Check size={18} strokeWidth={2.5} aria-hidden="true" />
      </span>
      <h2>Ready to chat</h2>
      <div className="divider" />
      <p className="post-copy">
        This workspace already has a model. You can start chatting now, or change the provider later from
        setup.
      </p>
      {rows.length > 0 ? (
        <dl className="mt-5 w-full overflow-hidden rounded-xl border border-border">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
            >
              <dt className="shrink-0 text-xs tracking-wide text-muted-foreground">{row.label}</dt>
              <dd className="truncate text-right text-sm font-medium">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <Button type="button" size="lg" className="mt-6 w-full" onClick={onDone}>
        Continue
      </Button>
      <Button type="button" variant="ghost" className="mt-2 w-full" onClick={onBack}>
        Back
      </Button>
    </>
  )
}
