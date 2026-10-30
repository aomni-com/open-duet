import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@repo/ui/lib/utils'

const alertVariants = cva(
  'relative flex w-full flex-row items-center gap-2.5 rounded-lg border-l-4 border px-3 py-2 text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-foreground',
  {
    variants: {
      variant: {
        default:
          'border-l-primary text-foreground [&:has([href])]:hover:bg-accent/50 dark:[&:has([href])]:hover:bg-accent/50',
        destructive:
          'border-l-destructive bg-gradient-to-r from-destructive/10 to-destructive/5 border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive',
        warning:
          'border-l-warning bg-gradient-to-r from-warning/10 to-warning/5 border-warning/50 text-warning dark:border-warning [&>svg]:text-warning',
        success:
          'border-l-green-600 bg-gradient-to-r from-green-600/10 to-green-600/5 border-green-600/50 text-green-700 dark:text-green-400 dark:border-green-600 [&>svg]:text-green-600',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
))
Alert.displayName = 'Alert'

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5
      ref={ref}
      className={cn('mb-1 font-medium leading-none tracking-tight', className)}
      {...props}
    />
  ),
)
AlertTitle.displayName = 'AlertTitle'

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />
))
AlertDescription.displayName = 'AlertDescription'

export { Alert, AlertTitle, AlertDescription }
