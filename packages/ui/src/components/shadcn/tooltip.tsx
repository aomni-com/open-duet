'use client'

import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as React from 'react'

import { OverlaySuspendedContext } from '@repo/ui/lib/overlay-scope'
import { cn } from '@repo/ui/lib/utils'

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = ({ delayDuration = 150, ...props }: TooltipPrimitive.TooltipProps) => (
  <TooltipPrimitive.Root delayDuration={delayDuration} {...props} />
)

const TooltipTrigger = TooltipPrimitive.Trigger

function TooltipPortal(props: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Portal>) {
  const suspended = React.useContext(OverlaySuspendedContext)
  return suspended ? null : <TooltipPrimitive.Portal {...props} />
}

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPortal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </TooltipPortal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipPortal }
