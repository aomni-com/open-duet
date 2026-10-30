'use client'

import {
  ArrowsClockwiseIcon,
  BrainIcon,
  CheckIcon,
  FileCsvIcon,
  FileImageIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileXlsIcon,
  LightningIcon,
  StackIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import { AnimatePresence, motion, useInView } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { LiveDot, useHydratedReducedMotion } from '@/components/landing/atoms'
import { GrainVeil } from '@/components/landing/grain-veil'
import { SectionHeader } from '@/components/landing/landers/section-primitives'
import { RevealItem, SectionReveal } from '@/components/landing/section-reveal'
import { SubtleBackdrop } from '@/components/landing/subtle-backdrop'

/**
 * The below-the-hero sections of the agent-cloud lander — the problem-first
 * variant aimed at the heavy AI power user (Claude Max, Codex, the vibe-coder,
 * the 10-person AI-native startup). Its one promise: give your agents a home
 * in the cloud, persistent memory, files, and a place to run, so their work
 * compounds session over session instead of resetting to zero.
 *
 * Motion law (inherited from the family): every section SHOWS its claim, never
 * just asserts it. Entrance once on scroll, then a quiet alive-at-rest loop; a
 * static poster under reduced motion (every loop is gated on
 * useHydratedReducedMotion). Brand blue is rationed to ONE meaning across the
 * page: persistence — memory that survives the session, an agent that is
 * genuinely live. The amnesia beats stay in muted neutrals and a warm caution
 * amber so the loss reads as loss, and the blue lands only when the work is
 * finally kept. Ease-out curves only; transforms over layout properties.
 */

/** The rationed persistence blue — the one hue allowed to mean "kept / live". */
const PERSIST_BLUE = 'hsl(214 70% 56%)'
/** The amnesia caution amber — used only where context is being lost or re-paid. */
const LEAK_AMBER = 'hsl(28 80% 52%)'

/* ------------------------------------------------------------------ */
/* 1 · The problem — the session resets to zero, on a loop             */
/* ------------------------------------------------------------------ */

/** The context an agent painstakingly re-learns every single session. */
const CONTEXT_CHIPS = [
  'brand + tone',
  'the codebase map',
  "yesterday's plan",
  'customer history',
  'open decisions',
] as const

/** One agent session, played on a loop with three legible beats so the message
 * lands unmistakably:
 *   1. LOADING  the agent re-pastes context chip by chip, the amber bar climbs.
 *   2. READY    a short hold at full — "up to speed", the only useful moment.
 *   3. LOST     a new session wipes it: the chips clear left-to-right, the bar
 *               drops to zero, a caution stamp fires, and the waste meters tick.
 * The whole point is the contrast between beat 2 and beat 3: you pay to get it
 * up to speed, then it forgets. Everything derives from one `tick` counter, so
 * the loop is a single interval with no drift and no timer leak. */
const LOAD_STEPS = CONTEXT_CHIPS.length
const HOLD_TICKS = 2 // dwell at "up to speed" so the loss has something to destroy
const LOST_TICKS = 4 // linger on the wipe — the loss is the point, let it land
const CYCLE_TICKS = LOAD_STEPS + HOLD_TICKS + LOST_TICKS
const TICK_MS = 560

function ResetSessionLoop() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.5 })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    // Reduced motion / off-screen: no clock. The derived values below settle to
    // a full, "up to speed" poster when `reduce` is true.
    if (reduce || !inView) return
    const id = setInterval(() => setTick(t => t + 1), TICK_MS)
    return () => clearInterval(id)
  }, [reduce, inView])

  const cycle = tick % CYCLE_TICKS
  const resets = reduce ? 0 : Math.floor(tick / CYCLE_TICKS)
  const phase: 'loading' | 'ready' | 'lost' = reduce
    ? 'ready'
    : cycle < LOAD_STEPS
      ? 'loading'
      : cycle < LOAD_STEPS + HOLD_TICKS
        ? 'ready'
        : 'lost'
  const step = reduce
    ? LOAD_STEPS
    : phase === 'loading'
      ? cycle + 1
      : phase === 'ready'
        ? LOAD_STEPS
        : 0
  const fill = step / LOAD_STEPS
  // Illustrative burn: every reset re-pays for the same context to be re-read.
  const wasted = resets * 0.9

  const statusLabel =
    phase === 'ready' ? 'up to speed' : phase === 'lost' ? 'starting over' : 'getting up to speed'

  // The single tick the wipe begins on: shake the card once, right here.
  const justLost = !reduce && phase === 'lost' && cycle === LOAD_STEPS + HOLD_TICKS

  return (
    <div ref={ref} aria-hidden="true" className="flex flex-col gap-4">
      <motion.div
        className="relative overflow-hidden rounded-2xl border border-foreground/10 bg-background/70 p-5 shadow-sm"
        animate={justLost ? { x: [0, -7, 6, -5, 4, -2, 0] } : { x: 0 }}
        transition={justLost ? { duration: 0.6, ease: 'easeInOut' } : { duration: 0.2 }}
      >
        {/* the wipe: a pale sweep + a caution stamp on each new session */}
        <AnimatePresence>
          {phase === 'lost' && !reduce && (
            <motion.div
              key={`lost-${resets}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.32, ease: 'easeOut' }}
              className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center"
            >
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold"
                style={{
                  backgroundColor: 'color-mix(in srgb, hsl(28 80% 52%) 16%, transparent)',
                  color: LEAK_AMBER,
                }}
              >
                <ArrowsClockwiseIcon weight="bold" className="size-3" />
                new session · context lost
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mb-4 flex items-center justify-between">
          <span
            className={cn(
              'text-xs font-medium transition-colors duration-300',
              phase !== 'lost' && 'text-foreground/70',
            )}
            style={phase === 'lost' ? { color: LEAK_AMBER } : undefined}
          >
            {statusLabel}
          </span>
          <span className="font-mono text-[11px] text-foreground/50">
            {step}/{LOAD_STEPS}
          </span>
        </div>

        {/* the fill bar re-climbs from empty every session (scaleX, not width) */}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
          <motion.div
            className="h-full origin-left rounded-full"
            style={{ backgroundColor: LEAK_AMBER }}
            animate={{ scaleX: fill || 0.001 }}
            transition={{
              // The loss drains slower than the fill so it reads as a drain.
              duration: phase === 'lost' ? 0.9 : 0.4,
              ease: 'easeOut',
            }}
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {CONTEXT_CHIPS.map((chip, i) => {
            const loaded = i < step
            return (
              <span
                key={chip}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] leading-none transition-all duration-300',
                  loaded
                    ? 'border-foreground/10 bg-foreground/[0.06] text-foreground/70'
                    : 'border-dashed border-foreground/15 text-foreground/30',
                )}
                // On the wipe, clear the chips left-to-right so you SEE the
                // context drain away rather than blink off all at once.
                style={{
                  transitionDuration: phase === 'lost' ? '500ms' : '300ms',
                  transitionDelay: phase === 'lost' && !reduce ? `${i * 110}ms` : '0ms',
                }}
              >
                {loaded ? chip : `re-paste ${chip}`}
              </span>
            )
          })}
        </div>
      </motion.div>

      {/* the value leak: sessions started from scratch + context re-paid for */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-foreground/10 bg-background/55 px-4 py-3">
          <p className="font-mono text-2xl font-semibold tabular-nums text-foreground/80">
            {resets}
          </p>
          <p className="mt-0.5 text-[11px] leading-tight text-foreground/60">
            sessions started from zero
          </p>
        </div>
        <div
          className="rounded-xl border px-4 py-3"
          style={{
            borderColor: 'color-mix(in srgb, hsl(28 80% 52%) 22%, transparent)',
            backgroundColor: 'color-mix(in srgb, hsl(28 80% 52%) 6%, transparent)',
          }}
        >
          <p
            className="flex items-center gap-1 font-mono text-2xl font-semibold tabular-nums"
            style={{ color: LEAK_AMBER }}
          >
            <WarningIcon weight="fill" className="size-4" />
            {wasted.toFixed(1)}h
          </p>
          <p className="mt-0.5 text-[11px] leading-tight text-foreground/60">
            re-explaining what it already did
          </p>
        </div>
      </div>
    </div>
  )
}

export function ProblemSection() {
  return (
    <section className="relative bg-lv2-band-cool">
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <div className="grid items-center gap-x-14 gap-y-12 lg:grid-cols-2">
          <div>
            <SectionHeader
              align="left"
              eyebrow="The problem"
              title={<>You&rsquo;re paying top dollar for agents with amnesia.</>}
              intro={
                <>
                  The frontier models are astonishing. The thing they lack is continuity. Every
                  session starts from zero, you re-paste the same context you pasted yesterday, and
                  last night&rsquo;s work evaporates the moment the window closes. Brilliant, and
                  unable to remember what it just built.
                </>
              }
            />
            <SectionReveal className="mt-7" amount={0.6}>
              <ul className="space-y-3">
                {[
                  'Every session opens with re-explaining context.',
                  "Yesterday's files are gone. Nothing it learns sticks.",
                  "No two sessions build on each other's work.",
                ].map(item => (
                  <RevealItem key={item}>
                    <span className="flex items-center gap-2.5">
                      <WarningIcon
                        weight="fill"
                        className="size-3.5 shrink-0 text-foreground/40"
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
              <ResetSessionLoop />
            </RevealItem>
          </SectionReveal>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 2 · The home — bento of live vignettes                              */
/* ------------------------------------------------------------------ */

/** Persistent memory, shown as an actual recall. Every session the agent has
 * lived is a dot on a timeline; on a loop a blue "reading" glow climbs from the
 * OLDEST memory up to "just now", lighting each dot as it is recalled and
 * brightening that line of text. All dots stay blue (everything is kept); the
 * newest carries the live dot. This is the page's rationed-blue beat: blue only
 * ever means "remembered / live". */
const MEMORY_LOG = [
  { when: 'just now', note: 'picked up the Acme quote where it left off' },
  { when: 'yesterday', note: 'shipped pricing model v3' },
  { when: 'Monday', note: 'mapped the payments codebase' },
  { when: 'last week', note: 'learned the brand voice' },
] as const

const MEM_REST_TICKS = 3
const MEM_CYCLE_TICKS = MEMORY_LOG.length + MEM_REST_TICKS
const MEM_TICK_MS = 620

function MemoryTimelineVignette() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.5 })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (reduce || !inView) return
    const id = setInterval(() => setTick(t => t + 1), MEM_TICK_MS)
    return () => clearInterval(id)
  }, [reduce, inView])

  const cycle = tick % MEM_CYCLE_TICKS
  // Recall reads oldest (bottom) to newest (top). Entry 0 is "just now".
  const active = reduce || cycle >= MEMORY_LOG.length ? -1 : MEMORY_LOG.length - 1 - cycle

  return (
    <div ref={ref} className="relative w-full" aria-hidden="true">
      {/* the trunk: a persistent line every memory hangs on, forever */}
      <span className="absolute bottom-2 left-[7px] top-2 w-px bg-foreground/12" />
      <div className="flex flex-col gap-3">
        {MEMORY_LOG.map((entry, i) => {
          const isNewest = i === 0
          const isActive = i === active
          return (
            <div key={entry.note} className="flex items-start gap-3 pl-0.5">
              <span className="relative mt-1 flex size-3.5 shrink-0 items-center justify-center">
                {isNewest ? (
                  <LiveDot pulse={!reduce} />
                ) : (
                  <motion.span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: PERSIST_BLUE }}
                    animate={{
                      scale: isActive ? [1, 1.6, 1] : 1,
                      opacity: reduce ? 1 : isActive ? 1 : 0.5,
                    }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                  />
                )}
                {isActive && !isNewest && (
                  <motion.span
                    className="absolute inset-0 rounded-full"
                    style={{ boxShadow: `0 0 10px 2px ${PERSIST_BLUE}` }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 0.9, 0] }}
                    transition={{ duration: 0.62, ease: 'easeOut' }}
                  />
                )}
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                  {entry.when}
                </p>
                <motion.p
                  className="text-xs leading-snug text-foreground/75"
                  animate={{ opacity: reduce ? 1 : isActive ? 1 : 0.7 }}
                  transition={{ duration: 0.4 }}
                >
                  {entry.note}
                </motion.p>
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-4 pl-6 text-[11px] font-medium text-foreground/50">
        every session reads from here. nothing wipes.
      </p>
    </div>
  )
}

/** Files that stay put, shown as the exact inverse of the Problem wipe. On a
 * loop a blue "new session" begins (mirroring the amber "context lost" chip),
 * and instead of draining, every file flashes "still here" top to bottom while a
 * session counter climbs. Real artifacts of every kind — spreadsheets, decks,
 * images, PDFs — not just text, each with its own file glyph. */
const WORKSPACE_FILES = [
  {
    name: 'q4-forecast.csv',
    meta: 'today',
    Icon: FileCsvIcon,
    tint: 'hsl(178 44% 40%)',
  },
  {
    name: 'board-deck.pptx',
    meta: '2 sessions',
    Icon: FilePptIcon,
    tint: 'hsl(22 78% 52%)',
  },
  {
    name: 'logo-final.png',
    meta: '3 sessions',
    Icon: FileImageIcon,
    tint: 'hsl(265 46% 60%)',
  },
  {
    name: 'pricing-model.xlsx',
    meta: 'last week',
    Icon: FileXlsIcon,
    tint: 'hsl(146 46% 42%)',
  },
  {
    name: 'research.pdf',
    meta: 'last week',
    Icon: FilePdfIcon,
    tint: 'hsl(2 62% 56%)',
  },
] as const

const FILE_REST_TICKS = 3
const FILE_CYCLE_TICKS = WORKSPACE_FILES.length + FILE_REST_TICKS
const FILE_TICK_MS = 560

function FilesVignette() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.5 })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (reduce || !inView) return
    const id = setInterval(() => setTick(t => t + 1), FILE_TICK_MS)
    return () => clearInterval(id)
  }, [reduce, inView])

  const cycle = tick % FILE_CYCLE_TICKS
  const sessions = 11 + (reduce ? 0 : Math.floor(tick / FILE_CYCLE_TICKS))
  // Each cycle a new session begins; the confirm ripple reads top to bottom.
  const confirming = reduce || cycle >= WORKSPACE_FILES.length ? -1 : cycle
  const boundary = !reduce && cycle === 0 && tick > 0

  return (
    <div ref={ref} className="w-full" aria-hidden="true">
      <div className="mb-2 flex h-4 items-center justify-between px-1">
        <span className="text-[11px] font-medium text-foreground/55">workspace</span>
        <AnimatePresence mode="wait">
          {boundary ? (
            <motion.span
              key={`boundary-${sessions}`}
              initial={{ opacity: 0, y: -2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{
                backgroundColor: 'color-mix(in srgb, hsl(214 70% 56%) 15%, transparent)',
                color: PERSIST_BLUE,
              }}
            >
              <ArrowsClockwiseIcon weight="bold" className="size-2.5" />
              new session
            </motion.span>
          ) : (
            <span key="count" className="font-mono text-[10px] tabular-nums text-foreground/40">
              kept across {sessions} sessions
            </span>
          )}
        </AnimatePresence>
      </div>

      <div className="space-y-1.5">
        {WORKSPACE_FILES.map((f, i) => {
          const active = i === confirming
          const Icon = f.Icon
          return (
            <motion.div
              key={f.name}
              className="flex items-center gap-2 rounded-lg bg-background/55 px-3 py-2"
              animate={{
                boxShadow: active
                  ? `inset 0 0 0 1px color-mix(in srgb, ${PERSIST_BLUE} 45%, transparent)`
                  : 'inset 0 0 0 1px transparent',
              }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
            >
              <Icon weight="duotone" className="size-3.5 shrink-0" style={{ color: f.tint }} />
              <span className="truncate font-mono text-[11px] text-foreground/75">{f.name}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px]">
                {active ? (
                  <motion.span
                    key="here"
                    className="flex items-center gap-1 font-medium"
                    style={{ color: PERSIST_BLUE }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.25 }}
                  >
                    <CheckIcon weight="bold" className="size-2.5" />
                    still here
                  </motion.span>
                ) : (
                  <span className="text-foreground/45">kept · {f.meta}</span>
                )}
              </span>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

/** A place to run: a long-running process that survives the session. An uptime
 * ticker climbs and a warm "running" bead breathes — the agent's job keeps
 * going after you close the tab. */
function RunVignette() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.5 })
  const [secs, setSecs] = useState(3742)

  useEffect(() => {
    if (reduce || !inView) return
    const id = setInterval(() => setSecs(s => s + 1), 1000)
    return () => clearInterval(id)
  }, [reduce, inView])

  const hh = Math.floor(secs / 3600)
  const mm = Math.floor((secs % 3600) / 60)
  const ss = secs % 60
  const pad = (n: number) => String(n).padStart(2, '0')

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="w-full rounded-xl bg-[hsl(216_30%_11%)] p-4 font-mono text-[11px] leading-relaxed shadow-[0_12px_32px_-16px_hsl(216_60%_4%/0.5)]"
    >
      <div className="flex items-center justify-between border-b border-[hsl(40_28%_88%/0.12)] pb-2">
        <span className="flex items-center gap-1.5 text-[hsl(40_28%_88%)]">
          <motion.span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: 'hsl(140 55% 55%)' }}
            animate={reduce ? undefined : { opacity: [1, 0.35, 1] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          />
          nightly-digest
        </span>
        <span className="text-[hsl(40_14%_55%)]">
          up {hh}:{pad(mm)}:{pad(ss)}
        </span>
      </div>
      <p className="mt-2 text-[hsl(40_14%_60%)]">
        <span className="text-[hsl(140_45%_65%)]">→</span> still running after you logged off
      </p>
      <p className="text-[hsl(40_14%_60%)]">
        <span className="text-[hsl(140_45%_65%)]">→</span> next wake: 06:00, memory attached
      </p>
    </div>
  )
}

/** Work that compounds: session bars that grow taller each session, next to a
 * flat dashed line marking where an amnesiac agent restarts every time. The
 * bars draw in on scroll; the tallest keeps breathing. Before/after in one
 * frame. */
const COMPOUND_BARS = [26, 40, 55, 72, 92] as const

function CompoundVignette() {
  const reduce = useHydratedReducedMotion()
  return (
    <div className="w-full" aria-hidden="true">
      <div className="relative flex h-24 items-end gap-2">
        {/* the amnesiac baseline: flat, restarts at zero every session */}
        <span
          className="pointer-events-none absolute inset-x-0 bottom-[26%] border-t border-dashed"
          style={{
            borderColor: 'color-mix(in srgb, hsl(28 80% 52%) 45%, transparent)',
          }}
        />
        {COMPOUND_BARS.map((h, i) => {
          const tallest = i === COMPOUND_BARS.length - 1
          const breathes = !reduce && tallest
          return (
            <motion.span
              key={i}
              className="flex-1 origin-bottom rounded-t-[3px]"
              style={{
                backgroundColor: tallest
                  ? PERSIST_BLUE
                  : 'color-mix(in srgb, hsl(214 70% 56%) 45%, transparent)',
                height: `${h}%`,
              }}
              initial={reduce ? { scaleY: 1 } : { scaleY: 0 }}
              whileInView={breathes ? { scaleY: 1, opacity: [0.75, 1, 0.75] } : { scaleY: 1 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{
                scaleY: {
                  duration: 0.7,
                  delay: 0.1 + i * 0.09,
                  ease: [0.22, 1, 0.36, 1],
                },
                opacity: {
                  duration: 3.2,
                  delay: 1,
                  repeat: Infinity,
                  ease: 'easeInOut',
                },
              }}
            />
          )
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-foreground/45">
        <span style={{ color: LEAK_AMBER }}>restarts at zero</span>
        <span style={{ color: PERSIST_BLUE }}>builds on the last</span>
      </div>
    </div>
  )
}

const BENTO = [
  {
    Icon: BrainIcon,
    title: 'Persistent memory',
    body: "The cloud keeps what your agent learns: your codebase, your decisions, yesterday's plan. Next session it reads from the same memory instead of asking you to explain it all again.",
    vignette: <MemoryTimelineVignette />,
    span: 'lg:col-span-7',
  },
  {
    Icon: FileTextIcon,
    title: 'Files that stay put',
    body: 'Everything an agent writes lands in a real workspace and stays there. Come back tomorrow and the files it made are exactly where it left them, ready to build on.',
    vignette: <FilesVignette />,
    span: 'lg:col-span-5',
  },
  {
    Icon: LightningIcon,
    title: 'A place to run',
    body: 'Long jobs keep running after you close the tab. Schedule an overnight digest, kick off a build, leave an agent working. It picks back up with its memory still attached.',
    vignette: <RunVignette />,
    span: 'lg:col-span-5',
  },
  {
    Icon: StackIcon,
    title: 'Work that compounds',
    body: 'Because nothing resets, every session starts further ahead than the last. The amnesiac agent restarts at zero forever. Yours climbs.',
    vignette: <CompoundVignette />,
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
        <SectionHeader
          eyebrow="The fix"
          title="Give your agents a home in the cloud."
          intro={
            <>
              Memory, files, and a place to run, all in one workspace your agents connect to. Their
              work stops evaporating and starts compounding, session over session.
            </>
          }
        />
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
/* 3 · Live demo — watch an agent wake up already knowing              */
/* ------------------------------------------------------------------ */

const WAKE_MEMORY = ['pricing-v3.md', 'acme-quote.xlsx', 'decisions.md'] as const

/** The payoff, played live: the same prompt hits an amnesiac agent (left,
 * static, it asks you to start over) and a Duet-backed agent (right, it boots,
 * reads its memory files one by one, and answers already knowing). A staged
 * reveal keyed to scroll; the boot lines light up in sequence. */
function WakeUpDemo() {
  const reduce = useHydratedReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.5 })
  // How many memory files have been "read" so far (drives the boot sequence).
  const [read, setRead] = useState(0)
  const booted = read >= WAKE_MEMORY.length

  useEffect(() => {
    // Settled poster under reduced motion: fully booted, answer shown. Set in
    // the effect (not useState) because useHydratedReducedMotion is false on
    // first paint and only flips true after mount.
    if (reduce) {
      setRead(WAKE_MEMORY.length)
      return
    }
    if (!inView) return
    setRead(0)
    const id = setInterval(() => {
      setRead(r => {
        if (r >= WAKE_MEMORY.length) {
          clearInterval(id)
          return r
        }
        return r + 1
      })
    }, 620)
    return () => clearInterval(id)
  }, [inView, reduce])

  return (
    <div ref={ref} className="grid gap-4 md:grid-cols-2" aria-hidden="true">
      {/* Without a home: the amnesiac reply, muted, frozen */}
      <div className="flex flex-col rounded-2xl border border-foreground/10 bg-background/55 p-5 opacity-90">
        <span
          className="mb-3 inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{
            backgroundColor: 'color-mix(in srgb, hsl(28 80% 52%) 12%, transparent)',
            color: LEAK_AMBER,
          }}
        >
          <ArrowsClockwiseIcon weight="bold" className="size-3" />
          without a home
        </span>
        <p className="rounded-lg bg-foreground/[0.05] px-3 py-2 text-xs text-foreground/70">
          &ldquo;Let&rsquo;s finish the Acme pricing.&rdquo;
        </p>
        <p className="mt-2 rounded-lg border border-dashed border-foreground/15 px-3 py-2 text-xs italic text-foreground/55">
          &ldquo;I don&rsquo;t have any context on that yet. Can you paste the pricing details and
          remind me what we decided?&rdquo;
        </p>
        <p className="mt-auto pt-3 text-[11px] text-foreground/45">Ten minutes gone, again.</p>
      </div>

      {/* With Duet: the agent boots, reads memory, answers already knowing */}
      <div
        className="flex flex-col rounded-2xl border bg-background/70 p-5 shadow-sm"
        style={{
          borderColor: 'color-mix(in srgb, hsl(214 70% 56%) 30%, transparent)',
        }}
      >
        <span className="mb-3 inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold text-foreground/80">
          <LiveDot pulse={!reduce} />
          with a home on Duet
        </span>
        <p className="rounded-lg bg-foreground/[0.05] px-3 py-2 text-xs text-foreground/70">
          &ldquo;Let&rsquo;s finish the Acme pricing.&rdquo;
        </p>
        {/* boot: memory files read one by one */}
        <div className="mt-2 space-y-1">
          {WAKE_MEMORY.map((file, i) => {
            const shown = i < read
            return (
              <div
                key={file}
                className={cn(
                  'flex items-center gap-1.5 font-mono text-[11px] transition-opacity duration-300',
                  shown ? 'opacity-100' : 'opacity-25',
                )}
              >
                <CheckIcon
                  weight="bold"
                  className="size-2.5"
                  style={{ color: shown ? PERSIST_BLUE : 'currentColor' }}
                />
                <span className="text-foreground/60">recalled {file}</span>
              </div>
            )
          })}
        </div>
        {/* the answer, once memory is loaded */}
        <AnimatePresence>
          {booted && (
            <motion.p
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.2, ease: 'easeOut' }}
              className="mt-2 rounded-lg px-3 py-2 text-xs text-foreground/80"
              style={{
                backgroundColor: 'color-mix(in srgb, hsl(214 70% 56%) 10%, transparent)',
              }}
            >
              &ldquo;Picking up where we left off. Pricing v3 is ready and the Acme quote is
              drafted. I&rsquo;ll finalize the enterprise tier and send it over.&rdquo;
            </motion.p>
          )}
        </AnimatePresence>
        <p className="mt-auto pt-3 text-[11px] text-foreground/50">
          Zero re-explaining. It already knew.
        </p>
      </div>
    </div>
  )
}

export function WakeUpSection() {
  return (
    <section className="relative bg-lv2-band-warm">
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <SectionHeader
          eyebrow="Live demo"
          title="Watch an agent wake up already knowing."
          intro={
            <>
              Same prompt, two agents. One asks you to start over. The one with a home on Duet reads
              its memory and picks up exactly where it left off. That is the whole difference:
              continuity.
            </>
          }
        />
        <SectionReveal className="mt-14" amount={0.3}>
          <RevealItem>
            <WakeUpDemo />
          </RevealItem>
        </SectionReveal>
      </div>
    </section>
  )
}
