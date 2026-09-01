import { useState, type FormEvent } from 'react'
import { ArrowRight } from 'lucide-react'
import { BrandMark } from '@/components/brand-mark'
import { FormField } from '@/components/form-field'
import { PasswordInput } from '@/components/password-input'
import { StatusAlert } from '@/components/status-alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ThemeSwitch } from '@/features/theme/theme-switch'
import { WorkspacePreview } from '@/features/workspace/components/workspace-preview'
import type { CreateWorkspaceInput, WorkspaceKind } from '@/features/workspace/types'
import { cn } from '@/lib/utils'

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
  const [password, setPassword] = useState(initial?.password || '')
  const [kind, setKind] = useState<WorkspaceKind>(initial?.kind || 'headless')

  function submit(e: FormEvent) {
    e.preventDefault()
    const owner = ownerName.trim()
    const ws = workspaceName.trim()
    if (!owner || !ws || busy) return
    onCreate({
      ownerName: owner,
      workspaceName: ws,
      password: password.trim() || undefined,
      kind,
    })
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(280px,46vw)]">
      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 px-6 pt-4">
          <BrandMark />
          <ThemeSwitch />
        </header>

        <form
          className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 px-6 py-8"
          onSubmit={submit}
        >
          <div className="space-y-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Step 1 of 4
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">Create a workspace</h1>
            <p className="text-sm text-muted-foreground">
              Choose a name and environment for your new workspace.
            </p>
          </div>

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
            <div className="flex overflow-hidden rounded-lg border border-input focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
              <span className="flex items-center bg-muted px-2.5 text-sm text-muted-foreground">
                hermes /
              </span>
              <Input
                id="ws-name"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                disabled={busy}
                autoComplete="off"
                placeholder="my-workspace"
                required
                className="rounded-none border-0 focus-visible:ring-0"
              />
            </div>
          </FormField>

          <FormField
            label="Password"
            htmlFor="ws-password"
            optional="Optional"
            hint="Protect access to this workspace with a private password."
          >
            <PasswordInput
              id="ws-password"
              value={password}
              onChange={setPassword}
              disabled={busy}
              placeholder="Add an extra layer of security"
            />
          </FormField>

          <FormField label="Workspace type" optional="Default: Standard">
            <div role="radiogroup" aria-label="Workspace type" className="grid grid-cols-2 gap-2">
              <KindOption
                title="Standard"
                hint="Fast, lightweight chat workspace"
                selected={kind === 'headless'}
                disabled={busy}
                onSelect={() => setKind('headless')}
              />
              <KindOption
                title="Desktop"
                hint="Full Linux desktop with a browser, for visual/GUI tasks"
                selected={kind === 'server'}
                disabled={busy}
                onSelect={() => setKind('server')}
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
      </section>

      <WorkspacePreview name={workspaceName} />
    </div>
  )
}

function KindOption({
  title,
  hint,
  selected,
  disabled,
  onSelect,
}: {
  title: string
  hint: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
        selected
          ? 'border-ring bg-accent'
          : 'border-input bg-transparent hover:bg-muted',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  )
}
