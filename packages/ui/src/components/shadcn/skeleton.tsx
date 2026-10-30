import { cn } from '@repo/ui/lib/utils'

/**
 * Calm, brand-tinted skeleton. Pairs a slow ambient breath with a
 * one-shot mount sweep — see `.shell-skeleton` in
 * `packages/tailwind-config/globals.css` for the motion definition.
 *
 * Drop-in replacement for the original Tailwind `animate-pulse` skeleton:
 * same API, same default rounded shape, just better-mannered motion.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('shell-skeleton rounded-md', className)} {...props} />
}

export { Skeleton }
