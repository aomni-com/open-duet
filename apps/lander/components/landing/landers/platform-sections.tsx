'use client'

import {
  AlarmIcon,
  CpuIcon,
  DownloadSimpleIcon,
  FolderOpenIcon,
  GlobeIcon,
  type Icon as PhosphorIcon,
  LightningIcon,
  PlugsIcon,
  RobotIcon,
  RocketLaunchIcon,
  StackIcon,
  SteeringWheelIcon,
  UsersIcon,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { useHydratedReducedMotion } from '@/components/landing/atoms'
import { FundraiseChip, LanderHero } from '@/components/landing/landers/hero-and-close'
import {
  PLATFORM_DESCRIPTION,
  PLATFORM_HERO_WORDS,
} from '@/components/landing/landers/platform-copy'
import {
  INTEGRATIONS_COPY_EN,
  type IntegrationsCopy,
  PRIMITIVE_KEYS,
  PRIMITIVES_COPY_EN,
  type PrimitiveKey,
  type PrimitivesCopy,
} from '@/components/landing/landers/section-copy'
import { SectionHeader } from '@/components/landing/landers/section-primitives'

/* ------------------------------------------------------------------ */
/* Hero — the rotating bracket over the full-viewport video           */
/* ------------------------------------------------------------------ */

const WORD_ROTATE_MS = 2_600

/** The hero's rotating word. Until fonts settle (and always under reduced
 * motion or without JS) the first word renders in normal flow, so the
 * headline centers on exactly the ink it shows — a fixed slot sized to the
 * longest word pushed the visible line ~75px off-center. Once measured, the
 * slot animates its width between words and the line recenters smoothly.
 * Screen readers get the static first word; the rotation is decorative. */
function RotatingWord() {
  const reduce = useHydratedReducedMotion()
  const [active, setActive] = useState(0)
  const [widths, setWidths] = useState<number[] | null>(null)
  const measureRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (reduce) return
    let cancelled = false
    const measure = async () => {
      await document.fonts.ready
      if (cancelled || !measureRef.current) return
      const spans = Array.from(measureRef.current.children) as HTMLElement[]
      setWidths(spans.map(span => span.getBoundingClientRect().width))
    }
    void measure()
    return () => {
      cancelled = true
    }
  }, [reduce])

  useEffect(() => {
    if (reduce || widths === null) return
    const id = setInterval(
      () => setActive(index => (index + 1) % PLATFORM_HERO_WORDS.length),
      WORD_ROTATE_MS,
    )
    return () => clearInterval(id)
  }, [reduce, widths])

  return (
    <>
      <span className="sr-only">{PLATFORM_HERO_WORDS[0]}</span>
      {/* Invisible measurement row — same font, never displayed. */}
      <span
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute -z-10 whitespace-nowrap"
      >
        {PLATFORM_HERO_WORDS.map(word => (
          <span key={word} className="inline-block">
            {word}
          </span>
        ))}
      </span>
      {widths === null ? (
        <span aria-hidden="true">{PLATFORM_HERO_WORDS[0]}</span>
      ) : (
        <span
          aria-hidden="true"
          className="relative inline-block overflow-visible whitespace-nowrap align-baseline transition-[width] duration-500"
          style={{ width: widths[active] }}
        >
          {PLATFORM_HERO_WORDS.map((word, index) => (
            <span
              key={word}
              className={cn(
                'transition-opacity duration-500',
                index === active ? 'opacity-100' : 'opacity-0',
                index === active ? 'relative' : 'absolute left-0 top-0',
              )}
            >
              {word}
            </span>
          ))}
        </span>
      )}
    </>
  )
}

export function PlatformHero() {
  return (
    <LanderHero
      chip={
        <FundraiseChip>
          <span className="hidden sm:inline">to build the platform your agents live on</span>
          <span className="sm:hidden">to build the agent platform</span>
        </FundraiseChip>
      }
      headline={
        <>
          Create and share agents with{' '}
          <span className="lv2-hero-ink-soft italic">
            your <RotatingWord />
          </span>
        </>
      }
      sub={PLATFORM_DESCRIPTION}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Section 1 — the primitives                                          */
/* ------------------------------------------------------------------ */

/** Each card's glyph, keyed like the copy so a translation can never pair a
 * title with the wrong icon. */
const PRIMITIVE_ICONS: Record<PrimitiveKey, PhosphorIcon> = {
  models: StackIcon,
  computer: CpuIcon,
  browser: GlobeIcon,
  install: DownloadSimpleIcon,
  services: LightningIcon,
  agents: UsersIcon,
  workspace: FolderOpenIcon,
  schedules: AlarmIcon,
  apps: RocketLaunchIcon,
}

export function PrimitivesSection({ copy = PRIMITIVES_COPY_EN }: { copy?: PrimitivesCopy }) {
  return (
    <section className="border-y border-foreground/10 bg-background">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
        <SectionHeader eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro} />
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {PRIMITIVE_KEYS.map(key => {
            const Glyph = PRIMITIVE_ICONS[key]
            const primitive = copy.primitives[key]
            return (
              <article
                key={key}
                className="rounded-3xl border border-foreground/15 bg-foreground/[0.03] p-6 sm:p-7"
              >
                <Glyph weight="bold" aria-hidden="true" className="size-6 text-foreground/75" />
                <h3 className="mt-3 text-lg font-semibold tracking-[-0.02em]">{primitive.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-foreground/70">{primitive.body}</p>
              </article>
            )
          })}
        </div>
        {/* The capstone spans the grid: every card above is something the
            agents themselves can reach for, which is the whole claim. */}
        <article className="mt-6 rounded-3xl border border-foreground/15 bg-foreground p-6 text-background shadow-xl shadow-foreground/10 sm:p-7">
          <SteeringWheelIcon
            weight="bold"
            aria-hidden="true"
            className="size-6 text-background/85"
          />
          <h3 className="mt-3 text-2xl font-semibold tracking-[-0.025em]">{copy.capstone.title}</h3>
          <p className="mt-2 max-w-[75ch] leading-relaxed text-background/80">
            {copy.capstone.body}
          </p>
        </article>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Section 2 — agents and tools that plug in                           */
/* ------------------------------------------------------------------ */

type IntegrationChip = { name: string; icon: string }

const AGENT_INTEGRATIONS: readonly IntegrationChip[] = [
  { name: 'Claude Cowork', icon: '/landing/integrations/claude.png' },
  { name: 'Claude Code', icon: '/landing/integrations/claude.png' },
  { name: 'ChatGPT', icon: '/landing/integrations/openai.webp' },
  { name: 'Codex', icon: '/landing/integrations/openai.webp' },
  { name: 'Cursor', icon: '/landing/integrations/cursor.png' },
]

const TOOL_INTEGRATIONS: readonly IntegrationChip[] = [
  { name: 'Gmail', icon: '/landing/integrations/gmail.webp' },
  { name: 'Google Drive', icon: '/landing/integrations/google-drive.webp' },
  { name: 'OneDrive', icon: '/landing/integrations/onedrive.svg' },
  { name: 'Outlook', icon: '/landing/integrations/outlook.svg' },
  { name: 'Notion', icon: '/landing/integrations/notion.png' },
  { name: 'Slack', icon: '/landing/integrations/slack.png' },
]

function ChipRow({ chips, trail }: { chips: readonly IntegrationChip[]; trail?: string }) {
  return (
    <ul className="flex flex-wrap items-center gap-2" role="list">
      {chips.map(chip => (
        <li
          key={chip.name}
          className="flex items-center gap-1.5 rounded-full border border-foreground/15 bg-background py-1.5 pl-2.5 pr-3 text-[13px] font-medium text-foreground/80"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={chip.icon} alt="" aria-hidden="true" className="size-4 object-contain" />
          {chip.name}
        </li>
      ))}
      {trail ? (
        <li className="rounded-full border border-foreground/25 px-3 py-1.5 text-[13px] text-foreground/65">
          {trail}
        </li>
      ) : null}
    </ul>
  )
}

export function IntegrationsSection({ copy = INTEGRATIONS_COPY_EN }: { copy?: IntegrationsCopy }) {
  return (
    <section>
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
        <SectionHeader eyebrow={copy.eyebrow} title={copy.title} intro={copy.intro} />
        <div className={cn('mt-12 grid gap-6', copy.agents && 'lg:grid-cols-2')}>
          {copy.agents ? (
            <div className="rounded-3xl border border-foreground/15 bg-foreground/[0.03] p-7 sm:p-8">
              <RobotIcon weight="bold" aria-hidden="true" className="size-6 text-foreground/75" />
              <h3 className="mt-3 text-lg font-semibold tracking-[-0.02em]">{copy.agents.title}</h3>
              <p className="mt-2 min-h-10 text-sm leading-relaxed text-foreground/70">
                {copy.agents.body}
              </p>
              <div className="mt-5 max-w-[360px]">
                <ChipRow chips={AGENT_INTEGRATIONS} trail={copy.agents.trail} />
              </div>
            </div>
          ) : null}
          <div className="rounded-3xl border border-foreground/15 bg-foreground/[0.03] p-7 sm:p-8">
            <PlugsIcon weight="bold" aria-hidden="true" className="size-6 text-foreground/75" />
            <h3 className="mt-3 text-lg font-semibold tracking-[-0.02em]">{copy.tools.title}</h3>
            <p className="mt-2 min-h-10 text-sm leading-relaxed text-foreground/70">
              {copy.tools.body}
            </p>
            {/* Alone on the row, the chips may use its width. */}
            <div className={cn('mt-5', copy.agents && 'max-w-[360px]')}>
              <ChipRow chips={TOOL_INTEGRATIONS} trail={copy.tools.trail} />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
