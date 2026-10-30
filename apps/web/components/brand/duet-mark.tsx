'use client'

import { motion, useReducedMotion } from 'framer-motion'
import Image from 'next/image'

import { cn } from '@repo/ui/lib/utils'

const sizes = {
  xs: { className: 'size-6', pixels: 24 },
  sm: { className: 'size-8', pixels: 32 },
  md: { className: 'size-11', pixels: 44 },
} as const

export function DuetMark({
  active = false,
  className,
  label = '',
  priority = false,
  size = 'sm',
}: {
  active?: boolean
  className?: string
  label?: string
  priority?: boolean
  size?: keyof typeof sizes
}) {
  const reduceMotion = useReducedMotion()
  const dimensions = sizes[size]

  return (
    <span
      data-duet-mark={active ? 'active' : 'idle'}
      className={cn(
        'relative inline-grid shrink-0 place-items-center',
        dimensions.className,
        className,
      )}
    >
      <Image
        src="/icons/duet-avatar.png"
        alt={label}
        width={dimensions.pixels}
        height={dimensions.pixels}
        priority={priority}
        className="relative size-full rounded-full object-cover ring-1 ring-border"
      />
      {active ? (
        <motion.span
          aria-hidden
          className="absolute bottom-0 right-0 size-2 rounded-full border-2 border-background bg-brand"
          initial={false}
          animate={
            reduceMotion
              ? { opacity: 1, scale: 1 }
              : { opacity: [0.58, 1, 0.58], scale: [0.82, 1, 0.82] }
          }
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 1.8, ease: 'easeInOut', repeat: Number.POSITIVE_INFINITY }
          }
        />
      ) : null}
    </span>
  )
}

export function DuetLoadingCue({ label, className }: { label: string; className?: string }) {
  const reduceMotion = useReducedMotion()

  return (
    <div className={cn('flex w-fit flex-col items-center gap-2.5', className)}>
      <div className="flex items-center gap-2.5">
        <motion.span
          aria-hidden
          className="size-1.5 rounded-full bg-brand"
          initial={false}
          animate={
            reduceMotion
              ? { opacity: 0.85, scale: 1 }
              : { opacity: [0.45, 1, 0.45], scale: [0.82, 1, 0.82] }
          }
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 1.6, ease: 'easeInOut', repeat: Number.POSITIVE_INFINITY }
          }
        />
        <span className="text-sm font-medium tracking-[-0.01em] text-foreground/70">{label}</span>
      </div>
      <span aria-hidden className="h-px w-24 overflow-hidden bg-border/70">
        <motion.span
          className="block h-full origin-left bg-brand"
          initial={false}
          animate={
            reduceMotion
              ? { opacity: 0.72, scaleX: 0.68 }
              : { opacity: [0.48, 1, 0.48], scaleX: [0.16, 0.9, 0.16] }
          }
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 1.6, ease: 'easeInOut', repeat: Number.POSITIVE_INFINITY }
          }
        />
      </span>
    </div>
  )
}
