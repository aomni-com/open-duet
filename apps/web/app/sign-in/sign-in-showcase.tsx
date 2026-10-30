'use client'

import { useTranslations } from 'next-intl'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

const DottedSurface = dynamic(
  () => import('./dotted-surface').then(module => module.DottedSurface),
  { ssr: false },
)

export function SignInShowcase() {
  const t = useTranslations('signIn.showcase')

  return (
    <aside
      aria-label={t('ariaLabel')}
      className="relative hidden min-h-screen overflow-hidden border-r border-sidebar-border bg-sidebar lg:flex lg:flex-col"
    >
      <div className="relative z-10 flex min-h-screen flex-col px-10 py-9 xl:px-14 xl:py-11">
        <div className="max-w-2xl">
          {/* Two whole lines, the claim and then the payoff. Letting the payoff
              run inline strands half of it at the end of the first line. */}
          <h2 className="text-balance text-[2.75rem] font-semibold leading-[1.02] tracking-[-0.04em] text-sidebar-foreground xl:text-[3.25rem]">
            {t('titleLead')}{' '}
            <span className="block font-normal italic text-sidebar-foreground/75">
              {t('titleEmphasis')}
            </span>
          </h2>
          <p className="mt-5 max-w-[34rem] text-base leading-7 text-sidebar-foreground/75">
            {t('description')}
          </p>
        </div>

        <AgentField />

        <div className="flex items-center justify-center gap-2 pb-1 text-xs font-medium tracking-[-0.01em] text-sidebar-foreground/60">
          <span className="text-sidebar-foreground/85">{t('agentLabel')}</span>
          <span className="size-1 rounded-full bg-brand" />
          <span>{t('agentStatus')}</span>
        </div>
      </div>
    </aside>
  )
}

function AgentField() {
  const [enabled, setEnabled] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const sync = () => setEnabled(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  const markReady = useCallback(() => setReady(true), [])

  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden py-3 xl:py-5">
      {enabled ? (
        <div
          className={cn(
            'absolute inset-0 transition-opacity duration-500 motion-reduce:transition-none',
            ready ? 'opacity-100' : 'opacity-0',
          )}
        >
          <DottedSurface onReady={markReady} />
        </div>
      ) : null}
      <SharedAgentGlyph />
    </div>
  )
}

/* One agent at the hub, three people around it on a circle, arranged so the
 * figure's bounding box is centred in the viewBox. Connectors are computed to
 * stop a fixed gap short of both shapes, so no dot ever lands on a glyph. */
const HUB = { cx: 90, cy: 72, half: 24 }
const RING = 72
const PERSON_R = 17
const GAP = 5
const PEOPLE = [210, 330, 90].map(degrees => {
  const radians = (degrees * Math.PI) / 180
  return { cx: HUB.cx + RING * Math.cos(radians), cy: HUB.cy + RING * Math.sin(radians) }
})

/** The dotted spoke from the hub's edge to a person's circle. */
function spoke(person: { cx: number; cy: number }) {
  const dx = person.cx - HUB.cx
  const dy = person.cy - HUB.cy
  const length = Math.hypot(dx, dy)
  // Leave the square hub where the ray crosses its nearer side.
  const exit = (HUB.half + GAP) / Math.max(Math.abs(dx), Math.abs(dy))
  const enter = 1 - (PERSON_R + GAP) / length
  return {
    x1: HUB.cx + dx * exit,
    y1: HUB.cy + dy * exit,
    x2: HUB.cx + dx * enter,
    y2: HUB.cy + dy * enter,
  }
}

/** One agent, shared: the agent at the centre, and the people it is shared
 * with around it, each on its own line back to it. One stroke weight and one
 * ink throughout; the brand spark is the only colour, and it is the agent. */
function SharedAgentGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 180 180"
      className="relative z-10 size-56 text-sidebar-foreground xl:size-64"
    >
      <g
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="0.1 5"
        opacity="0.5"
      >
        {PEOPLE.map((person, i) => (
          <line key={i} {...spoke(person)} />
        ))}
      </g>
      {PEOPLE.map((person, i) => (
        <g key={i}>
          <circle
            cx={person.cx}
            cy={person.cy}
            r={PERSON_R}
            className="fill-sidebar"
            stroke="currentColor"
            strokeOpacity="0.55"
            strokeWidth="2"
          />
          <circle cx={person.cx} cy={person.cy - 4} r="4" className="fill-sidebar-foreground/55" />
          <path
            d={`M${person.cx - 8} ${person.cy + 9.5}a8 7 0 0 1 16 0z`}
            className="fill-sidebar-foreground/55"
          />
        </g>
      ))}
      <rect
        x={HUB.cx - HUB.half}
        y={HUB.cy - HUB.half}
        width={HUB.half * 2}
        height={HUB.half * 2}
        rx="14"
        className="fill-sidebar"
        stroke="currentColor"
        strokeOpacity="0.8"
        strokeWidth="2"
      />
      <path
        d={`M${HUB.cx} ${HUB.cy - 13}c1.5 8.2 4.8 11.5 13 13-8.2 1.5-11.5 4.8-13 13-1.5-8.2-4.8-11.5-13-13 8.2-1.5 11.5-4.8 13-13z`}
        className="fill-brand"
      />
    </svg>
  )
}
