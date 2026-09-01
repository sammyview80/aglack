import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'

function TooltipProvider({
  delay = 200,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider delay={delay} {...props} />
}

function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  children,
  side = 'top',
  ...props
}: TooltipPrimitive.Popup.Props & { side?: TooltipPrimitive.Positioner.Props['side'] }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={6} className="z-50">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-sm',
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/** Hover label for a single control. Pass the button/link as `children`. */
function Hint({
  label,
  side = 'top',
  children,
}: {
  label: string
  side?: TooltipPrimitive.Positioner.Props['side']
  children: ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger delay={200} render={children} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, Hint }
