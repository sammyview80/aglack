/**
 * The mode catalog `mode-select.tsx` renders and dispatches from. Adding a
 * new mode is adding one entry here — the component itself has no
 * per-mode branching logic.
 *
 * A mode is either:
 * - unavailable (`run` omitted) — rendered disabled with a "Coming soon"
 *   badge, never clickable.
 * - available (`run` present) — an async function that performs whatever
 *   that mode actually does for a workspace and resolves the count of
 *   agents seeded (for the success toast). Every mode's `run` shares one
 *   busy/error/invalid-workspace handling path in `mode-select.tsx`; a
 *   mode-specific action should raise the SAME `ApiError` shape every
 *   other gateway call already does (see `lib/api.ts`) rather than
 *   inventing its own error handling.
 *
 * "simple" and "company" have a `run` (calls the backend's seeder API for
 * that mode — see `backend/seeder/modes/simple/` and
 * `backend/seeder/modes/company/`). Adding "creator" later means: (1) add
 * the matching `backend/seeder/modes/creator/` content, (2) add
 * `run: (workspaceId) => applySeeder(workspaceId, 'creator')` here. No
 * other frontend file changes.
 */
import { applySeeder } from '@/features/agent-seeder/api'

export type ModeId = 'simple' | 'creator' | 'company'

export type ModeRunResult = {
  agentsSeeded: number
}

export type ModeOption = {
  id: ModeId
  label: string
  description: string
  run?: (workspaceId: string) => Promise<ModeRunResult>
}

async function runSimple(workspaceId: string): Promise<ModeRunResult> {
  const result = await applySeeder(workspaceId, 'simple')
  return { agentsSeeded: result.applied.length }
}

async function runCompany(workspaceId: string): Promise<ModeRunResult> {
  const result = await applySeeder(workspaceId, 'company')
  return { agentsSeeded: result.applied.length }
}

export const MODES: ModeOption[] = [
  {
    id: 'simple',
    label: 'Simple',
    description: 'One agent, ready to go. Seeds the default agent set immediately.',
    run: runSimple,
  },
  {
    id: 'creator',
    label: 'Creator',
    description: 'A small team of specialized agents for content and creative work.',
    // No `run` yet — backend/seeder/modes/creator/ has no agents declared.
  },
  {
    id: 'company',
    label: 'Company',
    description: 'A full org chart of departments and agents for running a business: CEO, CFO, PM, Builder, Persona, and Librarian.',
    run: runCompany,
  },
]

export function isModeAvailable(mode: ModeOption): boolean {
  return mode.run !== undefined
}
