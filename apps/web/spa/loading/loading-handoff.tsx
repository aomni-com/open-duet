'use client'

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

/**
 * Keeps the resolved island underneath its matching skeleton while that
 * skeleton fades away. Only opacity changes, so the handoff cannot move or
 * resize the destination the user has already oriented around.
 */
export function LoadingHandoff({
  loading,
  fallback,
  children,
  className,
}: {
  loading: boolean
  fallback: ReactNode
  children: ReactNode
  className?: string
}) {
  const reduceMotion = useReducedMotion()
  const duration = reduceMotion ? 0 : 0.18

  return (
    <div className={cn('relative h-full min-h-0 min-w-0', className)}>
      {!loading ? (
        <motion.div
          key="resolved"
          className="h-full min-h-0 min-w-0"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration, ease: [0.22, 1, 0.36, 1] }}
        >
          {children}
        </motion.div>
      ) : null}

      <AnimatePresence initial={false}>
        {loading ? (
          <motion.div
            key="loading"
            className="absolute inset-0 z-10 min-h-0 min-w-0 overflow-hidden bg-background"
            initial={false}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.14, ease: [0.7, 0, 0.84, 0] }}
          >
            {fallback}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
