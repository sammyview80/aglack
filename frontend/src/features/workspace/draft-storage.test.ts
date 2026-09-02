import { afterEach, describe, expect, it } from 'vitest'
import {
  clearCreateDraft,
  loadCreateDraft,
  loadOwnerName,
  saveCreateDraft,
} from '@/features/workspace/draft-storage'
import type { CreateWorkspaceInput } from '@/features/workspace/types'

const DRAFT_KEY = 'hermes-fe-create-draft'

/**
 * A distinctive value so a raw-payload assertion cannot pass by accident:
 * it appears nowhere else in the draft (not in the owner name, not in the
 * workspace name), so if it shows up in the stored JSON at all, it got
 * there from the `password` field.
 */
const SECRET = 'correct-horse-battery-staple-9241'

const DRAFT: CreateWorkspaceInput = {
  ownerName: 'Alex',
  workspaceName: 'my-workspace',
  password: SECRET,
  kind: 'server',
}

afterEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
})

describe('create-workspace draft persistence', () => {
  it('still round-trips the non-secret fields', () => {
    saveCreateDraft(DRAFT)
    expect(loadCreateDraft()).toEqual({
      ownerName: 'Alex',
      workspaceName: 'my-workspace',
      kind: 'server',
    })
  })

  it('returns null when nothing has been stored yet', () => {
    expect(loadCreateDraft()).toBeNull()
  })

  it('returns null after the draft is cleared', () => {
    saveCreateDraft(DRAFT)
    clearCreateDraft()
    expect(loadCreateDraft()).toBeNull()
  })

  it('ignores malformed JSON instead of throwing', () => {
    window.sessionStorage.setItem(DRAFT_KEY, '{not json')
    expect(loadCreateDraft()).toBeNull()
  })

  it('still remembers the owner name in localStorage (not a credential)', () => {
    saveCreateDraft(DRAFT)
    expect(loadOwnerName()).toBe('Alex')
  })
})

describe('create-workspace draft never persists the password', () => {
  /**
   * The core regression test. Before the fix, `saveCreateDraft` did
   * `JSON.stringify(draft)` on the whole input, so the raw sessionStorage
   * payload literally contained the password string — this assertion
   * failed on the raw-payload check.
   */
  it('does not write the password value into the raw sessionStorage payload', () => {
    saveCreateDraft(DRAFT)

    const raw = window.sessionStorage.getItem(DRAFT_KEY)
    expect(raw).not.toBeNull()
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain('password')
  })

  it('does not write the password anywhere in sessionStorage or localStorage', () => {
    saveCreateDraft(DRAFT)

    // Fix the shared chokepoint, not just the one key: sweep EVERY key in
    // both web storages, so a future change that stashes the credential
    // under some other key is caught by this test too.
    for (const storage of [window.sessionStorage, window.localStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i)
        expect(key).not.toBeNull()
        expect(storage.getItem(key as string)).not.toContain(SECRET)
      }
    }
  })

  it('reads back a draft with no password field at all', () => {
    saveCreateDraft(DRAFT)

    const restored = loadCreateDraft()
    expect(restored).not.toBeNull()
    // Not merely `undefined` — the key must not be present, so spreading a
    // restored draft can never reintroduce a stale credential.
    expect(Object.keys(restored as object)).not.toContain('password')
    expect((restored as Record<string, unknown>).password).toBeUndefined()
  })

  it('fails closed on a legacy stored draft that already contains a password', () => {
    // A draft written by an OLDER build of the app, before the password
    // was stripped on write — a user upgrading mid-session has exactly
    // this sitting in sessionStorage.
    window.sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        ownerName: 'Alex',
        workspaceName: 'my-workspace',
        password: SECRET,
        kind: 'server',
      }),
    )

    const restored = loadCreateDraft()
    expect(restored).toEqual({
      ownerName: 'Alex',
      workspaceName: 'my-workspace',
      kind: 'server',
    })
    expect(Object.keys(restored as object)).not.toContain('password')
    expect((restored as Record<string, unknown>).password).toBeUndefined()
  })

  it('does not re-persist a legacy password when the draft is saved again', () => {
    window.sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ ownerName: 'Alex', workspaceName: 'my-workspace', password: SECRET }),
    )

    const restored = loadCreateDraft()
    expect(restored).not.toBeNull()
    // The realistic upgrade path: restore, then save again as the user
    // edits the form. A `StoredCreateDraft` is assignable to
    // `CreateWorkspaceInput` (whose `password` is optional) with no cast —
    // which is exactly the point of the password-free stored type.
    const resaved: CreateWorkspaceInput = { ...restored! }
    saveCreateDraft(resaved)

    expect(window.sessionStorage.getItem(DRAFT_KEY)).not.toContain(SECRET)
  })
})
