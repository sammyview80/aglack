import { describe, expect, it } from 'vitest'
import { DESKTOP_NATIVE_HEIGHT, DESKTOP_NATIVE_WIDTH, threadsUi } from '@/components/threads-ui'

// Regression: the workspace image runs Xvnc at `-geometry 1024x576` with
// noVNC `resize=scale` (backend/workspace-image/patch_kasmvnc_resource_efficiency.py).
// A frontend geometry left at the old 1024x768 rendered a blank/inert
// desktop preview. Both the iframe buffer size and the Tailwind aspect
// class must track the server geometry.
describe('desktop native geometry', () => {
  it('matches the workspace image Xvnc geometry (1024x576)', () => {
    expect(DESKTOP_NATIVE_WIDTH).toBe(1024)
    expect(DESKTOP_NATIVE_HEIGHT).toBe(576)
  })

  it('keeps the preview thumb aspect class in sync with the native geometry', () => {
    expect(threadsUi.desktopPreviewThumb).toContain(
      `aspect-[${DESKTOP_NATIVE_WIDTH}/${DESKTOP_NATIVE_HEIGHT}]`,
    )
    expect(threadsUi.desktopPreviewThumb).not.toContain('aspect-[1024/768]')
  })
})
