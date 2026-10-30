'use client'

import { CircleNotch } from '@phosphor-icons/react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { composeHapticEventHandler, type HapticFeedbackProp } from '@repo/ui/lib/haptics'
import { cn } from '@repo/ui/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        brand: 'bg-brand text-brand-foreground hover:bg-brand/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        // Editorial / "reach for me on the lander + first-session surfaces".
        // The `liquid-glass` class paints almost nothing, so this variant
        // needs a coloured canvas behind it (teal, gradient, photo) to read.
        // Avoid on flat data surfaces — the subtle luminosity won't show.
        glass: 'liquid-glass text-white hover:-translate-y-0.5',
        cta: 'relative overflow-hidden bg-gradient-to-r from-accent-foreground via-accent-secondary-foreground to-accent-foreground bg-size-200 animate-gradient-x hover:scale-105 transition-all duration-300 shadow-lg hover:shadow-xl before:absolute before:inset-0 before:bg-gradient-to-r before:from-white/20 before:to-transparent before:translate-x-[-100%] hover:before:translate-x-[100%] before:transition-transform before:duration-700 after:absolute after:inset-0 after:bg-gradient-to-r after:from-transparent after:via-white/10 after:to-transparent after:translate-x-[-100%] hover:after:translate-x-[100%] after:transition-transform after:duration-500 after:delay-200 text-white border-0 focus:ring-2 focus:ring-blue-400 focus:ring-offset-2',
      },
      size: {
        default: 'h-9 px-3 py-1.5',
        sm: 'h-8 rounded-md px-2.5',
        // xs is the canonical size for buttons that live inside the h-11
        // app shell header. Use this for any header action.
        xs: 'h-7 rounded-md px-2 text-xs [&_svg]:size-3.5',
        lg: 'h-10 rounded-md px-5',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
  hapticFeedback?: HapticFeedbackProp
  isLoading?: boolean
  isDev?: boolean
}

function getButtonHapticFeedback(
  hapticFeedback: HapticFeedbackProp | undefined,
  variant: ButtonProps['variant'],
) {
  if (hapticFeedback !== undefined) {
    return hapticFeedback
  }

  if (variant === 'destructive') {
    return 'warning'
  }

  if (variant === 'cta') {
    return 'medium'
  }

  return 'light'
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      hapticFeedback,
      isLoading = false,
      isDev = false,
      children,
      disabled,
      onClick,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button'
    const resolvedHapticFeedback = getButtonHapticFeedback(hapticFeedback, variant)

    if (asChild) {
      return (
        <Comp
          className={cn(buttonVariants({ variant, size, className }))}
          ref={ref}
          onClick={composeHapticEventHandler(onClick, resolvedHapticFeedback)}
          {...props}
        >
          {children}
        </Comp>
      )
    }

    return (
      <Comp
        className={cn(
          buttonVariants({ variant, size, className }),
          isDev && 'relative overflow-visible',
        )}
        ref={ref}
        disabled={disabled || isLoading}
        onClick={composeHapticEventHandler(onClick, resolvedHapticFeedback)}
        {...props}
      >
        {children}

        {isLoading && <CircleNotch className="animate-spin" />}

        {isDev && (
          <span className="absolute -top-2 -right-2 bg-yellow-500 text-black text-[6px] font-semibold px-1 py-1 rounded leading-none">
            DEV ONLY
          </span>
        )}
      </Comp>
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
