'use client'

import { motion } from 'framer-motion'
import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { serifStyle } from '@/components/landing/landing-styles'
import { RevealItem, SectionReveal } from '@/components/landing/section-reveal'

// Client-only + lazy: the WebGL mesh never touches SSR and only downloads
// when ShaderOnView brings the closing section near the viewport.
export const MeshGradient = dynamic(
  () => import('@paper-design/shaders-react').then(m => m.MeshGradient),
  { ssr: false },
)

export function SectionHeader({
  eyebrow,
  title,
  intro,
  align = 'center',
}: {
  eyebrow: string
  title: ReactNode
  intro?: ReactNode
  align?: 'center' | 'left'
}) {
  const centered = align === 'center'
  return (
    <SectionReveal className={centered ? 'mx-auto max-w-3xl text-center' : 'max-w-2xl'}>
      <RevealItem>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-foreground/80">
          {eyebrow}
        </p>
      </RevealItem>
      <RevealItem>
        <h2
          className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl lg:text-5xl"
          style={serifStyle}
        >
          {title}
        </h2>
      </RevealItem>
      {intro ? (
        <RevealItem>
          <p
            className={cn(
              'mt-5 max-w-2xl text-balance text-base leading-relaxed text-foreground/70 sm:text-lg',
              centered && 'mx-auto',
            )}
          >
            {intro}
          </p>
        </RevealItem>
      ) : null}
    </SectionReveal>
  )
}

/** One clock keeps the rail pulse and each consumer's row animations aligned. */
export const CASCADE_PERIOD = 3.4
/** Where the pulse passes each seat, as a fraction of its travel down the rail. */
export const CASCADE_BEATS = [0.28, 0.64, 0.96] as const

/** The dotted share rail is anchored to its rows so it cannot stop short of the list. */
export function CascadeRail({ reduce }: { reduce: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="absolute -top-6 bottom-7 left-[33px] w-px text-foreground/30"
      style={{
        backgroundImage:
          'repeating-linear-gradient(to bottom, currentColor 0 2px, transparent 2px 6px)',
      }}
    >
      {!reduce && (
        <motion.span
          className="absolute left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-[hsl(214_70%_56%)] shadow-[0_0_6px_hsl(214_70%_56%/0.8)]"
          animate={{ top: ['0%', '100%'], opacity: [0, 1, 1, 0] }}
          transition={{
            duration: CASCADE_PERIOD,
            repeat: Infinity,
            ease: 'linear',
            opacity: {
              duration: CASCADE_PERIOD,
              times: [0, 0.08, 0.92, 1],
              repeat: Infinity,
            },
          }}
        />
      )}
    </span>
  )
}
