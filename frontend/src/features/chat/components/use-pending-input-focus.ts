import { useCallback, useRef } from 'react'

export type PendingInputFocusTarget = HTMLDivElement | HTMLInputElement

/** Ref + scroll/focus helper for whichever pending-input control is active. */
export function usePendingInputFocus() {
  const ref = useRef<PendingInputFocusTarget | null>(null)

  const scrollToAndFocus = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.focus()
  }, [])

  return { ref, scrollToAndFocus }
}
