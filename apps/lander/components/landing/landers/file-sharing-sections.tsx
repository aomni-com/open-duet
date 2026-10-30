'use client'

import {
  ArrowsClockwiseIcon,
  BuildingsIcon,
  CheckCircleIcon,
  CheckIcon,
  EyeIcon,
  FileTextIcon,
  FolderSimpleIcon,
  LockSimpleIcon,
  PencilSimpleIcon,
  ShareNetworkIcon,
  ShieldCheckIcon,
  UsersThreeIcon,
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
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react'

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

/**
 * The below-the-hero sections of the file-sharing lander. Every section SHOWS
 * its claim instead of asserting it: the problem beat has agents visibly
 * bouncing off files their humans can already open; the bento fans a shared
 * file out to people AND their agents; the access-control demo ripples one
 * permission change through a person and their machine in lockstep; the
 * cascade shares a folder once and watches it flow to every seat.
 *
 * Motion law (obeyed here): entrance once on scroll, a quiet alive-at-rest
 * loop after, a static poster under reduced motion (every loop is gated on
 * useHydratedReducedMotion). Brand blue is rationed to ONE meaning per
 * viewport = the shared file arriving / access being granted / sync. Never
 * decoration. Ease-out curves only, no bounce on layout, never animate layout.
 */

/** The SMIL SVG's own clock, exposed as a 0→1 cycle MotionValue so every DOM
 * beat (chip pops, checks, glows) derives from the SAME timeline the SVG
 * travelers ride — no hydration-delay drift between the two clocks. */
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

/* ------------------------------------------------------------------ */
/* 1 · The problem — you shared the file; their agents can't open it   */
/* ------------------------------------------------------------------ */

const LOCKED_SEATS = [
  {
    avatar: '/landing/features/ali.jpg',
    name: 'Ali',
    agent: '/landing/integrations/claude.png',
  },
  {
    avatar: '/landing/features/david.jpg',
    name: 'David',
    agent: '/landing/integrations/cursor.png',
  },
  {
    avatar: '/landing/features/walter.png',
    name: 'Walter',
    agent: '/landing/integrations/openai.webp',
  },
] as const

/** The agent's lock gives a tiny periodic shudder — it keeps knocking and
 * keeps getting turned away. Pure transform; skipped under reduced motion so
 * the poster is just a still locked badge. */
function LockKnock({ delay }: { delay: number }) {
  return (
    <motion.span
      aria-hidden="true"
      className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-foreground/70 text-background shadow-sm"
      animate={{ x: [0, -1.5, 1.5, -1, 0], rotate: [0, -6, 6, -3, 0] }}
      transition={{
        duration: 0.5,
        delay,
        repeat: Infinity,
        repeatDelay: 3.4,
        ease: 'easeOut',
      }}
    >
      <LockSimpleIcon weight="fill" className="size-2.5" />
    </motion.span>
  )
}

export function ProblemSection() {
  const reduce = useHydratedReducedMotion()
  return (
    <section className="relative bg-lv2-band-cool">
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <SectionHeader
          eyebrow="The problem"
          title={<>You shared the folder. Their agents still can&rsquo;t open it.</>}
          intro={
            <>
              Dropbox and Drive share files to people, to eyes on a screen. But the AI agents your
              team runs all day live outside that wall. They can&rsquo;t read the folder you shared,
              so every agent works blind while the files it needs sit one permission away.
            </>
          }
        />

        {/* One shared file at the top; below it, each seat's person opens it
            fine while their agent hits a lock. The gap between "can open" and
            "locked out" IS the point. */}
        <SectionReveal className="mt-14 flex flex-col items-center" amount={0.4}>
          <RevealItem className="flex items-center gap-3 rounded-2xl border border-foreground/12 bg-background/70 px-4 py-3 shadow-sm">
            <span className="flex size-9 items-center justify-center rounded-xl bg-foreground/[0.06]">
              <FolderSimpleIcon
                weight="duotone"
                className="size-5 text-foreground/75"
                aria-hidden="true"
              />
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">
                /pricing, shared with 8 people
              </p>
              <p className="text-xs text-foreground/60">
                q3-pricing.xlsx · contracts.pdf · rules.md
              </p>
            </div>
          </RevealItem>

          <RevealItem className="mt-8 grid w-full gap-3 sm:grid-cols-3">
            {LOCKED_SEATS.map((seat, i) => (
              <div
                key={seat.name}
                className="flex items-center justify-between gap-3 rounded-2xl border border-foreground/10 bg-background/55 px-4 py-4"
              >
                <span className="flex items-center gap-2.5">
                  <span className="relative">
                    <Image
                      src={seat.avatar}
                      alt=""
                      width={32}
                      height={32}
                      className="size-8 rounded-full object-cover"
                    />
                    <span
                      aria-hidden="true"
                      className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-[hsl(140_40%_40%)] text-[hsl(0_0%_100%)] shadow-sm"
                    >
                      <CheckIcon weight="bold" className="size-2.5" />
                    </span>
                  </span>
                  <span className="text-xs font-medium text-foreground/80">
                    {seat.name}
                    <span className="block text-[10px] font-normal text-foreground/55">
                      can open
                    </span>
                  </span>
                </span>
                <span className="relative flex size-9 items-center justify-center rounded-xl border border-dashed border-foreground/20 bg-foreground/[0.03] opacity-70">
                  <Image
                    src={seat.agent}
                    alt=""
                    width={18}
                    height={18}
                    className="size-4.5 object-contain grayscale"
                  />
                  {reduce ? (
                    <span
                      aria-hidden="true"
                      className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-foreground/70 text-background shadow-sm"
                    >
                      <LockSimpleIcon weight="fill" className="size-2.5" />
                    </span>
                  ) : (
                    <LockKnock delay={i * 0.4} />
                  )}
                </span>
              </div>
            ))}
          </RevealItem>

          <RevealItem>
            <p className="mt-8 text-center text-sm font-medium text-foreground/65">
              Same folder. Every person is in. Every agent is locked out.
            </p>
          </RevealItem>
        </SectionReveal>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 2 · What it does — bento of live vignettes                          */
/* ------------------------------------------------------------------ */

/** The share fan-out: a file leaves the folder and one shared pulse rides out
 * to three seats at once. Each seat is a person AND their agent, and BOTH pop
 * a check as the pulse lands — the whole promise in one loop. Brand blue is
 * the shared file in flight (this bento's single blue meaning). SMIL drives
 * the travelers; every DOM beat derives from the SVG clock so nothing drifts. */
const FAN_W = 440
const FAN_H = 184
const FAN_FOLDER_X = 60
const FAN_SEAT_X = 372
const FAN_SEAT_YS = [36, 92, 148] as const
const FAN_PATHS = [
  `M ${FAN_FOLDER_X} 92 C 190 92 250 36 ${FAN_SEAT_X} 36`,
  `M ${FAN_FOLDER_X} 92 L ${FAN_SEAT_X} 92`,
  `M ${FAN_FOLDER_X} 92 C 190 92 250 148 ${FAN_SEAT_X} 148`,
] as const
const FAN_SEATS = [
  {
    avatar: '/landing/features/ali.jpg',
    agent: '/landing/integrations/claude.png',
  },
  {
    avatar: '/landing/features/david.jpg',
    agent: '/landing/integrations/cursor.png',
  },
  {
    avatar: '/landing/features/walter.png',
    agent: '/landing/integrations/openai.webp',
  },
] as const
/** Fraction of the loop when the pulse reaches each seat (staggered along the
 * fan) — the seat pops and both badges tick right here. */
const FAN_BEATS = [0.5, 0.56, 0.62] as const

function FanSeatNode({
  seat,
  i,
  cycle,
  reduce,
}: {
  seat: (typeof FAN_SEATS)[number]
  i: number
  cycle: MotionValue<number>
  reduce: boolean
}) {
  const b = FAN_BEATS[i]!
  const scale = useTransform(
    cycle,
    [0, Math.max(b - 0.04, 0), b, Math.min(b + 0.06, 1), 1],
    [1, 1, 1.08, 1, 1],
  )
  const checkTimes = [0, Math.max(b - 0.02, 0), Math.min(b + 0.02, 1), 0.9, 0.97, 1]
  const checkOpacity = useTransform(cycle, checkTimes, [0, 0, 1, 1, 0, 0])
  return (
    <motion.span
      style={reduce ? undefined : { scale }}
      className="flex items-center gap-1.5 rounded-xl border border-foreground/10 bg-[hsl(210_30%_99%)] px-2 py-1.5 shadow-sm dark:border-transparent dark:bg-[hsl(40_28%_94%)]"
    >
      <span className="relative">
        <Image
          src={seat.avatar}
          alt=""
          width={22}
          height={22}
          className="size-5 rounded-full object-cover"
        />
        {!reduce && (
          <motion.span
            style={{ opacity: checkOpacity }}
            className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-[hsl(140_45%_40%)] text-[hsl(0_0%_100%)]"
          >
            <CheckIcon weight="bold" className="size-1.5" />
          </motion.span>
        )}
      </span>
      <span className="relative">
        <Image src={seat.agent} alt="" width={18} height={18} className="size-4 object-contain" />
        {!reduce && (
          <motion.span
            style={{ opacity: checkOpacity }}
            className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-[hsl(140_45%_40%)] text-[hsl(0_0%_100%)]"
          >
            <CheckIcon weight="bold" className="size-1.5" />
          </motion.span>
        )}
      </span>
    </motion.span>
  )
}

function ShareFanVignette() {
  const reduce = useHydratedReducedMotion()
  const svgRef = useRef<SVGSVGElement>(null)
  const cycle = useSvgCycle(svgRef, 6, !reduce)
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const ids = FAN_PATHS.map((_, i) => `fan-${uid}-${i}`)
  const folderScale = useTransform(cycle, [0, 0.32, 0.4, 0.48, 1], [1, 1, 1.07, 1, 1])
  return (
    <div
      className="relative aspect-[440/210] w-full select-none sm:aspect-[440/184]"
      aria-hidden="true"
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${FAN_W} ${FAN_H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        {FAN_PATHS.map((d, i) => (
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
            {/* the shared file, leaving the folder once and riding every fan
                path out to the seats at the same time */}
            {FAN_PATHS.map((_, i) => (
              <g key={ids[i]} opacity="0">
                <animate
                  attributeName="opacity"
                  values="0;0;1;1;0;0"
                  keyTimes="0;0.34;0.4;0.5;0.56;1"
                  dur="6s"
                  repeatCount="indefinite"
                />
                <animateMotion
                  dur="6s"
                  repeatCount="indefinite"
                  keyPoints="0;0;1;1"
                  keyTimes="0;0.34;0.56;1"
                  calcMode="linear"
                >
                  <mpath href={`#${ids[i]}`} />
                </animateMotion>
                <rect
                  x="-9"
                  y="-9"
                  width="18"
                  height="18"
                  rx="5"
                  className="fill-[hsl(214_70%_56%)]"
                />
                <path
                  d="M-3.5 0 L-0.5 3 L4 -2.5"
                  fill="none"
                  stroke="hsl(0 0% 100%)"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            ))}
          </>
        )}
      </svg>

      <span
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${(FAN_FOLDER_X / FAN_W) * 100}%`, top: '50%' }}
      >
        <motion.span
          style={reduce ? undefined : { scale: folderScale }}
          className="relative flex flex-col items-center gap-1 rounded-2xl border border-foreground/12 bg-background px-2.5 py-2 shadow-sm"
        >
          <ShareNetworkIcon weight="duotone" className="size-5 text-foreground/75" />
          <span className="whitespace-nowrap text-[10px] font-semibold tracking-wide text-foreground/75">
            /pricing
          </span>
        </motion.span>
      </span>

      {FAN_SEATS.map((seat, i) => (
        <span
          key={seat.avatar}
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{
            left: `${(FAN_SEAT_X / FAN_W) * 100}%`,
            top: `${(FAN_SEAT_YS[i]! / FAN_H) * 100}%`,
          }}
        >
          <FanSeatNode seat={seat} i={i} cycle={cycle} reduce={reduce} />
        </span>
      ))}
    </div>
  )
}

/** Agents don't just read — they write. An agent appends a row to the shared
 * file, typed once when the card scrolls in, then a green "saved" stamp holds.
 * No blue here: this card's payoff is green (a write committed), keeping the
 * bento's single blue meaning on the share/sync pulses. */
const WRITE_LINE = '| Enterprise | $2,400/mo | net-60 |'

function ReadWriteVignette() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.6 })
  const [chars, setChars] = useState(0)
  const [run, setRun] = useState(0)
  const done = chars >= WRITE_LINE.length

  useEffect(() => {
    if (!inView) return
    if (reduce) {
      setChars(WRITE_LINE.length)
      return
    }
    setChars(0)
    const start = setTimeout(() => {
      const id = setInterval(() => {
        setChars(c => {
          if (c >= WRITE_LINE.length) {
            clearInterval(id)
            return c
          }
          return c + 1
        })
      }, 34)
      return () => clearInterval(id)
    }, 400)
    return () => clearTimeout(start)
  }, [inView, reduce, run])

  return (
    <div
      ref={ref}
      aria-hidden="true"
      onMouseEnter={() => {
        if (done && !reduce) setRun(r => r + 1)
      }}
      className="min-h-[9rem] w-full rounded-xl border border-foreground/10 bg-background p-3 shadow-sm"
    >
      <div className="mb-2 flex items-center gap-2 border-b border-foreground/10 pb-2">
        <FileTextIcon weight="duotone" className="size-4 text-foreground/60" />
        <span className="font-mono text-[11px] text-foreground/70">pricing.md</span>
        <AnimatePresence>
          {done && (
            <motion.span
              key={run}
              initial={reduce ? false : { opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.15, duration: 0.35, ease: 'easeOut' }}
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,hsl(140_40%_40%)_14%,transparent)] px-2 py-0.5 text-[10px] font-medium leading-none text-[hsl(140_45%_34%)] dark:text-[hsl(140_45%_60%)]"
            >
              <CheckIcon weight="bold" className="size-2.5" />
              saved by @scout
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <div className="space-y-1 font-mono text-[11px] leading-relaxed text-foreground/70">
        <p className="text-foreground/45">| Plan | Price | Terms |</p>
        <p className="text-foreground/45">| Starter | $0 | monthly |</p>
        <p className="text-foreground/45">| Team | $80/mo | monthly |</p>
        <p
          className={cn(
            'rounded px-1 py-0.5 transition-colors',
            !done && 'bg-[color-mix(in_srgb,var(--lv2-warm)_10%,transparent)]',
          )}
        >
          {WRITE_LINE.slice(0, chars)}
          {!done && (
            <span
              className={cn(
                'ml-px inline-block h-3 w-[6px] translate-y-0.5 bg-foreground/60',
                !reduce && 'animate-pulse',
              )}
            />
          )}
        </p>
      </div>
    </div>
  )
}

/** Change a file, every seat sees it now. A version bumps and one blue sync
 * pulse ripples down to three seat tiles that flip to "synced" — the bento's
 * shared blue meaning, second instance (arriving / in sync). */
const SYNC_SEATS = [
  '/landing/integrations/claude.png',
  '/landing/integrations/cursor.png',
  '/landing/integrations/openai.webp',
] as const

function LiveSyncVignette() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.5 })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (reduce || !inView) return
    const id = setInterval(() => setTick(t => t + 1), 3000)
    return () => clearInterval(id)
  }, [reduce, inView])

  const version = 4 + (reduce ? 0 : tick)
  return (
    <div ref={ref} className="w-full" aria-hidden="true">
      <div className="flex items-center gap-2 rounded-xl border border-foreground/10 bg-background px-3 py-2.5 shadow-sm">
        <FileTextIcon weight="duotone" className="size-4 text-foreground/60" />
        <span className="font-mono text-[11px] text-foreground/70">roadmap.md</span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={version}
            initial={reduce ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10px] leading-none text-foreground/60"
          >
            v{version}
          </motion.span>
        </AnimatePresence>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-foreground/60">
          <LiveDot pulse={!reduce} />
          live
        </span>
      </div>
      <div className="mt-3 flex items-center justify-center gap-3">
        {SYNC_SEATS.map((agent, i) => (
          <div key={agent} className="flex flex-col items-center gap-1">
            <span className="relative flex size-9 items-center justify-center rounded-xl border border-foreground/10 bg-[hsl(210_30%_99%)] dark:border-transparent dark:bg-[hsl(40_28%_94%)]">
              <Image
                src={agent}
                alt=""
                width={18}
                height={18}
                className="size-4.5 object-contain"
              />
              {!reduce && (
                <motion.span
                  key={version}
                  className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-[hsl(214_70%_56%)]"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: [0, 0.9, 0], scale: [0.8, 1.15, 1.15] }}
                  transition={{
                    duration: 0.9,
                    delay: 0.15 + i * 0.14,
                    ease: 'easeOut',
                  }}
                />
              )}
            </span>
            <span className="text-[9px] leading-none text-foreground/50">synced</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** It feels like the drive you already use. A plain file browser with a
 * shared-with avatar stack; a soft highlight sweeps the rows at rest so the
 * card breathes without shouting. No blue — familiarity is the point. */
const DRIVE_ROWS = [
  { Icon: FolderSimpleIcon, name: 'customers', meta: '12 files' },
  { Icon: FileTextIcon, name: 'q3-forecast.xlsx', meta: 'shared' },
  { Icon: FileTextIcon, name: 'brand-voice.md', meta: 'shared' },
] as const
const DRIVE_FACES = [
  '/landing/features/ali.jpg',
  '/landing/features/david.jpg',
  '/landing/features/walter.png',
] as const

function FamiliarDriveVignette() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.5 })
  const [active, setActive] = useState(-1)

  useEffect(() => {
    if (reduce || !inView) return
    const id = setInterval(() => setActive(a => (a + 1) % (DRIVE_ROWS.length + 2)), 1100)
    return () => clearInterval(id)
  }, [reduce, inView])

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="w-full overflow-hidden rounded-xl border border-foreground/10 bg-background shadow-sm"
    >
      <div className="flex items-center justify-between border-b border-foreground/10 px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground/70">
          <FolderSimpleIcon weight="duotone" className="size-4" />
          Team drive
        </span>
        <div className="flex -space-x-1.5">
          {DRIVE_FACES.map(f => (
            <Image
              key={f}
              src={f}
              alt=""
              width={18}
              height={18}
              className="size-4.5 rounded-full border border-background object-cover"
            />
          ))}
        </div>
      </div>
      <div className="p-1.5">
        {DRIVE_ROWS.map((row, i) => (
          <div
            key={row.name}
            className={cn(
              'flex items-center gap-2 rounded-lg px-2.5 py-2 transition-colors duration-300',
              i === active ? 'bg-foreground/[0.05]' : 'bg-transparent',
            )}
          >
            <row.Icon weight="duotone" className="size-4 text-foreground/55" />
            <span className="font-mono text-[11px] text-foreground/75">{row.name}</span>
            <span className="ml-auto text-[10px] text-foreground/45">{row.meta}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const BENTO = [
  {
    Icon: ShareNetworkIcon,
    title: 'Share once, people and agents both get it',
    body: 'Drop a file in a shared folder and it fans out to everyone you shared with, and to every one of their agents, at the same instant. One share, two audiences: the human and the machine that works for them.',
    vignette: <ShareFanVignette />,
    span: 'lg:col-span-7',
  },
  {
    Icon: PencilSimpleIcon,
    title: 'Agents read and write, not just read',
    body: 'Your agents don\u2019t peek at a copy. They open the real file, edit it, and save back, with every change signed. A research agent files findings, a spreadsheet agent adds a row, and the version everyone sees updates.',
    vignette: <ReadWriteVignette />,
    span: 'lg:col-span-5',
  },
  {
    Icon: ArrowsClockwiseIcon,
    title: 'Change a file, every seat sees it instantly',
    body: 'Edit a file and the update reaches every person and every agent you shared with in real time. No stale copies, no re-sending, no "which version is current." One source of truth, always live.',
    vignette: <LiveSyncVignette />,
    span: 'lg:col-span-5',
  },
  {
    Icon: FolderSimpleIcon,
    title: 'Feels exactly like the drive you already use',
    body: 'Folders, files, drag and drop, a share button. It looks and works like Dropbox or Google Drive, so your team needs zero training. The only difference is that agents are first-class citizens of it too.',
    vignette: <FamiliarDriveVignette />,
    span: 'lg:col-span-7',
  },
] as const

export function ValuePropsSection() {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <SubtleBackdrop />
        <GrainVeil opacity={0.025} />
      </div>
      <div className="relative mx-auto max-w-6xl px-6 py-20 sm:py-28">
        <SectionHeader eyebrow="What it does" title="File sharing your agents can actually use." />
        <SectionReveal className="mt-14 grid gap-4 lg:grid-cols-12" amount={0.15}>
          {BENTO.map(card => (
            <RevealItem
              key={card.title}
              className={cn(
                'group flex flex-col rounded-2xl border border-foreground/10 bg-background/40 p-6 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-foreground/20',
                card.span,
              )}
            >
              <div className="mb-5 flex flex-1 items-center rounded-xl bg-lv2-band-cool/60 p-4">
                {card.vignette}
              </div>
              <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
                <card.Icon
                  weight="duotone"
                  className="size-4.5 text-[color:var(--lv2-warm)]"
                  aria-hidden="true"
                />
                {card.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-foreground/65">{card.body}</p>
            </RevealItem>
          ))}
        </SectionReveal>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 3 · Access control — one rule, applied to person and agent alike    */
/* ------------------------------------------------------------------ */

const ACCESS_LEVELS = [
  { key: 'none', label: 'No access', Icon: LockSimpleIcon },
  { key: 'view', label: 'Can view', Icon: EyeIcon },
  { key: 'edit', label: 'Can edit', Icon: PencilSimpleIcon },
] as const

type AccessKey = (typeof ACCESS_LEVELS)[number]['key']

/** One capability row (a person or their agent). Its badge reads whatever
 * level is selected — and because person and agent read the SAME state, they
 * always match. Brand blue = the active grant (this section's one meaning). */
function AccessRow({
  label,
  sub,
  icon,
  level,
  reduce,
}: {
  label: string
  sub: string
  icon: ReactNode
  level: AccessKey
  reduce: boolean
}) {
  const current = ACCESS_LEVELS.find(l => l.key === level)!
  const granted = level !== 'none'
  return (
    <div className="relative flex items-center gap-3 overflow-hidden rounded-xl border border-foreground/10 bg-background/70 px-4 py-3">
      {/* a blue wash sweeps the row each time the grant changes to a live
          level — access rippling through this seat */}
      {!reduce && granted && (
        <motion.span
          key={level}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background: 'linear-gradient(90deg, transparent, hsl(214 70% 56% / 0.14), transparent)',
          }}
          initial={{ x: '-100%' }}
          animate={{ x: '120%' }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
        />
      )}
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground/70">
        {icon}
      </span>
      <div className="relative min-w-0">
        <p className="text-sm font-medium leading-tight text-foreground">{label}</p>
        <p className="text-[11px] leading-tight text-foreground/55">{sub}</p>
      </div>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={level}
          initial={reduce ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className={cn(
            'relative ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium leading-none',
            granted
              ? 'bg-[color-mix(in_srgb,hsl(214_70%_56%)_16%,transparent)] text-[hsl(214_60%_42%)] dark:text-[hsl(214_75%_72%)]'
              : 'bg-foreground/[0.06] text-foreground/55',
          )}
        >
          <current.Icon weight="bold" className="size-3" />
          {current.label}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

function AccessControlDemo() {
  const reduce = useHydratedReducedMotion()
  const [level, setLevel] = useState<AccessKey>('edit')
  return (
    <div className="rounded-2xl border border-foreground/12 bg-background/70 p-5 shadow-[0_24px_48px_-24px_hsl(216_60%_4%/0.25)] backdrop-blur-sm">
      <div className="flex items-center gap-3 border-b border-foreground/10 pb-4">
        <span className="flex size-9 items-center justify-center rounded-xl bg-foreground/[0.06]">
          <FileTextIcon weight="duotone" className="size-5 text-foreground/75" aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-semibold text-foreground">q4-forecast.xlsx</p>
          <p className="text-xs text-foreground/60">David&rsquo;s access to this file</p>
        </div>
      </div>

      {/* the one control: pick David's access and watch it apply to him AND
          his agent, together, never separately */}
      <div
        className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-foreground/[0.05] p-1"
        role="group"
        aria-label="Access level"
      >
        {ACCESS_LEVELS.map(l => {
          const selected = l.key === level
          return (
            <button
              key={l.key}
              type="button"
              aria-pressed={selected}
              onClick={() => setLevel(l.key)}
              className={cn(
                'relative flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(214_65%_50%)]',
                selected ? 'text-foreground' : 'text-foreground/55 hover:text-foreground/80',
              )}
            >
              {selected && (
                <motion.span
                  layoutId="access-pill"
                  className="absolute inset-0 rounded-lg bg-background shadow-sm"
                  transition={
                    reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }
                  }
                />
              )}
              <l.Icon weight="bold" className="relative size-3.5" aria-hidden="true" />
              <span className="relative">{l.label}</span>
            </button>
          )
        })}
      </div>

      <div className="mt-4 space-y-2.5">
        <AccessRow
          label="David"
          sub="Engineering"
          level={level}
          reduce={reduce}
          icon={
            <Image
              src="/landing/features/david.jpg"
              alt=""
              width={24}
              height={24}
              className="size-6 rounded-full object-cover"
            />
          }
        />
        <AccessRow
          label="David&rsquo;s agent"
          sub="Cursor · inherits David&rsquo;s rules"
          level={level}
          reduce={reduce}
          icon={
            <Image
              src="/landing/integrations/cursor.png"
              alt=""
              width={18}
              height={18}
              className="size-4.5 object-contain"
            />
          }
        />
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-xs text-foreground/60">
        <ShieldCheckIcon
          weight="duotone"
          className="size-4 shrink-0 text-foreground/50"
          aria-hidden="true"
        />
        One rule covers the person and their agent. Revoke access and both lose it at once.
      </p>
    </div>
  )
}

export function AccessControlSection() {
  return (
    <section className="relative">
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <div className="grid items-center gap-x-12 gap-y-10 lg:grid-cols-2">
          <div>
            <SectionHeader
              align="left"
              eyebrow="Access control"
              title="One permission covers the person and their agent."
              intro={
                <>
                  Grant access to a teammate and their agent gets exactly the same reach, no more,
                  no less. Move someone to view-only and their agent goes read-only too. Revoke, and
                  both lose it in the same instant. Try it:
                </>
              }
            />
            <SectionReveal className="mt-7" amount={0.6}>
              <ul className="space-y-3">
                {[
                  'Agents inherit their owner\u2019s permissions, so there is nothing extra to configure.',
                  'Change access in one place and it applies to people and machines together.',
                  'Every file touch is logged with who, or which agent, did it.',
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
              <AccessControlDemo />
            </RevealItem>
          </SectionReveal>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 4 · For companies — one folder, cascaded to every seat + agent      */
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

export function ShareCascadeSection() {
  const reduce = useHydratedReducedMotion()
  return (
    <section className="relative bg-lv2-band-warm">
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <div className="grid items-start gap-x-14 gap-y-12 lg:grid-cols-2">
          <div>
            <SectionHeader
              align="left"
              eyebrow="For companies"
              title="Enterprise data governance, shaped like a folder."
              intro={
                <>
                  Create a company folder, share it with your teams, and every employee, plus every
                  agent they run, inherits the same files under the same rules. Data governance
                  rides the file-sharing flow people already know. No new mental model, no rollout
                  project.
                </>
              }
            />
            <SectionReveal className="mt-7" amount={0.6}>
              <ul className="space-y-4">
                {[
                  {
                    Icon: FolderSimpleIcon,
                    text: 'Company folders with per-team access, applied to people and agents alike.',
                  },
                  {
                    Icon: UsersThreeIcon,
                    text: 'Add a hire, and their agent inherits the right folders on day one.',
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

          {/* The cascade: share the folder once, and it flows down the rail
              into every teammate AND their agent. */}
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
                    <p className="text-sm font-semibold text-foreground">acme: company drive</p>
                    <p className="text-xs text-foreground/65">shared with 24 people · 24 agents</p>
                  </div>
                </div>
              </div>

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
                    <span
                      aria-hidden="true"
                      className="absolute right-full top-1/2 h-px w-[23px] -translate-y-1/2 text-foreground/30"
                      style={{
                        backgroundImage:
                          'repeating-linear-gradient(to right, currentColor 0 2px, transparent 2px 6px)',
                      }}
                    />
                    {!reduce && (
                      <motion.span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 rounded-xl"
                        animate={{
                          backgroundColor: [
                            'hsl(214 70% 56% / 0)',
                            'hsl(214 70% 56% / 0)',
                            'hsl(214 70% 56% / 0.1)',
                            'hsl(214 70% 56% / 0)',
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
                    <motion.span
                      aria-hidden="true"
                      className="ml-auto hidden shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium leading-none text-[hsl(214_60%_42%)] dark:text-[hsl(214_75%_72%)] sm:flex"
                      style={{
                        background: 'color-mix(in srgb, hsl(214 70% 56%) 14%, transparent)',
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
                      files synced
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
                Share once. Every seat and its agent inherit the same files and rules.
              </p>
            </RevealItem>
          </SectionReveal>
        </div>
      </div>
    </section>
  )
}
