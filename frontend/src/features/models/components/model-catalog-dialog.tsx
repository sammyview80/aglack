import { Dialog } from '@base-ui/react/dialog'
import { useState } from 'react'
import { Check, Loader2, Plus, X } from 'lucide-react'
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

export function ModelCatalogDialog({
  workspaceId,
  open,
  onOpenChange,
  isSelected,
  onToggle,
}: ModelCatalogDialogProps) {
  const catalogQuery = useModelCatalog(workspaceId, open)
  const [customModelId, setCustomModelId] = useState('')
  const [customModelLabel, setCustomModelLabel] = useState('')
  const [customProvider, setCustomProvider] = useState('')
  const [customProviderInput, setCustomProviderInput] = useState('')

  function toggle(provider: string, model: CatalogModel) {
    onToggle({ id: model.id, label: model.label, provider })
  }

  const groups = catalogQuery.data?.groups ?? []
  const availableProviders = groups.map((g) => g.provider)

  function handleAddCustom(e: React.FormEvent) {
    e.preventDefault()
    const id = customModelId.trim()
    if (!id) return
    const resolvedProvider = (customProvider === '__other__' ? customProviderInput.trim() : customProvider.trim()) || 'custom'
    const label = customModelLabel.trim() || id

    onToggle({ id, label, provider: resolvedProvider })
    setCustomModelId('')
    setCustomModelLabel('')
    setCustomProviderInput('')
  }

  const selectedCount = groups.reduce(
    (count, group) => count + group.models.filter((model) => isSelected(group.provider, model.id)).length,
    0,
  )

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={modelsUi.overlay} />
        <Dialog.Popup className={modelsUi.popup} aria-label="Add model">
          <div className={modelsUi.sheetHandle} aria-hidden="true" />
          <div className={modelsUi.header}>
            <div>
              <Dialog.Title className={modelsUi.title}>Add model</Dialog.Title>
              <p className={modelsUi.subtitle}>Select models available in this chat.</p>
            </div>
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
            ) : groups.length === 0 ? (
              <p className={modelsUi.emptyText}>No models are available for this workspace.</p>
            ) : (
              groups.map((group) => (
                <section key={group.provider} className={modelsUi.groupBlock}>
                  <div className={modelsUi.groupLabel}>
                    <span>{group.provider}</span>
                    <span>{group.models.length}</span>
                  </div>
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
                        <span className={modelsUi.modelTick} aria-hidden="true">
                          <Check size={13} strokeWidth={3} />
                        </span>
                        <span className={modelsUi.modelLabel}>{model.label}</span>
                      </label>
                    )
                  })}
                </section>
              ))
            )}

            <section className={modelsUi.customSection}>
              <p className={modelsUi.customTitle}>Add custom model</p>
              <form onSubmit={handleAddCustom} className={modelsUi.customForm}>
                <div className={modelsUi.customRow}>
                  <input
                    type="text"
                    placeholder="Model ID (e.g. gpt-4-turbo, claude-3-5-sonnet)"
                    value={customModelId}
                    onChange={(e) => setCustomModelId(e.target.value)}
                    className={modelsUi.customInput}
                    aria-label="Custom model ID"
                  />
                  <input
                    type="text"
                    placeholder="Display name (optional)"
                    value={customModelLabel}
                    onChange={(e) => setCustomModelLabel(e.target.value)}
                    className={modelsUi.customInput}
                    aria-label="Custom model display name"
                  />
                </div>
                <div className={modelsUi.customRow}>
                  <select
                    value={customProvider}
                    onChange={(e) => setCustomProvider(e.target.value)}
                    className={modelsUi.customSelect}
                    aria-label="Custom model provider"
                  >
                    <option value="">Select provider...</option>
                    {availableProviders.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                    <option value="__other__">Other provider...</option>
                  </select>
                  {customProvider === '__other__' ? (
                    <input
                      type="text"
                      placeholder="Provider name (e.g. ollama, custom)"
                      value={customProviderInput}
                      onChange={(e) => setCustomProviderInput(e.target.value)}
                      className={modelsUi.customInput}
                      aria-label="Custom provider name"
                    />
                  ) : null}
                  <button
                    type="submit"
                    disabled={!customModelId.trim()}
                    className={modelsUi.customAddButton}
                    aria-label="Add custom model"
                  >
                    <Plus size={14} className="mr-1 inline-block" />
                    Add
                  </button>
                </div>
              </form>
            </section>
          </div>
          <div className={modelsUi.footer}>
            <span className={modelsUi.selectionCount}>
              {selectedCount ? `${selectedCount} selected` : 'Select a model'}
            </span>
            <Dialog.Close className={modelsUi.doneButton}>
              Done
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
