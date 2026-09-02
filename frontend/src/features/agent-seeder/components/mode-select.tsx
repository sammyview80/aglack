import { useState } from 'react'
import { toast } from 'sonner'
import { SlackOnboardingLayout } from '@/components/slack-onboarding-layout'
import { threadsUi } from '@/components/threads-ui'
import { StatusAlert } from '@/components/status-alert'
import { Button } from '@/components/ui/button'
import { isModeAvailable, MODES, type ModeId, type ModeOption } from '@/features/agent-seeder/modes'
import { handleError } from '@/lib/handle-error'
import { cn } from '@/lib/utils'
import { GATEWAY_WORKSPACE_ERRORS, isInvalidWorkspace } from '@/lib/workspace-errors'

const MODE_ERRORS: Record<string, string> = {
  ...GATEWAY_WORKSPACE_ERRORS,
}

type ModeSelectProps = {
  workspaceId: string
  onFinished: () => void
  onInvalidWorkspace: () => void
  onBack: () => void
}

export function ModeSelect({
  workspaceId,
  onFinished,
  onInvalidWorkspace,
  onBack,
}: ModeSelectProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [running, setRunning] = useState<ModeId | null>(null)

  async function runMode(mode: ModeOption) {
    if (!mode.run) {
      // MODES marks unavailable modes without a `run`, and the button
      // below is disabled for those — this guards the same invariant in
      // case a caller ever calls runMode directly.
      toast.message('Coming soon.')
      return
    }
    setRunning(mode.id)
    setBusy(true)
    setError('')
    try {
      const result = await mode.run(workspaceId)
      const count = result.agentsSeeded
      toast.success(count === 1 ? '1 agent seeded.' : `${count} agents seeded.`)
      onFinished()
    } catch (err) {
      if (isInvalidWorkspace(err)) {
        onInvalidWorkspace()
        return
      }
      setError(
        handleError(err, {
          fallback: 'Failed to seed agents',
          messagesByCode: MODE_ERRORS,
        }),
      )
    } finally {
      setBusy(false)
      setRunning(null)
    }
  }

  return (
    <SlackOnboardingLayout title="Choose a starting point">
      <div className="flex w-full flex-col gap-5">
        <div className="space-y-1">
          <h2>Choose a starting point</h2>
          <div className="divider" />
          <p className={threadsUi.postCopy}>Pick how this workspace's agents should be set up.</p>
        </div>

        <StatusAlert message={error} />

        <div className="flex flex-col gap-3">
          {MODES.map((mode) => {
            const available = isModeAvailable(mode)
            return (
              <button
                key={mode.id}
                type="button"
                disabled={busy || !available}
                onClick={() => void runMode(mode)}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-lg border border-input p-4 text-left transition-colors',
                  available ? 'hover:bg-accent hover:text-accent-foreground' : 'opacity-50',
                )}
              >
                <span className="flex w-full items-center justify-between text-sm font-medium">
                  {mode.label}
                  {!available ? (
                    <span className="text-xs font-normal text-muted-foreground">Coming soon</span>
                  ) : null}
                  {busy && running === mode.id ? (
                    <span className="text-xs font-normal text-muted-foreground">Seeding…</span>
                  ) : null}
                </span>
                <span className="text-sm text-muted-foreground">{mode.description}</span>
              </button>
            )
          })}
        </div>

        <Button type="button" variant="ghost" disabled={busy} onClick={onFinished}>
          Skip for now
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
          Back
        </Button>
      </div>
    </SlackOnboardingLayout>
  )
}
