'use client'

import { motion } from 'framer-motion'
import { type ReactNode } from 'react'

import { marker } from '@/components/landing/marker'

/** The hero's signature blue marker, reprised once — a static swipe that draws in
 * on scroll under a closing-headline phrase, so the page reads authored end-to-end.
 * The rationed brand blue belongs here: the close is the "act now" moment. */
export function InkMark({ children }: { children: ReactNode }) {
  return (
    <motion.span
      initial={{ backgroundSize: '0% 60%' }}
      whileInView={{ backgroundSize: '100% 60%' }}
      viewport={{ once: true, margin: '-12%' }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.25 }}
      style={{
        backgroundImage: marker(0.34, 0.28),
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '0 86%',
        WebkitBoxDecorationBreak: 'clone',
        boxDecorationBreak: 'clone',
      }}
    >
      {children}
    </motion.span>
  )
}
