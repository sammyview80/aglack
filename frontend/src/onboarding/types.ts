export type CreateDraft = {
  ownerName: string
  workspaceName: string
  password?: string
  kind?: 'headless' | 'server'
}

const DRAFT_KEY = 'hermes-fe-create-draft'
const OWNER_KEY = 'hermes-fe-owner-name'

export function saveCreateDraft(draft: CreateDraft): void {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  if (draft.ownerName.trim()) {
    localStorage.setItem(OWNER_KEY, draft.ownerName.trim())
  }
}

export function loadCreateDraft(): CreateDraft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    return JSON.parse(raw) as CreateDraft
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
