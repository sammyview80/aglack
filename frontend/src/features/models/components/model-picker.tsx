import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Loader2, Plus } from 'lucide-react'
import { modelsUi } from '@/features/models/models-ui'
import { setActiveModel } from '@/features/models/api'
import { useSelectedModels } from '@/features/models/hooks/use-selected-models'
import { useSessionModel } from '@/features/models/hooks/use-session-model'
import { usePendingModel } from '@/features/models/hooks/use-pending-model'
import { ModelCatalogDialog } from '@/features/models/components/model-catalog-dialog'
import { motionPresets } from '@/components/motion'
import { cn } from '@/lib/utils'
import { queryKeys } from '@/lib/query-keys'
import type { SelectedModel } from '@/features/models/types'

type ModelPickerProps = {
  workspaceId: string
  agent: string | null
  /** The chat session a pick switches the model FOR, and whose real
   * current model this picker's trigger label reflects — see the module
   * doc comment below and `api.ts`'s `setActiveModel` doc comment for why
   * this is session-scoped, not agent-scoped. */
  sessionId: string | null
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
 * Compact per-agent model picker, wired into `ChatComposer`'s toolbar
 * (message box), next to Attach/Voice. Reads ONLY the ticked shortlist
 * from `localStorage` (never the full catalog — that only loads inside
 * `ModelCatalogDialog` while it's open) so opening this menu is instant
 * and offline-safe.
 *
 * SESSION SCOPING — verified against the real Hermes WebUI frontend, not
 * assumed (see `api.ts`'s `setActiveModel` doc comment for the full
 * citation trail): a pick here calls `setActiveModel`, which is
 * `POST /api/session/update` with `{session_id, model, model_provider}`
 * — the EXACT call the real WebUI's own composer model dropdown makes
 * (`static/boot.js`, `$('modelSelect').onchange`). This writes directly
 * onto THIS session's own `model`/`model_provider` fields
 * (`backend/upstream/api/routes.py` line 15809) and takes effect
 * immediately — no "next turn" delay, no agent-wide default touched, no
 * other session or agent affected. The mutation's own response IS the
 * authoritative new session state (the handler echoes back the session
 * it just wrote), so this picker seeds the session-model query cache
 * straight from that response instead of guessing or waiting on a
 * separate refetch.
 *
 * NEW-CHAT CASE (no session exists yet) — also verified against the real
 * Hermes WebUI, not assumed: `POST /api/session/update` needs an existing
 * `session_id`, so it CANNOT be used before the first message is sent.
 * The real WebUI's own composer handles this by remembering the pick in
 * an in-memory `window._emptyComposerModelOverride` and forwarding it
 * into the NEXT `POST /api/session/new` call instead
 * (`backend/upstream/static/sessions.js` ~line 1296-1502). This picker
 * mirrors that exactly via `usePendingModel` (`pending-model-store.ts`):
 * with no `sessionId`, a pick writes to that pending store instead of
 * calling `setActiveModel`; `chat/hooks/use-chat.ts`'s `send()` reads it
 * back and threads it into `createSession`'s `model`/`model_provider`
 * fields when it lazily creates the session for the first message (see
 * `WorkspaceChat`'s own `usePendingModel` call, which shares this exact
 * same underlying store keyed by workspaceId+agent).
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
export function ModelPicker({ workspaceId, agent, sessionId }: ModelPickerProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const { selected, toggle, isSelected } = useSelectedModels(workspaceId, agent ?? '')
  const sessionModelQuery = useSessionModel(workspaceId, sessionId)
  const { pendingModel, setPending } = usePendingModel(workspaceId, agent)
  const queryClient = useQueryClient()

  const setModelMutation = useMutation({
    mutationFn: (model: SelectedModel) => {
      if (!sessionId) return Promise.reject(new Error('No active session yet'))
      return setActiveModel(workspaceId, sessionId, model.provider, model.id)
    },
    onSuccess: (result) => {
      // The response is the real, just-written session state — seed the
      // cache with it directly rather than invalidating and waiting on a
      // round trip. Scoped to THIS session's own key so a concurrent
      // switch on a different session (another tab/agent) can never
      // clobber this one's cached value.
      if (sessionId) {
        queryClient.setQueryData(queryKeys.models.sessionModel(workspaceId, sessionId), result)
      }
    },
  })

  const groups = groupByProvider(selected)
  const hasSelection = selected.length > 0
  // No session yet → the pending pick (if any) IS the current selection;
  // there is nothing server-side to reflect. With a session, prefer its
  // real current model (matched against the shortlist for a friendly
  // label, falling back to the raw model id when it isn't ticked).
  const currentModelId = sessionId ? (sessionModelQuery.data?.model ?? null) : (pendingModel?.id ?? null)
  const currentModel = sessionId
    ? currentModelId
      ? (selected.find((m) => m.id === currentModelId) ?? { id: currentModelId, label: currentModelId, provider: '' })
      : null
    : pendingModel
  const activeLabel = setModelMutation.isPending
    ? setModelMutation.variables?.label
    : (currentModel?.label ?? null)

  function pickModel(model: SelectedModel) {
    setMenuOpen(false)
    if (!sessionId) {
      // No session to update yet — stash the pick for createSession to
      // pick up on the next send (see this component's own doc comment).
      setPending(model)
      return
    }
    setModelMutation.mutate(model)
  }

  function openDialog() {
    setMenuOpen(false)
    setDialogOpen(true)
  }

  useEffect(() => {
    if (!menuOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [menuOpen])

  if (!agent) return null

  return (
    <div ref={pickerRef} className={modelsUi.pickerWrap}>
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
            : activeLabel
              ? activeLabel
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
                      currentModel?.provider === model.provider &&
                        currentModel?.id === model.id &&
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
