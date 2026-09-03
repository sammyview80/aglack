import { forwardRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { motionPresets } from '@/components/motion/presets'

/** Re-mount block content with enter animation when `swapKey` changes.
 * `ref` is optional and forwarded straight to the rendered `div` — needed
 * by callers (e.g. the chat transcript's `ResizeObserver` pin) that must
 * observe THIS element's own box, not just render inside it; every
 * existing call site that doesn't pass a ref is unaffected. */
export const AnimatedPanel = forwardRef<
  HTMLDivElement,
  {
    swapKey: string | number
    children: ReactNode
    className?: string
    animation?: string
  }
>(function AnimatedPanel({ swapKey, children, className, animation = motionPresets.panelEnter }, ref) {
  return (
    <div key={swapKey} ref={ref} className={cn(animation, className)}>
      {children}
    </div>
  )
})
