'use client'

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'

/**
 * Cross-fades only the destination pane. The authenticated shell, workspace
 * controls, sidebars, query client, and live session providers stay mounted
 * around it, which is the state-preserving behavior readers expect from a SPA.
 */
export function WorkspaceRouteTransition({
  transitionKey,
  children,
}: {
  transitionKey: string
  children: ReactNode
}) {
  const reduceMotion = useReducedMotion()

  return (
    <div className="relative h-full min-h-0 min-w-0">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={transitionKey}
          data-route-transition="true"
          className="h-full min-h-0 min-w-0"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{
            opacity: 0,
            transition: reduceMotion ? { duration: 0 } : { duration: 0.1, ease: [0.7, 0, 0.84, 0] },
          }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : {
                  opacity: {
                    duration: 0.16,
                    ease: [0.22, 1, 0.36, 1],
                  },
                }
          }
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
