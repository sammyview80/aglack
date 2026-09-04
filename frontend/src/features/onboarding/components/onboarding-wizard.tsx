import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { SlackOnboardingLayout } from '@/components/slack-onboarding-layout'
import { FormField } from '@/components/form-field'
import { threadsUi } from '@/components/threads-ui'
import { PageFallback } from '@/components/page-fallback'
import { PasswordInput } from '@/components/password-input'
import { StatusAlert } from '@/components/status-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useOnboardingWizard } from '@/features/onboarding/hooks/use-onboarding-wizard'
import type { OnboardingStatus } from '@/features/onboarding/types'
import { APP_NAME } from '@/lib/brand'
import { cn } from '@/lib/utils'

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
  const {
    status,
    loadError,
    refetchStatus,
    busy,
    error,
    apiKey,
    baseUrl,
    confirm,
    oauth,
    providersById,
    selected,
    useOauth,
    modelOptions,
    model,
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
  } = useOnboardingWizard({ workspaceId, onInvalidWorkspace, onFinished })

  if (loadError && !status) {
    return (
      <PageFallback
        title="Cannot load onboarding"
        description={loadError}
        actionLabel="Retry"
        onAction={() => void refetchStatus()}
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
      <Shell workspaceId={workspaceId}>
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

  return (
    <Shell workspaceId={workspaceId}>
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
          <p className={threadsUi.postCopy}>Chat/text models only. Pick a provider, then save.</p>
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
                    variant={selected?.id === id ? 'default' : 'outline'}
                    size="sm"
                    disabled={busy}
                    onClick={() => selectProvider(id, p)}
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

const SELF_HOSTED = new Set(['ollama', 'lmstudio'])

function Shell({ children, workspaceId }: { children: ReactNode; workspaceId: string }) {
  return <SlackOnboardingLayout workspaceId={workspaceId}>{children}</SlackOnboardingLayout>
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
      <p className={threadsUi.postCopy}>
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
