'use client'

import { ArrowClockwise, ArrowRight, SpinnerGap, WarningCircle } from '@phosphor-icons/react'
import { motion, useReducedMotion } from 'framer-motion'

import { Button } from '@repo/ui/components/shadcn/button'

export function SignOutStatus({
  phase,
  onRetry,
  onReturn,
}: {
  phase: 'signing-out' | 'failed'
  onRetry?: () => void
  onReturn?: () => void
}) {
  const reduceMotion = useReducedMotion()
  const failed = phase === 'failed'
  return (
    <main className="grid min-h-screen place-items-center bg-sidebar p-5 text-foreground sm:p-8">
      <motion.section
        role={failed ? 'alert' : 'status'}
        aria-busy={failed ? undefined : true}
        className="w-full max-w-md rounded-3xl border bg-background p-7 shadow-xl sm:p-9"
        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
      >
        <span
          className={
            failed
              ? 'grid size-11 place-items-center rounded-2xl bg-destructive/10 text-destructive'
              : 'grid size-11 place-items-center rounded-2xl bg-primary text-primary-foreground'
          }
        >
          {failed ? (
            <WarningCircle aria-hidden size={22} weight="bold" />
          ) : (
            <SpinnerGap
              aria-hidden
              size={22}
              weight="bold"
              className="animate-spin motion-reduce:animate-none"
            />
          )}
        </span>
        <p className="mt-7 text-sm font-medium text-brand">Duet</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {failed ? "We couldn't finish signing out" : 'Signing you out'}
        </h1>
        <p className="mt-3 text-sm leading-6 text-foreground/70">
          {failed
            ? 'Your workspace is safe. Try again, or return to sign in and choose another account.'
            : 'Closing this browser session and clearing your account from this device…'}
        </p>
        {failed ? (
          <div className="mt-7 flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="brand" className="flex-1" onClick={onRetry}>
              <ArrowClockwise aria-hidden /> Retry sign-out
            </Button>
            <Button type="button" variant="outline" className="flex-1" onClick={onReturn}>
              Return to sign in <ArrowRight aria-hidden />
            </Button>
          </div>
        ) : (
          <div className="mt-7 h-1 overflow-hidden rounded-full bg-border/65">
            <motion.div
              className="h-full w-2/5 rounded-full bg-brand"
              animate={reduceMotion ? { opacity: 0.75 } : { x: ['-110%', '260%'] }}
              transition={{ duration: 1.2, ease: [0.65, 0, 0.35, 1], repeat: Infinity }}
            />
          </div>
        )}
      </motion.section>
    </main>
  )
}
