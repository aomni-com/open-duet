'use client'

import { AnimatePresence, motion } from 'framer-motion'
import Confetti, { type IConfettiOptions } from 'react-confetti'
import { useWindowSize } from 'react-use'

import { usePrefersReducedMotion } from '@repo/ui/hooks/use-prefers-reduced-motion'

/**
 * How long a burst needs before the last piece has fallen off-screen. Set by
 * this component's own physics, so a caller that mounts it for a fixed spell
 * asks here rather than re-deriving the same number beside its own timer.
 */
export const CONFETTI_FALL_MS = 6_000

export function FullScreenConfetti(props: Partial<IConfettiOptions>) {
  const { width, height } = useWindowSize()
  // Celebration only: nobody who asked for reduced motion wants a few hundred
  // pieces of paper thrown at them, and the hook already answers that question
  // — a `motion-reduce:hidden` wrapper on top would be an unreachable second
  // owner of the same rule.
  const prefersReducedMotion = usePrefersReducedMotion()
  if (prefersReducedMotion) return null
  return <Confetti {...props} width={width} height={height} />
}

/**
 * What a celebration looks like here — the piece count, fall, and palette that
 * make one burst recognisably the same event as the last one. Callers decide
 * when to mount it and for how long; they do not restate how it looks.
 */
export function CelebrationBurst({ playing }: { playing: boolean }) {
  return (
    <AnimatePresence>
      {playing ? (
        <motion.div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[10002]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
        >
          <FullScreenConfetti
            recycle={false}
            numberOfPieces={180}
            gravity={0.18}
            colors={['#6D5EF7', '#A78BFA', '#F59E0B', '#34D399', '#FB7185']}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
