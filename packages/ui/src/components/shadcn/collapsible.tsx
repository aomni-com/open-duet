'use client'

import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import * as React from 'react'

import { composeHapticEventHandler, type HapticFeedbackProp } from '@repo/ui/lib/haptics'

const Collapsible = CollapsiblePrimitive.Root

const CollapsibleTrigger = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleTrigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleTrigger> & {
    hapticFeedback?: HapticFeedbackProp
  }
>(({ hapticFeedback = 'light', onClick, ...props }, ref) => (
  <CollapsiblePrimitive.CollapsibleTrigger
    ref={ref}
    onClick={composeHapticEventHandler(onClick, hapticFeedback)}
    {...props}
  />
))
CollapsibleTrigger.displayName = CollapsiblePrimitive.CollapsibleTrigger.displayName

const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
