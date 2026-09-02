import { Dialog } from '@base-ui/react/dialog'
import { Loader2, X } from 'lucide-react'
import { modelsUi } from '@/features/models/models-ui'
import { useModelCatalog } from '@/features/models/hooks/use-model-catalog'
import { motionPresets } from '@/components/motion'
import { cn } from '@/lib/utils'
import type { CatalogModel, SelectedModel } from '@/features/models/types'

type ModelCatalogDialogProps = {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  isSelected: (provider: string, id: string) => boolean
  onToggle: (model: SelectedModel) => void
}

/**
 * Full model-catalog dialog ("Add model"). Built on `@base-ui/react`'s
 * `Dialog` primitive (`Dialog.Root`/`Portal`/`Backdrop`/`Popup`/`Close` —
 * a controlled `open`/`onOpenChange` root rendering plain `<div>`/
 * `<button>` elements per its own type defs at
 * `node_modules/@base-ui/react/dialog/**\/*.d.ts`; there is no prior usage
 * of `Dialog` in this codebase to mirror, `tooltip.tsx`'s
 * Portal/Positioner/Popup shape for `Tooltip` was the closest existing
 * base-ui idiom and this follows the same Portal/Popup layering).
 *
 * Ticks are checkboxes rendered as plain `<input type="checkbox">` (no
 * base-ui `Checkbox` here — that primitive renders a hidden native input
 * behind a styled `<span>` and needs an `Indicator` child; a native input
 * is simpler, keyboard/label-accessible for free, and trivially testable
 * with `getByRole('checkbox')`/`userEvent.click`, and this task's
 * checkbox has no need for tri-state/indeterminate).
 *
 * PERSISTENCE TIMING (explicit product decision, since the task left this
 * open): every tick/untick writes to `selected-models-store.ts`
 * (localStorage) IMMEDIATELY via `onToggle`, not batched until a confirm
 * button. Rationale: (1) the task's own item 2 says "the moment the user
 * ticks/unticks *or* on dialog close/confirm" — immediate-write already
 * satisfies "survives a page reload" trivially and is a strict superset
 * of the close/confirm timing; (2) an unconfirmed-ticks-discarded design
 * would need its own separate draft state that the dialog re-syncs into
 * the real store on confirm, adding a second source of truth for no
 * additional benefit here (there is no expensive submit step to protect
 * against, unlike e.g. draft-storage.ts's create-workspace form); (3) a
 * modal a user can dismiss with Escape/outside-click should not silently
 * discard changes the user visibly saw take effect on click.  So: closing
 * WITHOUT an explicit "confirm" always keeps whatever was ticked — there
 * is deliberately no separate discard path.
 */
export function ModelCatalogDialog({
  workspaceId,
  open,
  onOpenChange,
  isSelected,
  onToggle,
}: ModelCatalogDialogProps) {
  // Gated on `open` (never fetches while closed) and forced fresh on every
  // open — see use-model-catalog.ts's doc comment for why `staleTime: 0`
  // + `refetchOnMount: 'always'` is required for that, not just `enabled`.
  const catalogQuery = useModelCatalog(workspaceId, open)

  function toggle(provider: string, model: CatalogModel) {
    onToggle({ id: model.id, label: model.label, provider })
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={modelsUi.overlay} />
        <Dialog.Popup className={modelsUi.popup} aria-label="Add model">
          <div className={modelsUi.header}>
            <Dialog.Title className={modelsUi.title}>Add model</Dialog.Title>
            <Dialog.Close className={modelsUi.closeButton} aria-label="Close">
              <X size={16} />
            </Dialog.Close>
          </div>
          <div className={modelsUi.body}>
            {catalogQuery.isPending ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={20} className={cn('text-[var(--th-muted)]', motionPresets.spin)} />
              </div>
            ) : catalogQuery.isError ? (
              <p className={modelsUi.errorText}>
                {catalogQuery.error instanceof Error
                  ? catalogQuery.error.message
                  : 'Failed to load models.'}
              </p>
            ) : !catalogQuery.data || catalogQuery.data.groups.length === 0 ? (
              <p className={modelsUi.emptyText}>No models are available for this workspace.</p>
            ) : (
              catalogQuery.data.groups.map((group) => (
                <div key={group.provider} className={modelsUi.groupBlock}>
                  <div className={modelsUi.groupLabel}>{group.provider}</div>
                  {group.models.map((model) => {
                    const checked = isSelected(group.provider, model.id)
                    const inputId = `model-tick-${group.provider}-${model.id}`
                    return (
                      <label key={model.id} htmlFor={inputId} className={modelsUi.modelRow}>
                        <input
                          id={inputId}
                          type="checkbox"
                          className={modelsUi.checkbox}
                          checked={checked}
                          onChange={() => toggle(group.provider, model)}
                        />
                        <span className={modelsUi.modelLabel}>{model.label}</span>
                      </label>
                    )
                  })}
                </div>
              ))
            )}
          </div>
          <div className={modelsUi.footer}>
            <Dialog.Close className={cn(modelsUi.closeButton, 'w-auto rounded-lg px-3.5')}>
              Done
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
