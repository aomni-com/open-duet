'use client'

import { motion, type Variants } from 'framer-motion'
import { type ReactNode } from 'react'

const containerVariants: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.09, delayChildren: 0.05 },
  },
}

const childVariants: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] },
  },
}

type SectionRevealProps = {
  children: ReactNode
  className?: string
  /** Fraction of the element that must be in view before triggering (0-1). */
  amount?: number
}

/**
 * Fires a once-per-mount staggered reveal on its direct `<RevealItem>` children
 * when the wrapper scrolls into view. Used to give each section its own quiet
 * cinematic entrance — eyebrow → headline → body → visual.
 */
export function SectionReveal({ children, className, amount = 0.2 }: SectionRevealProps) {
  return (
    <motion.div
      data-section-reveal=""
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount }}
      variants={containerVariants}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function RevealItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={childVariants} className={className}>
      {children}
    </motion.div>
  )
}
