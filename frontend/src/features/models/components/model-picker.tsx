import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ChevronDown, Loader2, Plus } from 'lucide-react'
import { modelsUi } from '@/features/models/models-ui'
import { setActiveModel } from '@/features/models/api'
import { useSelectedModels } from '@/features/models/hooks/use-selected-models'
import { ModelCatalogDialog } from '@/features/models/components/model-catalog-dialog'
import { motionPresets } from '@/components/motion'
import { cn } from '@/lib/utils'
import type { SelectedModel } from '@/features/models/types'

type ModelPickerProps = {
  workspaceId: string
  agent: string | null
}

/** Groups the flat shortlist array (as persisted per-model in
 * `selected-models-store.ts`) back into `{provider, models}` buckets for
 * rendering — the store deliberately keeps a flat list (simplest possible
 * write shape for a toggle), so grouping is a pure display-time concern
 * done here rather than baked into storage. */
function groupByProvider(models: SelectedModel[]): { provider: string; models: SelectedModel[] }[] {
  const order: string[] = []
  const byProvider = new Map<string, SelectedModel[]>()
  for (const model of models) {
    if (!byProvider.has(model.provider)) {
      order.push(model.provider)
      byProvider.set(model.provider, [])
    }
    byProvider.get(model.provider)!.push(model)
  }
  return order.map((provider) => ({ provider, models: byProvider.get(provider)! }))
}

/**
 * Compact per-agent model picker, wired into `workspace-chat.tsx`'s header
 * next to the composer's other quick actions. Reads ONLY the ticked
 * shortlist from `localStorage` (never the full catalog — that only loads
 * inside `ModelCatalogDialog` while it's open) so opening this menu is
 * instant and offline-safe.
 *
 * Not built on `@base-ui/react`'s `Menu` primitive: this is a small,
 * fully-local open/closed dropdown with no submenus, no keyboard
 * roving-focus requirement beyond what native buttons already give you,
 * and it needs to be trivially testable without portal/positioner timing
 * — the same reasoning `ModelCatalogDialog` used to skip base-ui
 * `Checkbox` in favor of a native input. The dialog itself (which DOES
 * use base-ui `Dialog` per the task's explicit requirement) is opened
 * from the "Add model" row inside this menu.
 */
export function ModelPicker({ workspaceId, agent }: ModelPickerProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const { selected, toggle, isSelected } = useSelectedModels(workspaceId, agent ?? '')

  const setModelMutation = useMutation({
    mutationFn: (model: SelectedModel) => {
      if (!agent) return Promise.reject(new Error('No agent selected'))
      return setActiveModel(workspaceId, agent, model.provider, model.id)
    },
  })

  const groups = groupByProvider(selected)
  const hasSelection = selected.length > 0
  const activeLabel = setModelMutation.variables?.label

  function pickModel(model: SelectedModel) {
    setMenuOpen(false)
    setModelMutation.mutate(model)
  }

  function openDialog() {
    setMenuOpen(false)
    setDialogOpen(true)
  }

  if (!agent) return null

  return (
    <div className={modelsUi.pickerWrap}>
      <button
        type="button"
        className={modelsUi.pickerTrigger}
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {setModelMutation.isPending ? (
          <Loader2 size={14} className={motionPresets.spin} />
        ) : null}
        <span className={modelsUi.pickerTriggerLabel}>
          {setModelMutation.isPending && activeLabel
            ? `Switching to ${activeLabel}…`
            : hasSelection
              ? 'Model'
              : 'Add model'}
        </span>
        <ChevronDown size={14} />
      </button>

      {menuOpen ? (
        <div className={modelsUi.pickerMenu} role="menu">
          {!hasSelection ? (
            <p className={modelsUi.pickerEmpty}>
              No models picked yet. Use "Add model" to choose which models show up here.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.provider}>
                <div className={modelsUi.pickerGroupLabel}>{group.provider}</div>
                {group.models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitem"
                    className={cn(
                      modelsUi.pickerItem,
                      setModelMutation.variables?.provider === model.provider &&
                        setModelMutation.variables?.id === model.id &&
                        modelsUi.pickerItemActive,
                    )}
                    onClick={() => pickModel(model)}
                    disabled={setModelMutation.isPending}
                  >
                    {model.label}
                  </button>
                ))}
              </div>
            ))
          )}
          <div className={modelsUi.pickerDivider} />
          <button type="button" className={modelsUi.pickerAddAction} onClick={openDialog}>
            <Plus size={14} />
            Add model
          </button>
        </div>
      ) : null}

      {setModelMutation.isError ? (
        <p className={cn(modelsUi.errorText, 'mt-1.5 text-xs')}>
          {setModelMutation.error instanceof Error
            ? setModelMutation.error.message
            : 'Failed to switch model.'}
        </p>
      ) : null}

      <ModelCatalogDialog
        workspaceId={workspaceId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        isSelected={isSelected}
        onToggle={toggle}
      />
    </div>
  )
}
