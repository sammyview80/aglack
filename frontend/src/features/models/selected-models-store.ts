import type { SelectedModel } from '@/features/models/types'

/** Ticked-model shortlist — one key per workspace+agent pair, in
 * `localStorage` (not `sessionStorage` like `chat-session-store.ts`: a
 * shortlist is a deliberate per-agent preference the user built up over
 * time, not a tab-scoped "what am I looking at right now" pointer, so it
 * should survive closing the tab/browser the same way a saved setting
 * would). Mirrors `chat-session-store.ts`'s exact isolation rule: reading
 * agent B's key must never see agent A's ticks, and ticking a model for
 * agent A must never write into agent B's slot — one agent's shortlist is
 * never shared, inherited, or defaulted from another's. */
const PREFIX = 'hermano.models.selected'

function storageKey(workspaceId: string, agent: string): string {
  return `${PREFIX}.${workspaceId}.${agent}`
}

/** Defensive shape guard for whatever JSON happens to be sitting under
 * this key — a hand-edited or stale-schema value must never crash the
 * picker, it should just look like "nothing selected yet". */
function isSelectedModel(value: unknown): value is SelectedModel {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SelectedModel).id === 'string' &&
    typeof (value as SelectedModel).label === 'string' &&
    typeof (value as SelectedModel).provider === 'string'
  )
}

export function readSelectedModels(workspaceId: string, agent: string): SelectedModel[] {
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId, agent))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSelectedModel)
  } catch {
    return []
  }
}

export function writeSelectedModels(
  workspaceId: string,
  agent: string,
  models: SelectedModel[],
): void {
  try {
    window.localStorage.setItem(storageKey(workspaceId, agent), JSON.stringify(models))
  } catch {
    /* storage unavailable — best-effort */
  }
}

/** Toggle one model in/out of the shortlist by `(provider, id)` identity
 * (a model id can repeat across providers — e.g. two custom endpoints
 * both exposing `gpt-4o` — so identity must include `provider`, matching
 * the pair `POST /api/session/update` itself keys on via its
 * `model`/`model_provider` fields — see `api.ts`'s `setActiveModel`).
 * Returns the resulting list so callers can update in-memory state
 * without a second read. */
export function toggleSelectedModel(
  workspaceId: string,
  agent: string,
  model: SelectedModel,
): SelectedModel[] {
  const current = readSelectedModels(workspaceId, agent)
  const isSelected = current.some((m) => m.provider === model.provider && m.id === model.id)
  const next = isSelected
    ? current.filter((m) => !(m.provider === model.provider && m.id === model.id))
    : [...current, model]
  writeSelectedModels(workspaceId, agent, next)
  return next
}
