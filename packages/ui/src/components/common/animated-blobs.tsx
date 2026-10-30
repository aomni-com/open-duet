'use client'

import { motion } from 'framer-motion'
import { memo } from 'react'

import { usePrefersReducedMotion } from '@repo/ui/hooks/use-prefers-reduced-motion'
import { cn } from '@repo/ui/lib/utils'

interface AnimatedBlobsProps {
  className?: string
  opacity?: number
}
function UnmemoizedAnimatedBlobs({ className, opacity = 1 }: AnimatedBlobsProps) {
  const prefersReducedMotion = usePrefersReducedMotion()

  return (
    <motion.div
      className={cn(
        'absolute inset-0 pointer-events-none z-0 overflow-hidden',
        'supports-[backdrop-filter]:animate-in hidden supports-[backdrop-filter]:block',
        'transform-gpu',
        className,
      )}
      initial={{ opacity: 0 }}
      animate={{ opacity }}
      transition={{
        duration: prefersReducedMotion ? 0 : 1.5,
        delay: 0.7,
        ease: 'easeInOut',
      }}
    >
      <div
        className="absolute inset-0 w-full h-full dark:opacity-100 opacity-60"
        style={{
          background:
            'radial-gradient(320px circle at 45% 45%, rgba(147, 51, 234, 0.4), transparent 70%), radial-gradient(280px circle at 55% 55%, rgba(59, 130, 246, 0.45), transparent 70%)',
          filter: 'blur(20px)',
          willChange: 'opacity',
        }}
      />
      <div
        className="absolute inset-0 w-full h-full dark:opacity-80 opacity-40"
        style={{
          background:
            'radial-gradient(240px circle at 50% 50%, rgba(45, 212, 191, 0.3), transparent 80%)',
          filter: 'blur(15px)',
          willChange: 'opacity',
        }}
      />
    </motion.div>
  )
}

export const AnimatedBlobs = memo(UnmemoizedAnimatedBlobs, () => true)
