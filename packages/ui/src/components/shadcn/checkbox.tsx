'use client'

import { Check } from '@phosphor-icons/react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import * as React from 'react'

import { composeHapticValueChangeHandler, type HapticFeedbackProp } from '@repo/ui/lib/haptics'
import { cn } from '@repo/ui/lib/utils'

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> & {
    hapticFeedback?: HapticFeedbackProp
  }
>(({ className, hapticFeedback = 'selection', onCheckedChange, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
      className,
    )}
    onCheckedChange={composeHapticValueChangeHandler(onCheckedChange, hapticFeedback)}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn('flex items-center justify-center text-current leading-none')}
    >
      <Check className="h-4 w-4 -translate-y-px" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
