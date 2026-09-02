/**
 * Persistence for the in-progress create-workspace form (so a reload or a
 * bounce through onboarding does not lose what the user typed).
 *
 * SECURITY: the workspace `password` is deliberately NEVER persisted.
 * `CreateWorkspaceInput` carries an optional `password`, but sessionStorage
 * is readable by any script running on this origin (and survives reloads
 * for the life of the tab), so writing a credential there turns a
 * transient form value into a stored one. `StoredCreateDraft` is therefore
 * `Omit<CreateWorkspaceInput, 'password'>` — the stored type does not
 * merely happen to lack a password, it cannot express one, so a future
 * caller cannot reintroduce the leak without changing this type.
 *
 * `saveCreateDraft` accepts the full input (callers hold one) and copies
 * ONLY the password-free fields across, rather than deleting a key from a
 * spread copy — a spread-then-delete leaves the password in the object
 * momentarily and relies on every future field addition remembering to
 * re-do the deletion.
 *
 * `loadCreateDraft` fails closed: a draft written by an OLDER build of
 * this app may already contain a `password` key in sessionStorage, so the
 * read path re-projects whatever it parses onto the password-free shape
 * and never returns a password, even when one is physically present in
 * storage. Callers therefore always start with an empty password field and
 * the user re-enters it.
 */
import type { CreateWorkspaceInput } from '@/features/workspace/types'

const DRAFT_KEY = 'hermes-fe-create-draft'
const OWNER_KEY = 'hermes-fe-owner-name'

/**
 * Exactly what may be written to sessionStorage: the create-workspace
 * draft with the credential removed at the type level.
 */
export type StoredCreateDraft = Omit<CreateWorkspaceInput, 'password'>

/**
 * Project any parsed/incoming draft-shaped value onto the password-free
 * stored shape. Named fields only — an unknown extra key in stored JSON
 * (notably a legacy `password` from an earlier build) is dropped here
 * rather than carried through.
 */
function withoutPassword(draft: Partial<CreateWorkspaceInput>): StoredCreateDraft {
  return {
    ownerName: typeof draft.ownerName === 'string' ? draft.ownerName : '',
    workspaceName: typeof draft.workspaceName === 'string' ? draft.workspaceName : '',
    ...(draft.kind ? { kind: draft.kind } : {}),
  }
}

export function saveCreateDraft(draft: CreateWorkspaceInput): void {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(withoutPassword(draft)))
  if (draft.ownerName.trim()) {
    localStorage.setItem(OWNER_KEY, draft.ownerName.trim())
  }
}

export function loadCreateDraft(): StoredCreateDraft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    // Re-projected, not cast: a legacy stored `password` is discarded here
    // instead of being handed back to the form.
    return withoutPassword(parsed as Partial<CreateWorkspaceInput>)
  } catch {
    return null
  }
}

export function clearCreateDraft(): void {
  sessionStorage.removeItem(DRAFT_KEY)
}

export function loadOwnerName(): string {
  return localStorage.getItem(OWNER_KEY) || ''
}
