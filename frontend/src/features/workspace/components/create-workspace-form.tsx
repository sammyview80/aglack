import { useState, type FormEvent } from 'react'
import { ArrowRight } from 'lucide-react'
import { threadsUi } from '@/components/threads-ui'
import { SlackOnboardingLayout } from '@/components/slack-onboarding-layout'
import { FormField } from '@/components/form-field'
import { StatusAlert } from '@/components/status-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { APP_NAME } from '@/lib/brand'
import type { CreateWorkspaceInput } from '@/features/workspace/types'

type CreateWorkspaceFormProps = {
  onBack: () => void
  onCreate: (input: CreateWorkspaceInput) => void
  busy: boolean
  error: string
  initial?: Partial<CreateWorkspaceInput>
}

export function CreateWorkspaceForm({
  onBack,
  onCreate,
  busy,
  error,
  initial,
}: CreateWorkspaceFormProps) {
  const [ownerName, setOwnerName] = useState(initial?.ownerName || '')
  const [workspaceName, setWorkspaceName] = useState(initial?.workspaceName || '')

  function submit(e: FormEvent) {
    e.preventDefault()
    const owner = ownerName.trim()
    const ws = workspaceName.trim()
    if (!owner || !ws || busy) return
    onCreate({
      ownerName: owner,
      workspaceName: ws,
    })
  }

  return (
    <SlackOnboardingLayout step={1} title="Create" workspaceName={workspaceName || APP_NAME}>
      <form className="flex w-full flex-col gap-5" onSubmit={submit}>
        <h2>Create a workspace</h2>
        <div className="divider" />
        <p className={threadsUi.postCopy}>Choose a name for your new workspace.</p>

        <StatusAlert message={error} />

        <FormField
          label="Your name"
          htmlFor="owner-name"
          hint="Shown to teammates as the workspace owner."
        >
          <Input
            id="owner-name"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            disabled={busy}
            autoFocus
            autoComplete="name"
            placeholder="e.g. Alex"
            required
          />
        </FormField>

        <FormField
          label="Workspace name"
          htmlFor="ws-name"
          hint="Short and memorable. This is what you’ll see in the sidebar."
        >
          <div className="flex min-w-0 flex-nowrap overflow-hidden rounded-xl border border-input focus-within:border-foreground">
            <span className="inline-flex shrink-0 items-center whitespace-nowrap bg-muted px-2.5 text-sm leading-none text-muted-foreground">
              aglack&nbsp;/
            </span>
            <Input
              id="ws-name"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              disabled={busy}
              autoComplete="off"
              placeholder="my-workspace"
              required
              className="min-w-0 w-0 flex-1 rounded-none border-0 focus-visible:ring-0"
            />
          </div>
        </FormField>

        <div className="flex flex-col gap-2 pt-1">
          <Button
            type="submit"
            size="lg"
            disabled={busy || !ownerName.trim() || !workspaceName.trim()}
            className="w-full"
          >
            {busy ? 'Creating…' : 'Create workspace'}
            <ArrowRight data-icon="inline-end" />
          </Button>
          <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
            Back
          </Button>
        </div>
      </form>
    </SlackOnboardingLayout>
  )
}
