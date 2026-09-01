import { Button } from '@/components/ui/button'
import { PageFallback } from '@/components/page-fallback'
import { StatusAlert } from '@/components/status-alert'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Workspace: {workspaceName}</CardTitle>
          <CardDescription>
            {result.status === 'ready' && `Ready. Container: ${result.containerName}`}
            {result.status === 'creating' &&
              'Still creating — the gateway accepted the request but there is no status endpoint yet to confirm when it finishes. Try again in a moment.'}
            {result.status === 'failed' && 'Workspace creation failed.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <StatusAlert message={error} />
          {result.status === 'ready' ? (
            <>
              <Button type="button" onClick={onContinue}>
                Continue to setup
              </Button>
              <Button type="button" variant="ghost" onClick={onDone}>
                Done
              </Button>
            </>
          ) : (
            <Button type="button" onClick={onRetry} disabled={busy}>
              {busy ? 'Working…' : result.status === 'failed' ? 'Retry' : 'Try again'}
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
