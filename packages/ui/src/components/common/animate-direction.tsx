import { AnimatePresence, motion } from 'framer-motion'
import { type PropsWithChildren } from 'react'

export type AnimationDirection = 'backwards' | 'forwards'

type Props = PropsWithChildren<{
  direction: AnimationDirection
  changeId: React.Key

  displacementInPx?: number
  axis?: 'horizontal' | 'vertical'
  durationInSeconds?: number
  className?: string
  initial?: boolean
}>

export const AnimateDirection = ({
  direction,
  changeId,
  children,
  className,
  durationInSeconds = 0.15,
  axis = 'horizontal',
  displacementInPx = 10,
  initial = false,
}: Props) => {
  const variants = {
    initial: (direction: AnimationDirection) => ({
      [axis === 'horizontal' ? 'x' : 'y']:
        direction === 'forwards' ? displacementInPx : -displacementInPx,
      opacity: 0,
    }),
    animate: {
      [axis === 'horizontal' ? 'x' : 'y']: 0,
      opacity: 1,
    },
    exit: (direction: AnimationDirection) => ({
      [axis === 'horizontal' ? 'x' : 'y']:
        direction === 'forwards' ? -displacementInPx : displacementInPx,
      opacity: 0,
    }),
  }

  return (
    <AnimatePresence mode="wait" custom={direction} initial={initial}>
      <motion.div
        key={changeId}
        custom={direction}
        variants={variants}
        initial="initial"
        animate="animate"
        exit="exit"
        transition={{ duration: durationInSeconds, ease: 'easeInOut' }}
        className={className}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
