'use client'

import {
  ArrowsClockwiseIcon,
  ArrowsSplitIcon,
  BrainIcon,
  BuildingsIcon,
  CheckCircleIcon,
  CheckIcon,
  FolderSimpleIcon,
  GlobeIcon,
  LockSimpleIcon,
  PlugsConnectedIcon,
} from '@phosphor-icons/react'
import {
  AnimatePresence,
  motion,
  type MotionValue,
  useInView,
  useMotionValue,
  useTransform,
} from 'framer-motion'
import Image from 'next/image'
import { type RefObject, useEffect, useId, useRef, useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { LiveDot, useHydratedReducedMotion } from '@/components/landing/atoms'
import { GrainVeil } from '@/components/landing/grain-veil'
import {
  CASCADE_BEATS,
  CASCADE_PERIOD,
  CascadeRail,
  SectionHeader,
} from '@/components/landing/landers/section-primitives'
import { RevealItem, SectionReveal } from '@/components/landing/section-reveal'
import { SubtleBackdrop } from '@/components/landing/subtle-backdrop'
import { PUBLIC_FRONTIER_MODELS } from '@/lib/public-site-config'

/**
 * The below-the-hero sections more than one lander argues from. A page's own
 * sections live in its `<page>-sections.tsx`; anything a second lander
 * reaches for belongs here instead, so no lander imports another lander's
 * file. The hero and closing ask every lander mounts are in
 * `hero-and-close.tsx`.
 *
 * Every section SHOWS its claim instead of asserting it — the silo
 * shelf, the shared-memory diagram, the live doc, the share cascade — on the
 * lander motion law: entrance once on scroll, a quiet alive-at-rest loop
 * after, a static poster under reduced motion. Brand blue is rationed to one
 * meaning per viewport: "live / shared".
 */

/** The SMIL SVG's own clock, exposed as a 0→1 cycle MotionValue. The SVG
 * timeline starts at HTML parse while framer's loops start at hydration, so
 * two independent clocks drift by the hydration delay — instead, every DOM
 * beat (chip pops, glows, checkmarks) derives from THIS value via
 * useTransform, making the travelers the single source of truth. */
function useSvgCycle(
  ref: RefObject<SVGSVGElement | null>,
  periodSeconds: number,
  enabled: boolean,
): MotionValue<number> {
  const cycle = useMotionValue(0)
  useEffect(() => {
    if (!enabled) return
    let raf = 0
    const tick = () => {
      const svg = ref.current
      if (svg && typeof svg.getCurrentTime === 'function') {
        cycle.set((svg.getCurrentTime() % periodSeconds) / periodSeconds)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ref, periodSeconds, enabled, cycle])
  return cycle
}

/** The alive-at-rest beat two vignettes share: a tick that advances only while
 * the card is on screen, and never under reduced motion, so the poster stays
 * still. Callers take it modulo their own length rather than the hook owning
 * one, because a vignette can cycle two lists of different sizes off one beat. */
function useTickWhileInView(ref: RefObject<HTMLElement | null>, periodMs: number): number {
  const reduce = useHydratedReducedMotion()
  const inView = useInView(ref, { amount: 0.5 })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (reduce || !inView) return
    const id = setInterval(() => setTick(value => value + 1), periodMs)
    return () => clearInterval(id)
  }, [reduce, inView, periodMs])

  return tick
}

/* ------------------------------------------------------------------ */
/* 1 · The problem — a shelf of agents that can't see each other       */
/* ------------------------------------------------------------------ */

const SILOS = [
  {
    logo: '/landing/integrations/claude.png',
    name: 'Claude',
    knows: 'pricing rules',
  },
  {
    logo: '/landing/integrations/openai.webp',
    name: 'Codex',
    knows: 'brand voice',
  },
  {
    logo: '/landing/integrations/cursor.png',
    name: 'Cursor',
    knows: 'launch plan',
  },
  { logo: '/landing/integrations/grok.svg', name: 'Grok', knows: 'Q3 numbers' },
  {
    logo: '/landing/integrations/zed.webp',
    name: 'Zed',
    knows: 'customer history',
  },
] as const

/** Two tiny motes that rise off a silo's "knows" chip and dissolve — the
 * knowledge evaporating in place. Pure transform/opacity; skipped entirely
 * under reduced motion so the poster is just the still shelf. */
function EvaporatingMotes({ delay }: { delay: number }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-full h-10">
      {[0, 1].map(i => (
        <motion.span
          key={i}
          className="absolute bottom-0 size-1 rounded-full bg-foreground/45"
          style={{ left: `${38 + i * 22}%` }}
          animate={{ y: [0, -26], opacity: [0, 0.7, 0], scale: [1, 0.5] }}
          transition={{
            duration: 3.2,
            delay: delay + i * 1.4,
            repeat: Infinity,
            repeatDelay: 2.6,
            ease: 'easeOut',
          }}
        />
      ))}
    </span>
  )
}

export function ProblemSection() {
  const reduce = useHydratedReducedMotion()
  return (
    <section className="relative bg-lv2-band-cool">
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <SectionHeader
          eyebrow="The problem"
          title={<>Your team has ten AI agents that don&rsquo;t talk to each other.</>}
          intro={
            <>
              Every seat is its own silo. One teammate&rsquo;s agent learns the pricing rules, the
              brand voice, the customer history — and the agent at the next desk knows none of it.
              The work doesn&rsquo;t compound. It evaporates, seat by seat.
            </>
          }
        />

        {/* The silo shelf: each agent locked in its own cell with the one thing
            only it knows, quietly evaporating. Gaps between cells ARE the
            point — nothing crosses them. */}
        <SectionReveal
          className="mt-14 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5"
          amount={0.4}
        >
          {SILOS.map((silo, i) => (
            <RevealItem
              key={silo.name}
              className={cn(
                'flex flex-col items-center gap-3 rounded-2xl border border-foreground/10 bg-background/55 px-3 py-5 text-center',
                // the odd cell wraps alone on the 2-col mobile grid — center it
                i === 4 &&
                  'col-span-2 justify-self-center px-8 sm:col-span-1 sm:justify-self-auto sm:px-3',
              )}
            >
              <span className="flex size-9 items-center justify-center rounded-xl border border-foreground/10 bg-[hsl(210_30%_99%)] dark:border-transparent dark:bg-[hsl(40_28%_94%)]">
                <Image
                  src={silo.logo}
                  alt=""
                  width={20}
                  height={20}
                  className="size-5 object-contain"
                />
              </span>
              <span className="text-xs font-medium text-foreground/80">{silo.name}</span>
              <span className="relative mt-0.5 inline-flex items-center rounded-full bg-foreground/[0.07] px-2.5 py-1 text-[11px] leading-none text-foreground/65">
                {!reduce && <EvaporatingMotes delay={i * 0.9} />}
                knows: {silo.knows}
              </span>
            </RevealItem>
          ))}
        </SectionReveal>
        <SectionReveal amount={0.6}>
          <RevealItem>
            <p className="mt-8 text-center text-sm font-medium text-foreground/65">
              Same company. Five versions of the truth. Zero shared memory.
            </p>
          </RevealItem>
        </SectionReveal>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 2 · What the workspace does — bento of live vignettes               */
/* ------------------------------------------------------------------ */

/** The shared-memory diagram: three agents wired to one drive. A memory chip
 * travels from the first agent into the drive, the drive glows, and two
 * return pulses carry it out to the other agents — brand blue, because this
 * is the page's "live/shared" moment. SMIL keeps it running with zero JS.
 *
 * Geometry: ONE coordinate system. The chips are absolutely positioned at the
 * exact viewBox points the paths start and end on, and they render on top of
 * the SVG with opaque plates — so the endpoints stay perfectly "docked" at
 * any container width, and travelers simply disappear under the nodes. */
const MV_W = 440
const MV_H = 170
const MV_AGENT_X = 66
const MV_DRIVE_X = 352
const MV_AGENT_YS = [31, 85, 139] as const
// A symmetric fan, drawn agent → drive; the outer curves mirror each other
// and the middle runs straight, so nothing crosses.
const MV_PATHS = [
  `M ${MV_AGENT_X} 31 C 190 31 260 85 ${MV_DRIVE_X} 85`,
  `M ${MV_AGENT_X} 85 L ${MV_DRIVE_X} 85`,
  `M ${MV_AGENT_X} 139 C 190 139 260 85 ${MV_DRIVE_X} 85`,
] as const
const MV_AGENTS = [
  '/landing/integrations/claude.png',
  '/landing/integrations/openai.webp',
  '/landing/integrations/cursor.png',
] as const

/** One station of the diagram, its beats derived from the shared SVG clock:
 * the sender pops as the chip departs, receivers pop + flash a blue "noted"
 * check as their pulse lands. */
function MemoryAgentChip({
  logo,
  i,
  cycle,
  reduce,
}: {
  logo: string
  i: number
  cycle: MotionValue<number>
  reduce: boolean
}) {
  const beat =
    i === 0
      ? { times: [0, 0.02, 0.06, 0.11, 1], scale: [1, 1, 1.09, 1, 1] }
      : i === 1
        ? { times: [0, 0.8, 0.84, 0.89, 1], scale: [1, 1, 1.08, 1, 1] }
        : { times: [0, 0.85, 0.89, 0.94, 1], scale: [1, 1, 1.08, 1, 1] }
  const scale = useTransform(cycle, beat.times, beat.scale)
  const checkTimes = i === 1 ? [0, 0.8, 0.84, 0.96, 0.995, 1] : [0, 0.85, 0.89, 0.96, 0.995, 1]
  const checkOpacity = useTransform(cycle, checkTimes, [0, 0, 1, 1, 0, 0])
  const checkScale = useTransform(cycle, checkTimes, [0.3, 0.3, 1.2, 1, 1, 0.3])
  return (
    <motion.span
      style={reduce ? undefined : { scale }}
      className="relative flex size-9 items-center justify-center rounded-xl border border-foreground/10 bg-[hsl(210_30%_99%)] shadow-sm dark:border-transparent dark:bg-[hsl(40_28%_94%)] sm:size-10"
    >
      <Image src={logo} alt="" width={20} height={20} className="size-4 object-contain sm:size-5" />
      {i > 0 && !reduce && (
        <motion.span
          style={{ opacity: checkOpacity, scale: checkScale }}
          className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-[hsl(214_70%_56%)] shadow-sm"
        >
          <CheckIcon weight="bold" className="size-2.5 text-[hsl(0_0%_100%)]" />
        </motion.span>
      )}
    </motion.span>
  )
}

function MemoryDriveNode({ cycle, reduce }: { cycle: MotionValue<number>; reduce: boolean }) {
  const scale = useTransform(cycle, [0, 0.36, 0.42, 0.48, 1], [1, 1, 1.06, 1, 1])
  const halo = useTransform(cycle, [0, 0.34, 0.42, 0.55, 1], [0, 0, 1, 0, 0])
  return (
    <motion.span
      style={reduce ? undefined : { scale }}
      className="relative flex flex-col items-center gap-1 rounded-2xl border border-foreground/12 bg-background px-2.5 py-2 shadow-sm sm:px-4 sm:py-3"
    >
      {!reduce && (
        <motion.span
          style={{ opacity: halo }}
          className="pointer-events-none absolute -inset-2 rounded-3xl bg-[radial-gradient(ellipse_at_center,hsl(214_70%_56%/0.28),transparent_70%)]"
        />
      )}
      <FolderSimpleIcon weight="duotone" className="relative size-5 text-foreground/75" />
      <span className="relative whitespace-nowrap text-[10px] font-semibold tracking-wide text-foreground/75">
        team-workspace
      </span>
    </motion.span>
  )
}

function MemoryVignette() {
  const reduce = useHydratedReducedMotion()
  const svgRef = useRef<SVGSVGElement>(null)
  const cycle = useSvgCycle(svgRef, 7, !reduce)
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const ids = MV_PATHS.map((_, i) => `mv-${uid}-${i}`)
  // Taller drawing on small screens so the three stations don't crowd — the
  // %-based coordinate system keeps lines and chips docked at any aspect
  // (preserveAspectRatio="none" stretches the paths with it).
  return (
    <div
      className="relative aspect-[440/215] w-full select-none sm:aspect-[440/170]"
      aria-hidden="true"
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${MV_W} ${MV_H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        {MV_PATHS.map((d, i) => (
          <path
            key={d}
            id={ids[i]}
            d={d}
            fill="none"
            className="stroke-foreground/20"
            strokeWidth="1"
            strokeDasharray="3 4"
          />
        ))}
        {!reduce && (
          <>
            {/* the memory chip, written once by the first agent… */}
            <g opacity="0">
              {/* fades in only once fully clear of the agent chip, and out as
                  it slides under the drive node — never a half-hidden label */}
              <animate
                attributeName="opacity"
                values="0;0;1;1;0;0"
                keyTimes="0;0.09;0.14;0.29;0.36;1"
                dur="7s"
                repeatCount="indefinite"
              />
              <animateMotion
                dur="7s"
                repeatCount="indefinite"
                keyPoints="0;0;1;1"
                keyTimes="0;0.04;0.36;1"
                calcMode="linear"
              >
                <mpath href={`#${ids[0]}`} />
              </animateMotion>
              <rect
                x="-34"
                y="-9"
                width="68"
                height="18"
                rx="9"
                className="fill-background stroke-foreground/20 dark:fill-[hsl(40_28%_94%)] dark:stroke-transparent"
              />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-foreground/75 dark:fill-[hsl(218_30%_26%)]"
                fontSize="9"
                fontWeight="600"
              >
                pricing rules
              </text>
            </g>
            {/* …then flows back out to every other agent as a live pulse.
                Same fan paths, ridden in reverse (keyPoints 1 → 0). */}
            {[1, 2].map((pathIdx, i) => (
              <circle key={pathIdx} r="3" className="fill-[hsl(214_70%_56%)]" opacity="0">
                <animate
                  attributeName="opacity"
                  values="0;0;0.9;0.9;0;0"
                  keyTimes="0;0.5;0.55;0.76;0.82;1"
                  dur="7s"
                  begin={`${i * 0.35}s`}
                  repeatCount="indefinite"
                />
                <animateMotion
                  dur="7s"
                  begin={`${i * 0.35}s`}
                  repeatCount="indefinite"
                  keyPoints="1;1;0;0"
                  keyTimes="0;0.5;0.82;1"
                  calcMode="linear"
                >
                  <mpath href={`#${ids[pathIdx]}`} />
                </animateMotion>
              </circle>
            ))}
          </>
        )}
      </svg>

      {/* Every station reacts on the SVG travelers' own clock (useSvgCycle):
          the sender pops as the chip departs, the drive bumps + glows on
          receipt, and each receiver bumps and flashes a blue "noted" check
          as its pulse lands. Positioning translate lives on the OUTER span
          so framer's scale never fights it. Plates are explicit porcelain /
          cream (NOT bg-background: .landing-v2 remaps that class with equal
          specificity, beating dark: overrides) so raster logos stay legible
          in both themes. */}
      {MV_AGENTS.map((logo, i) => (
        <span
          key={logo}
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{
            left: `${(MV_AGENT_X / MV_W) * 100}%`,
            top: `${(MV_AGENT_YS[i]! / MV_H) * 100}%`,
          }}
        >
          <MemoryAgentChip logo={logo} i={i} cycle={cycle} reduce={reduce} />
        </span>
      ))}

      <span
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${(MV_DRIVE_X / MV_W) * 100}%`, top: '50%' }}
      >
        <MemoryDriveNode cycle={cycle} reduce={reduce} />
      </span>
    </div>
  )
}

/** Files the drive keeps filing for itself: a highlight sweeps the rows and
 * re-stamps each file's destination folder — organizing that never asks. */
const PIPELINE_FILES = [
  { name: 'call-with-acme.vtt', tag: '/customers/acme' },
  { name: 'q3-forecast.xlsx', tag: '/finance/q3' },
  { name: 'launch-post-v2.md', tag: '/marketing' },
  { name: 'competitor-scan.json', tag: '/research · refreshed 6am' },
] as const

function PipelineVignette() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const active = useTickWhileInView(ref, 2200) % PIPELINE_FILES.length

  return (
    <div ref={ref} className="flex w-full flex-col gap-1.5" aria-hidden="true">
      {PIPELINE_FILES.map((f, i) => {
        const isActive = !reduce && i === active
        return (
          <motion.div
            key={f.name}
            // the row "snaps into place" as the drive files it
            animate={isActive ? { x: [0, 3, 0] } : { x: 0 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 transition-colors duration-500',
              isActive ? 'bg-background shadow-sm' : 'bg-background/45',
            )}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              {isActive ? (
                <motion.span
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 22 }}
                  className="flex"
                >
                  <CheckCircleIcon
                    weight="fill"
                    className="size-3.5 text-[color:var(--lv2-warm)]"
                  />
                </motion.span>
              ) : (
                <span className="size-1.5 rounded-full bg-foreground/25 transition-colors duration-500" />
              )}
            </span>
            <span className="truncate font-mono text-[11px] text-foreground/75">{f.name}</span>
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={isActive ? 'on' : 'off'}
                initial={reduce ? false : { opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
                className={cn(
                  'ml-auto shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] leading-none',
                  isActive
                    ? 'bg-[color-mix(in_srgb,var(--lv2-warm)_14%,transparent)] font-medium text-[color:var(--lv2-warm)]'
                    : 'text-foreground/55',
                )}
              >
                → {f.tag}
              </motion.span>
            </AnimatePresence>
          </motion.div>
        )
      })}
    </div>
  )
}

/** One line to mount. Types once when it scrolls into view, then holds the
 * connected state — no reset, the terminal just stays mounted. */
const MOUNT_CMD = 'duet connect acme/workspace'
const MOUNT_AGENTS = [
  '/landing/integrations/claude.png',
  '/landing/integrations/openai.webp',
  '/landing/integrations/cursor.png',
  '/landing/integrations/zed.webp',
] as const

function MountVignette() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.6 })
  const [chars, setChars] = useState(0)
  // Bumped on hover to replay the whole mount sequence — but only from the
  // settled state, so hovering mid-type never stutters the animation.
  const [run, setRun] = useState(0)
  const done = chars >= MOUNT_CMD.length

  useEffect(() => {
    if (!inView) return
    if (reduce) {
      setChars(MOUNT_CMD.length)
      return
    }
    setChars(0)
    const id = setInterval(() => {
      setChars(c => {
        if (c >= MOUNT_CMD.length) {
          clearInterval(id)
          return c
        }
        return c + 1
      })
    }, 42)
    return () => clearInterval(id)
  }, [inView, reduce, run])

  return (
    <div
      ref={ref}
      aria-hidden="true"
      onMouseEnter={() => {
        if (done && !reduce) setRun(r => r + 1)
      }}
      // min-h pins the settled height so the hover replay (which briefly
      // unmounts the ✓ block) never collapses the card
      className="min-h-[9rem] w-full rounded-xl bg-[hsl(216_30%_11%)] p-4 font-mono text-[12px] leading-relaxed shadow-[0_12px_32px_-16px_hsl(216_60%_4%/0.5)]"
    >
      <div className="mb-3 flex gap-1.5">
        {['hsl(4 60% 62%)', 'hsl(40 70% 62%)', 'hsl(140 40% 58%)'].map(c => (
          <span key={c} className="size-2 rounded-full opacity-70" style={{ backgroundColor: c }} />
        ))}
      </div>
      <p className="text-[hsl(40_28%_88%)]">
        <span className="text-[hsl(40_14%_55%)]">$ </span>
        {MOUNT_CMD.slice(0, chars)}
        <span
          className={cn(
            'ml-px inline-block h-3.5 w-[7px] translate-y-0.5 bg-[hsl(40_28%_88%)]',
            !reduce && 'animate-pulse',
          )}
        />
      </p>
      <AnimatePresence>
        {done && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.35, ease: 'easeOut' }}
          >
            <p className="mt-1.5 text-[hsl(140_45%_65%)]">✓ connected — shared memory online</p>
            <div className="mt-3 flex items-center gap-2 border-t border-[hsl(40_28%_88%/0.12)] pt-3">
              {MOUNT_AGENTS.map((logo, i) => (
                <motion.span
                  key={logo}
                  initial={reduce ? false : { opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{
                    delay: 0.6 + i * 0.12,
                    type: 'spring',
                    stiffness: 380,
                    damping: 24,
                  }}
                  className="relative flex size-6 items-center justify-center rounded-md bg-[hsl(40_28%_94%/0.85)]"
                >
                  <Image
                    src={logo}
                    alt=""
                    width={14}
                    height={14}
                    className="size-3.5 object-contain"
                  />
                  {/* each agent acknowledges the mount — matches the ✓ line's green */}
                  <motion.span
                    initial={reduce ? false : { opacity: 0, scale: 0.3 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{
                      delay: 1 + i * 0.12,
                      type: 'spring',
                      stiffness: 420,
                      damping: 20,
                    }}
                    className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-[hsl(140_45%_40%)]"
                  >
                    <CheckIcon weight="bold" className="size-1.5 text-[hsl(0_0%_100%)]" />
                  </motion.span>
                </motion.span>
              ))}
              <span className="ml-1 text-[10px] text-[hsl(40_14%_55%)]">4 agents connected</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** What an agent built last night, already live at a URL: a mini browser
 * whose chart draws itself in and then breathes. */
const HOST_BARS = [34, 58, 42, 76, 64, 88] as const

function HostVignette() {
  const reduce = useHydratedReducedMotion()
  // Bumped on hover: keying the animated bits below remounts them, replaying
  // the draw-in (whileInView re-fires since the card is already on screen).
  const [run, setRun] = useState(0)
  return (
    <div
      aria-hidden="true"
      onMouseEnter={() => {
        if (!reduce) setRun(r => r + 1)
      }}
      className="w-full overflow-hidden rounded-xl border border-foreground/10 bg-background shadow-sm"
    >
      <div className="flex items-center gap-2 border-b border-foreground/10 px-3 py-2">
        <div className="flex gap-1.5">
          {[0, 1, 2].map(i => (
            <span key={i} className="size-2 rounded-full bg-foreground/15" />
          ))}
        </div>
        <span className="mx-auto flex items-center gap-1.5 rounded-full bg-foreground/[0.06] px-3 py-1 text-[10px] leading-none text-foreground/70">
          <LockSimpleIcon weight="fill" className="size-2.5" />
          acme-dashboard.duet.so
        </span>
        <span className="w-8" />
      </div>
      <div className="px-4 pb-3 pt-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="h-2 w-24 rounded-full bg-foreground/[0.1]" />
          <span className="flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--lv2-warm)_12%,transparent)] px-2 py-0.5 text-[10px] font-medium leading-none text-[color:var(--lv2-warm)]">
            {/* "deployed" lands right after the chart finishes drawing */}
            <motion.span
              key={run}
              initial={reduce ? false : { opacity: 0, scale: 0.3 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{
                delay: 1.15,
                type: 'spring',
                stiffness: 420,
                damping: 20,
              }}
              className="flex"
            >
              <CheckIcon weight="bold" className="size-2.5" />
            </motion.span>
            built by @scout
          </span>
        </div>
        <div key={run} className="flex h-20 items-end gap-2">
          {HOST_BARS.map((h, i) => {
            // the newest (tallest) bar keeps breathing after the draw-in —
            // the dashboard is live, not a screenshot
            const breathes = !reduce && i === HOST_BARS.length - 1
            return (
              <motion.span
                key={i}
                className="flex-1 rounded-t-[3px]"
                style={{
                  background: 'color-mix(in srgb, var(--lv2-warm) 55%, transparent)',
                }}
                initial={reduce ? { height: `${h}%` } : { height: '6%' }}
                whileInView={
                  breathes ? { height: `${h}%`, opacity: [0.7, 1, 0.7] } : { height: `${h}%` }
                }
                viewport={{ once: true, amount: 0.6 }}
                transition={{
                  height: {
                    duration: 0.8,
                    delay: 0.15 + i * 0.08,
                    ease: [0.22, 1, 0.36, 1],
                  },
                  opacity: {
                    duration: 3.2,
                    delay: 1.2,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  },
                }}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** The pick changes with the task. The jobs on the left are illustrative — the
 * claim is that a different model answers each one, not that any given model
 * owns a given job — while the names on the right are the Max tier's disclosed
 * set, read from the contract so marketing cannot drift from the router. */
const ROUTED_TASKS = [
  'Refactor the billing service',
  'Summarize a 90-minute call',
  'Model the Q3 forecast',
  'Draft the launch announcement',
] as const

function RouterVignette() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const step = useTickWhileInView(ref, 2600)

  const task = ROUTED_TASKS[step % ROUTED_TASKS.length]
  const pickedIndex = step % PUBLIC_FRONTIER_MODELS.length

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="flex w-full flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-5"
    >
      {/* Left — the job on the workspace's desk, swapping on the loop. */}
      <div className="flex min-w-0 flex-1 flex-col justify-center rounded-xl bg-background/70 px-4 py-3.5 shadow-sm">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground/45">
          The task
        </span>
        {/* Grid-stacked so the swapping line cannot resize the panel mid-loop. */}
        <span className="mt-1.5 grid">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={task}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              className="col-start-1 row-start-1 text-sm font-medium text-foreground/85"
            >
              {task}
            </motion.span>
          </AnimatePresence>
        </span>
      </div>

      {/* Middle — the router itself. The line turns with the layout (vertical
          while the card is stacked, horizontal once it sits in a row), so the
          dot at its centre pulses rather than travels: orientation-agnostic,
          and the swap and the sliding pick already carry the motion. */}
      <div className="flex shrink-0 flex-col items-center gap-1.5 self-center">
        {/* Dashed via a border rather than a gradient: a border flips axis with
            the breakpoint, a linear-gradient direction cannot. */}
        <span className="relative h-7 w-0 border-l border-dashed border-foreground/40 sm:h-0 sm:w-16 sm:border-l-0 sm:border-t">
          <motion.span
            className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--lv2-warm)]"
            animate={reduce ? undefined : { opacity: [0.35, 1, 0.35], scale: [0.85, 1.15, 0.85] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
          />
        </span>
        <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/45">
          auto
        </span>
      </div>

      {/* Right — the frontier set, with the picked one lit. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {PUBLIC_FRONTIER_MODELS.map((model, i) => {
          const picked = i === pickedIndex
          return (
            <span
              key={model}
              className={cn(
                'relative flex items-center gap-2 rounded-lg px-3 py-1.5 transition-colors duration-500',
                picked ? 'text-foreground/85' : 'text-foreground/60',
              )}
            >
              {picked && (
                <motion.span
                  // layoutId slides the highlight down the list instead of
                  // blinking it, so the pick reads as a decision being made.
                  layoutId="router-pick"
                  className="absolute inset-0 rounded-lg bg-[color-mix(in_srgb,var(--lv2-warm)_14%,transparent)]"
                  transition={
                    reduce ? { duration: 0 } : { type: 'spring', stiffness: 340, damping: 32 }
                  }
                />
              )}
              <span
                className={cn(
                  'relative size-1.5 shrink-0 rounded-full transition-colors duration-500',
                  picked ? 'bg-[color:var(--lv2-warm)]' : 'bg-foreground/30',
                )}
              />
              <span className="relative truncate text-xs font-medium">{model}</span>
              {picked && (
                <span className="relative ml-auto shrink-0 text-[10px] font-semibold text-[color:var(--lv2-warm)]">
                  picked
                </span>
              )}
            </span>
          )
        })}
      </div>
    </div>
  )
}

const BENTO = [
  {
    Icon: BrainIcon,
    title: 'One memory, every agent',
    body: 'The workspace holds shared memory alongside your files. What one agent learns — your brand voice, pricing rules, customer history — every agent on the team knows the next time it wakes up.',
    vignette: <MemoryVignette />,
    span: 'lg:col-span-7',
  },
  {
    Icon: ArrowsClockwiseIcon,
    title: 'A workspace that works on itself',
    body: 'Pipelines keep the workspace alive: auto-organize what agents drop in, pull fresh data from the web on a schedule, roll up reports overnight. Dropbox stores files. Your workspace does the work.',
    vignette: <PipelineVignette />,
    span: 'lg:col-span-5',
  },
  {
    Icon: PlugsConnectedIcon,
    title: 'Any agent can connect',
    body: 'Claude Cowork, Codex, OpenClaw, a script — anything that can read and write files can work in the workspace. Connect it in one line. No framework to adopt, no integration to build.',
    vignette: <MountVignette />,
    span: 'lg:col-span-5',
  },
  {
    Icon: GlobeIcon,
    title: 'Hosts what your agents build',
    body: 'Dashboards, internal tools, one-pagers — anything an agent builds in the workspace can be served at a real URL. The workspace is where agent work lives, not just where it gets parked.',
    vignette: <HostVignette />,
    span: 'lg:col-span-7',
  },
  {
    Icon: ArrowsSplitIcon,
    title: 'Every frontier model, picked per task',
    body: `Duet's own agents run on the whole frontier — ${PUBLIC_FRONTIER_MODELS.join(', ')} — and route each task to whichever one is best at it, re-deciding as the work changes. You pick a quality level, not a model name, and pay one flat rate whichever model answers.`,
    vignette: <RouterVignette />,
    span: 'lg:col-span-12',
  },
] as const

export function ValuePropsSection() {
  return (
    <section className="relative overflow-hidden">
      {/* The quiet weather instead of per-card shimmer: drifting tone-blobs +
          film grain behind the whole bento, felt more than seen. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <SubtleBackdrop />
        <GrainVeil opacity={0.025} />
      </div>
      <div className="relative mx-auto max-w-6xl px-6 py-20 sm:py-28">
        <SectionHeader
          eyebrow="What the workspace does"
          title="Not storage. A place where work compounds."
        />
        <SectionReveal className="mt-14 grid gap-4 lg:grid-cols-12" amount={0.15}>
          {BENTO.map(card => (
            <RevealItem
              key={card.title}
              className={cn(
                // min-w-0 defeats the grid item's automatic minimum size: the
                // vignettes (mono terminal line, fixed-ratio diagram) have a
                // min-content wider than the phone column, and without this the
                // whole card grows past the track and the section's
                // overflow-hidden shears its right edge off on mobile.
                'group flex min-w-0 flex-col rounded-2xl border border-foreground/10 bg-background/40 p-6 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-foreground/20',
                card.span,
              )}
            >
              <div className="mb-5 flex flex-1 items-center rounded-xl bg-lv2-band-cool/60 p-4">
                {card.vignette}
              </div>
              <h3 className="flex items-start gap-2 text-base font-semibold text-foreground">
                <card.Icon
                  weight="duotone"
                  className="mt-0.5 size-4.5 shrink-0 text-[color:var(--lv2-warm)]"
                  aria-hidden="true"
                />
                {card.title}
              </h3>
              <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-foreground/65">
                {card.body}
              </p>
            </RevealItem>
          ))}
        </SectionReveal>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 3 · Live collaboration — the doc is actually alive                  */
/* ------------------------------------------------------------------ */

const DOC_TYPED = 'Draft the launch post — @scout'

/** A multiplayer cursor that drifts between anchor points forever. */
function DriftCursor({
  name,
  color,
  path,
  duration,
  delay = 0,
}: {
  name: string
  color: string
  path: { x: number[]; y: number[] }
  duration: number
  delay?: number
}) {
  return (
    <motion.span
      aria-hidden="true"
      // hidden on mobile: the fixed-px roam paths overlap the doc's text once
      // the lines wrap on narrow screens
      className="pointer-events-none absolute left-0 top-0 z-10 hidden sm:block"
      animate={{ x: path.x, y: path.y }}
      transition={{
        duration,
        delay,
        repeat: Infinity,
        repeatType: 'mirror',
        ease: 'easeInOut',
      }}
    >
      <svg width="18" height="18" viewBox="0 0 13 13" className="drop-shadow-sm">
        <path d="M1 1 L12 5.5 L6.5 6.5 L5 12 Z" fill={color} stroke="white" strokeWidth="1" />
      </svg>
      <span
        className="ml-3 inline-flex items-center rounded-full px-2 py-1 text-[11px] font-semibold leading-none text-[hsl(0_0%_100%)] shadow-sm"
        style={{ backgroundColor: color }}
      >
        {name}
      </span>
    </motion.span>
  )
}

function LiveDoc() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.5 })
  const [chars, setChars] = useState(0)
  // The payoff beat: a few seconds after scout claims the task, the box
  // ticks and the chip flips to "done" — work actually finishing, on page.
  const [noted, setNoted] = useState(false)
  // The one real interaction in the demo doc: accepting/rejecting claude's
  // suggested edit resolves the footer.
  const [resolution, setResolution] = useState<'accepted' | 'rejected' | null>(null)
  const typed = chars >= DOC_TYPED.length

  useEffect(() => {
    if (!inView) return
    if (reduce) {
      setChars(DOC_TYPED.length)
      setNoted(true)
      return
    }
    const start = setTimeout(() => {
      const id = setInterval(() => {
        setChars(c => {
          if (c >= DOC_TYPED.length) {
            clearInterval(id)
            return c
          }
          return c + 1
        })
      }, 38)
    }, 500)
    return () => clearTimeout(start)
  }, [inView, reduce])

  useEffect(() => {
    if (!typed || reduce) return
    const id = setTimeout(() => setNoted(true), 3200)
    return () => clearTimeout(id)
  }, [typed, reduce])

  // Rendered twice (mobile slot + desktop float) — a plain JSX variable, so
  // both spots stay in lockstep.
  const statusChip = (
    <AnimatePresence mode="popLayout" initial={false}>
      {typed && (
        <motion.span
          key={noted ? 'done' : 'writing'}
          initial={reduce ? false : { opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{
            delay: 0.15,
            type: 'spring',
            stiffness: 380,
            damping: 24,
          }}
          className="inline-flex rounded px-1.5 py-0.5 font-sans text-[10px] font-medium leading-none text-[hsl(0_0%_100%)]"
          style={{
            backgroundColor: noted ? 'hsl(140 40% 38%)' : 'var(--lv2-warm)',
          }}
        >
          {noted ? 'done ✓' : 'scout is writing…'}
        </motion.span>
      )}
    </AnimatePresence>
  )

  return (
    <div
      ref={ref}
      // overflow-hidden: the roaming cursors must clip at the doc's edge, not
      // spill into the page (a horizontal-scroll hazard on small screens)
      className="relative overflow-hidden rounded-2xl border border-foreground/10 bg-background/70 shadow-[0_24px_48px_-24px_hsl(216_60%_4%/0.25)] backdrop-blur-sm"
    >
      {!reduce && (
        <>
          {/* Cursors roam the doc's quiet corners — never over the typing line,
              which already carries the scout chip. */}
          <DriftCursor
            name="scout"
            color="var(--lv2-warm)"
            path={{ x: [60, 150, 95], y: [198, 224, 208] }}
            duration={9}
          />
          <DriftCursor
            name="ray"
            color="hsl(218 18% 55%)"
            path={{ x: [300, 240, 330], y: [88, 66, 100] }}
            duration={12}
            delay={1.5}
          />
        </>
      )}

      <div className="flex items-center justify-between border-b border-foreground/10 px-5 py-3">
        <span className="text-sm font-medium text-foreground/80">launch-plan.md</span>
        <span className="flex items-center gap-2 text-xs text-foreground/65">
          <LiveDot pulse={!reduce} />
          you + 2 agents editing
        </span>
      </div>

      <div className="space-y-3 px-5 py-5 font-mono text-[13px] leading-relaxed text-foreground/75">
        <p className="font-semibold text-foreground"># Launch plan</p>
        <p>- [x] Competitor research — @ray</p>
        <p>- [x] Outline &amp; angle — @claude</p>
        {/* The status chip lives in RESERVED space — floated right into pr-28
            on sm+, a fixed-height slot line on mobile — so the row's height
            never changes when it appears or swaps and the doc doesn't jump. */}
        <p className="relative rounded bg-foreground/[0.06] px-1.5 py-0.5 sm:pr-28">
          -{' '}
          <motion.span
            key={noted ? 'checked' : 'open'}
            initial={noted && !reduce ? { scale: 1.5 } : false}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 420, damping: 18 }}
            className={cn('inline-block', noted && 'text-foreground')}
          >
            [{noted ? 'x' : ' '}]
          </motion.span>{' '}
          {DOC_TYPED.slice(0, chars)}
          <span
            className={cn(
              'ml-0.5 inline-block h-4 w-px translate-y-0.5 bg-foreground/70',
              !reduce && 'animate-pulse',
              noted && 'opacity-0',
            )}
          />
          <span className="mt-1 flex h-5 items-center sm:hidden">{statusChip}</span>
          <span className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 sm:flex">
            {statusChip}
          </span>
        </p>
        <p>- [ ] Fact-check pricing — @ray</p>
      </div>

      {/* The footer is ALWAYS mounted at its settled height — only its content
          fades in when scout finishes — so the doc never grows mid-sequence.
          Accept/Reject are live: resolving swaps in the outcome line. */}
      <div className="flex min-h-[3.25rem] items-center border-t border-foreground/10 px-5 py-2.5">
        <AnimatePresence mode="wait" initial={false}>
          {resolution === null ? (
            <motion.div
              key="ask"
              initial={false}
              animate={{ opacity: typed ? 1 : 0, y: typed ? 0 : 6 }}
              exit={{
                opacity: 0,
                y: -4,
                transition: { duration: 0.16, ease: 'easeIn' },
              }}
              transition={{
                delay: 0.7,
                duration: 0.5,
                ease: [0.22, 1, 0.36, 1],
              }}
              className={cn(
                'flex w-full flex-wrap items-center gap-3',
                !typed && 'pointer-events-none',
              )}
            >
              <span className="text-xs text-foreground/65">
                <span className="font-medium text-foreground/80">claude</span> suggested an edit to
                the intro
              </span>
              <span className="ml-auto flex items-center gap-2">
                <motion.button
                  type="button"
                  whileTap={reduce ? undefined : { scale: 0.92 }}
                  onClick={() => setResolution('rejected')}
                  className="inline-flex items-center rounded-full border border-foreground/15 px-2.5 py-1.5 text-[11px] font-medium leading-none text-foreground/70 transition-colors hover:border-foreground/30 hover:text-foreground"
                >
                  Reject
                </motion.button>
                <motion.button
                  type="button"
                  whileTap={reduce ? undefined : { scale: 0.92 }}
                  onClick={() => setResolution('accepted')}
                  className="inline-flex items-center rounded-full bg-foreground/85 px-2.5 py-1.5 text-[11px] font-medium leading-none text-background transition-colors hover:bg-foreground"
                >
                  Accept
                </motion.button>
              </span>
            </motion.div>
          ) : (
            <motion.div
              key="resolved"
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="flex w-full items-center gap-2 text-xs"
            >
              {resolution === 'accepted' ? (
                <>
                  <motion.span
                    initial={reduce ? false : { scale: 0.4 }}
                    animate={{ scale: 1 }}
                    transition={{
                      delay: 0.08,
                      type: 'spring',
                      stiffness: 420,
                      damping: 18,
                    }}
                    className="flex"
                  >
                    <CheckCircleIcon weight="fill" className="size-4 text-[hsl(140_40%_42%)]" />
                  </motion.span>
                  <span className="text-foreground/75">
                    Edit applied — <span className="font-medium text-foreground/85">claude</span>{' '}
                    updated the intro
                  </span>
                </>
              ) : (
                <span className="text-foreground/65">
                  Suggestion dismissed — claude will take another pass.
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

export function LiveCollabSection() {
  return (
    <section className="relative">
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <div className="grid items-center gap-x-12 gap-y-10 lg:grid-cols-2">
          <div>
            <SectionHeader
              align="left"
              eyebrow="Realtime collaboration"
              title="Agents and people, writing in the same doc."
              intro={
                <>
                  Docs in the workspace are live. Your agents draft, edit, and comment alongside
                  your team in real time — a research agent fills in the findings, a writing agent
                  tightens the draft, you accept or reject the changes. Every edit is signed, human
                  or agent.
                </>
              }
            />
            <SectionReveal className="mt-7" amount={0.6}>
              <ul className="space-y-3">
                {[
                  'Co-edit live — named cursors for every agent and teammate.',
                  'Agents can propose changes as suggestions you approve with one click.',
                  'A doc doubles as a task board — agents claim work and hand off to each other.',
                ].map(item => (
                  <RevealItem key={item}>
                    <span className="flex items-start gap-2.5">
                      <CheckCircleIcon
                        weight="fill"
                        className="mt-0.5 size-4.5 shrink-0 text-foreground/50"
                        aria-hidden="true"
                      />
                      <span className="text-sm leading-relaxed text-foreground/70">{item}</span>
                    </span>
                  </RevealItem>
                ))}
              </ul>
            </SectionReveal>
          </div>
          <SectionReveal amount={0.35}>
            <RevealItem>
              <LiveDoc />
            </RevealItem>
          </SectionReveal>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 4 · For companies — sharing cascades like a folder                  */
/* ------------------------------------------------------------------ */

const CASCADE_MEMBERS = [
  {
    avatar: '/landing/features/ali.jpg',
    name: 'Ali',
    role: 'Sales',
    agent: '/landing/integrations/claude.png',
  },
  {
    avatar: '/landing/features/david.jpg',
    name: 'David',
    role: 'Engineering',
    agent: '/landing/integrations/cursor.png',
  },
  {
    avatar: '/landing/features/walter.png',
    name: 'Walter',
    role: 'Marketing',
    agent: '/landing/integrations/openai.webp',
  },
] as const

const CASCADE_CHIPS = ['pricing', 'brand voice', 'security policy'] as const

export function ForCompaniesSection() {
  const reduce = useHydratedReducedMotion()
  return (
    <section className="relative bg-lv2-band-warm">
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <div className="grid items-start gap-x-14 gap-y-12 lg:grid-cols-2">
          <div>
            <SectionHeader
              align="left"
              eyebrow="For companies"
              title="Enterprise AI rollout, shaped like a folder."
              intro={
                <>
                  Create a company folder, share it with your employees, and every one of their
                  agents inherits the same context, rules, and memory. Data governance rides the
                  same flow as normal file sharing — no new mental model, no rollout project.
                </>
              }
            />
            <SectionReveal className="mt-7" amount={0.6}>
              <ul className="space-y-4">
                {[
                  {
                    Icon: FolderSimpleIcon,
                    text: 'Company folders with per-team access — agents and people follow the same rules.',
                  },
                  {
                    Icon: BrainIcon,
                    text: 'Shared memory scoped to the folder, so context stays where it belongs.',
                  },
                  {
                    Icon: BuildingsIcon,
                    text: 'Works alongside the Claude and Codex seats your company already pays for.',
                  },
                ].map(({ Icon, text }) => (
                  <RevealItem key={text}>
                    <span className="flex items-start gap-3">
                      <Icon
                        weight="duotone"
                        className="mt-0.5 size-5 shrink-0 text-foreground/70"
                        aria-hidden="true"
                      />
                      <span className="text-sm leading-relaxed text-foreground/70">{text}</span>
                    </span>
                  </RevealItem>
                ))}
              </ul>
            </SectionReveal>
          </div>

          {/* The cascade: share the folder once, and context flows down the
              rail into every teammate's agent. */}
          <SectionReveal amount={0.35}>
            <RevealItem className="relative">
              <div className="relative rounded-2xl border border-foreground/12 bg-background/70 p-4 shadow-sm backdrop-blur-sm">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-foreground/[0.06]">
                    <FolderSimpleIcon
                      weight="duotone"
                      className="size-5 text-foreground/75"
                      aria-hidden="true"
                    />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      acme — company workspace
                    </p>
                    <p className="text-xs text-foreground/65">shared with 24 people</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5" aria-hidden="true">
                  {CASCADE_CHIPS.map(chip => (
                    <span
                      key={chip}
                      className="rounded-full bg-foreground/[0.07] px-2.5 py-1 text-[11px] leading-none text-foreground/70"
                    >
                      {chip}
                    </span>
                  ))}
                </div>
              </div>

              {/* pl-14 gives each row's L-elbow a real run from the trunk
                  (which drops from the folder icon at x≈33) to the row edge */}
              <div className="relative mt-6 space-y-3 pl-14">
                <CascadeRail reduce={reduce} />
                {CASCADE_MEMBERS.map((m, i) => (
                  <motion.div
                    key={m.name}
                    initial={reduce ? false : { opacity: 0, x: 12 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true, amount: 0.6 }}
                    transition={{
                      delay: 0.25 + i * 0.16,
                      duration: 0.6,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                    className="relative flex items-center gap-3 rounded-xl border border-foreground/10 bg-background/70 px-4 py-3 backdrop-blur-sm"
                  >
                    {/* the elbow: a dotted stub from the trunk into this seat —
                        every member visibly hangs off the company folder */}
                    <span
                      aria-hidden="true"
                      className="absolute right-full top-1/2 h-px w-[23px] -translate-y-1/2 text-foreground/30"
                      style={{
                        backgroundImage:
                          'repeating-linear-gradient(to right, currentColor 0 2px, transparent 2px 6px)',
                      }}
                    />
                    {/* a warm wash as the rail pulse passes this seat —
                        context arriving, on the cascade's shared clock */}
                    {!reduce && (
                      <motion.span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 rounded-xl"
                        animate={{
                          backgroundColor: [
                            'hsl(25 75% 52% / 0)',
                            'hsl(25 75% 52% / 0)',
                            'hsl(25 75% 52% / 0.09)',
                            'hsl(25 75% 52% / 0)',
                          ],
                        }}
                        transition={{
                          duration: CASCADE_PERIOD,
                          times: [
                            0,
                            Math.max(CASCADE_BEATS[i]! - 0.12, 0),
                            CASCADE_BEATS[i]!,
                            Math.min(CASCADE_BEATS[i]! + 0.12, 1),
                          ],
                          repeat: Infinity,
                          ease: 'easeInOut',
                        }}
                      />
                    )}
                    <Image
                      src={m.avatar}
                      alt=""
                      width={28}
                      height={28}
                      className="size-7 rounded-full object-cover"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-tight text-foreground">{m.name}</p>
                      <p className="text-[11px] leading-tight text-foreground/65">{m.role}</p>
                    </div>
                    {/* the payoff, spelled out: the seat confirms it received
                        the folder's context, in step with the passing pulse */}
                    <motion.span
                      aria-hidden="true"
                      className="ml-auto hidden shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium leading-none text-[color:var(--lv2-warm)] sm:flex"
                      style={{
                        background: 'color-mix(in srgb, var(--lv2-warm) 12%, transparent)',
                      }}
                      animate={reduce ? undefined : { scale: [1, 1, 1.12, 1] }}
                      transition={{
                        duration: CASCADE_PERIOD,
                        times: [
                          0,
                          Math.max(CASCADE_BEATS[i]! - 0.04, 0),
                          Math.min(CASCADE_BEATS[i]! + 0.02, 1),
                          Math.min(CASCADE_BEATS[i]! + 0.12, 1),
                        ],
                        repeat: Infinity,
                        ease: 'easeOut',
                      }}
                    >
                      <CheckIcon weight="bold" className="size-2.5" />
                      context synced
                    </motion.span>
                    <span
                      className="ml-auto flex items-center gap-1.5 rounded-full border border-foreground/10 bg-[hsl(210_30%_99%)] px-2 py-1 dark:border-transparent dark:bg-[hsl(40_28%_94%)] sm:ml-0"
                      aria-hidden="true"
                    >
                      <Image
                        src={m.agent}
                        alt=""
                        width={13}
                        height={13}
                        className="size-3.5 object-contain"
                      />
                      <span className="text-[10px] leading-none text-foreground/65 dark:text-[hsl(218_30%_30%)]">
                        agent
                      </span>
                    </span>
                  </motion.div>
                ))}
              </div>
              <p className="mt-4 pl-14 text-xs text-foreground/65">
                Share once — every seat&rsquo;s agent inherits the same context and rules.
              </p>
            </RevealItem>
          </SectionReveal>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 5 · FAQ — a proper animated accordion                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Pillars: four copy-only cards under a header. The campaign landers   */
/* and the main lander both argue in fours, so the grid has one owner.  */
/* ------------------------------------------------------------------ */

export function PillarsSection({
  eyebrow,
  title,
  intro,
  pillars,
}: {
  eyebrow: string
  title: string
  intro: string
  pillars: readonly { title: string; body: string }[]
}) {
  return (
    <section className="border-y border-foreground/10 bg-background">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <SectionHeader eyebrow={eyebrow} title={title} intro={intro} />
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {pillars.map(pillar => (
            <article
              key={pillar.title}
              className="rounded-3xl border border-foreground/15 bg-foreground/[0.03] p-6 sm:p-7"
            >
              <h3 className="text-lg font-semibold tracking-[-0.02em]">{pillar.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-foreground/70">{pillar.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

export function FaqsSection({
  items,
  title = 'Questions teams ask first.',
  eyebrow = 'FAQ',
}: {
  items: readonly { q: string; a: string }[]
  title?: string
  eyebrow?: string
}) {
  const [open, setOpen] = useState<number | null>(0)
  const uid = useId()
  return (
    <section className="relative">
      <div className="mx-auto max-w-3xl px-6 py-20 sm:py-28">
        <SectionHeader eyebrow={eyebrow} title={title} />
        <SectionReveal className="mt-12" amount={0.2}>
          <RevealItem className="divide-y divide-foreground/10 border-y border-foreground/10">
            {items.map((faq, i) => {
              const isOpen = open === i
              const panelId = `${uid}-faq-${i}`
              return (
                <div key={faq.q}>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    className="group flex w-full items-start justify-between gap-4 py-5 text-left text-base font-medium text-foreground transition-colors hover:text-foreground/80"
                  >
                    {faq.q}
                    <motion.span
                      aria-hidden="true"
                      animate={{ rotate: isOpen ? 45 : 0 }}
                      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                      className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-foreground/15 text-sm text-foreground/60 transition-colors group-hover:border-foreground/30"
                    >
                      +
                    </motion.span>
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        id={panelId}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                          duration: 0.32,
                          ease: [0.22, 1, 0.36, 1],
                        }}
                        className="overflow-hidden"
                      >
                        <p className="max-w-[62ch] pb-5 text-sm leading-relaxed text-foreground/70">
                          {faq.a}
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
          </RevealItem>
        </SectionReveal>
      </div>
    </section>
  )
}
