import { SlackOnboardingLayout } from '@/components/slack-onboarding-layout'
import { Button } from '@/components/ui/button'
import { threadsUi } from '@/components/threads-ui'
import { PageFallback } from '@/components/page-fallback'
import { StatusAlert } from '@/components/status-alert'
import type { CreateWorkspaceResult } from '@/features/workspace/types'

type CreatingStatusProps = {
  workspaceName: string
  result: CreateWorkspaceResult | null
  error: string
  busy: boolean
  onRetry: () => void
  onContinue: () => void
  onDone: () => void
  onBack: () => void
}

export function CreatingStatus({
  workspaceName,
  result,
  error,
  busy,
  onRetry,
  onContinue,
  onDone,
  onBack,
}: CreatingStatusProps) {
  if (!result) {
    return (
      <PageFallback
        title="No workspace creation in progress"
        description="Open this page from the create form. A hard refresh loses the one-shot gateway response — there is no status-poll endpoint yet."
        actionLabel="Back to create workspace"
        onAction={onBack}
      />
    )
  }

  return (
    <SlackOnboardingLayout title="Creating" workspaceName={workspaceName} busy={busy}>
      <h2>
        {result.status === 'ready' && 'Ready'}
        {result.status === 'creating' && 'Still creating'}
        {result.status === 'failed' && 'Creation failed'}
      </h2>
      <div className="divider" />
      <p className={threadsUi.postCopy}>
        {result.status === 'ready' && `Container: ${result.containerName}`}
        {result.status === 'creating' &&
          'The gateway accepted the request but there is no status endpoint yet to confirm when it finishes. Try again in a moment.'}
        {result.status === 'failed' && 'Workspace creation failed.'}
      </p>
      <div className="mt-6 flex flex-col gap-3">
        <StatusAlert message={error} />
        {result.status === 'ready' ? (
          <>
            <Button type="button" size="lg" onClick={onContinue}>
              Continue to setup
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="lg" onClick={onRetry} disabled={busy}>
              {busy ? 'Working…' : result.status === 'failed' ? 'Retry' : 'Try again'}
            </Button>
            <Button type="button" variant="ghost" onClick={onBack}>
              Back
            </Button>
          </>
        )}
      </div>
    </SlackOnboardingLayout>
  )
}
