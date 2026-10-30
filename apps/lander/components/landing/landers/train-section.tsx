'use client'

import { AnimatePresence } from 'framer-motion'
import dynamic from 'next/dynamic'
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { useHasWebgl, useHydratedReducedMotion } from '@/components/landing/atoms'
import { GrainVeil } from '@/components/landing/grain-veil'
import type { ChipAnchor } from '@/components/landing/landers/train-bloom'
import { FacetPanel, facetAccent, facetIcon } from '@/components/landing/landers/train-facets'
import { serifStyle } from '@/components/landing/landing-styles'
import { RevealItem, SectionReveal } from '@/components/landing/section-reveal'
import { SubtleBackdrop } from '@/components/landing/subtle-backdrop'
import type { AppLocale } from '@/lib/i18n/locales'

/**
 * "Train your agent" — the one shared beat that runs on the main lander and
 * on the bespoke `/l/` landers (platform, agent-cloud, file-sharing). It
 * carries a single, instantly-legible promise: everyone rents
 * the same generic model; you train yours until it works like it's part of the
 * team.
 *
 * The centrepiece is a WebGL bloom (see train-bloom.tsx) that *performs* the
 * value prop rather than decorating it: a formless grey particle cloud (raw,
 * generic model) is fed six streams of your context — the surrounding chips are the
 * sources — that pull the chaos into a crisp, organised mind which ignites
 * brand-blue when trained. The bloom owns the single `progress` timeline; this
 * component reads it back to light the chips in sequence and flip the reply from
 * a hedging generic template to one that plainly knows your world, so the 3D and
 * the DOM tell one synchronised story. Reduced motion gets a settled poster,
 * and anyone the bloom can't serve — a phone, a client with no WebGL — gets the
 * switcher, which tells the same story in plain DOM.
 *
 * Copy is passed per-lander so the frame reads identically across the family
 * while each page speaks its own language in the trained reply.
 */

/** Lazy + client-only: keeps three out of SSR and off the initial bundle. */
const TrainBloom = dynamic(
  () => import('@/components/landing/landers/train-bloom').then(m => m.TrainBloom),
  { ssr: false },
)

/** Default feed chips: what you point the agent at to make it yours. Order
 * matches the bloom's ring sources: 0 top-left, 1 top-right, 2 mid-left,
 * 3 mid-right, 4 bottom-left, 5 bottom-right. */
const DEFAULT_FEED = [
  'your files',
  'your tone',
  'your tools',
  'your data',
  'your memory',
  'your workflows',
] as const

/** progress thresholds at which each chip's stream has landed. */
const CHIP_LIT_AT = [0.22, 0.32, 0.42, 0.52, 0.62, 0.72] as const
const TRAINED_AT = 0.9

/** Auto-tour cadence: once trained, the panel walks through the six sources on
 * its own so the story plays without a click. Clicking latches one until you
 * click it again to release. Paced so each source gets room to be read. */
const TOUR_INTERVAL_MS = 5200
const TOUR_START_DELAY_MS = 1900
/** Tour beats: the six sources, looped. */
const TOUR_BEATS = 6

/** Where each chip starts (parked around the mind) before its stream docks it
 * onto the orbiting formation. Matches the bloom's ring order. */
const CORNER_START = [
  { left: '9%', top: '13%' },
  { left: '91%', top: '13%' },
  { left: '4%', top: '50%' },
  { left: '96%', top: '50%' },
  { left: '9%', top: '87%' },
  { left: '91%', top: '87%' },
] as const

/** Fallback for the facet reveal: what each source actually adds, resolved by
 * keyword so any per-lander feed gets a sensible line without extra copy. */
function facetNote(label: string): string {
  const l = label.toLowerCase()
  if (l.includes('file') || l.includes('doc'))
    return 'Reads straight from your docs, the Acme thread, the pricing deck, instead of starting from a blank page.'
  if (l.includes('tone') || l.includes('voice') || l.includes('style'))
    return 'Writes the way you write: your phrasing and rhythm, none of the corporate filler.'
  if (l.includes('tool') || l.includes('stack') || l.includes('api'))
    return 'Knows the tools you live in, so its answer lands where the work already happens.'
  if (l.includes('memory') || l.includes('remember') || l.includes('recall'))
    return 'Remembers your past sessions and decisions, so it picks up where you left off instead of starting cold.'
  if (
    l.includes('workflow') ||
    l.includes('playbook') ||
    l.includes('process') ||
    l.includes('steps')
  )
    return 'Learns the plays you run and walks them end to end, so the repeatable work just happens.'
  if (l.includes('data') || l.includes('context'))
    return 'Reaches into your live data for real specifics, not a hedged, generic guess.'
  return 'Becomes part of how your agent thinks, so its answers fit your world.'
}

export type TrainSectionCopy = {
  eyebrow: string
  title: ReactNode
  intro: ReactNode
  /** What the agent is trained on; defaults to the generic six. */
  feed?: readonly string[]
  /** Per-source line revealed when a source is active; defaults by keyword. */
  facetNotes?: readonly string[]
  /** Optional background band class to alternate with neighbouring sections. */
  band?: string
  /** The language the demo's scenes speak; the feed and notes come in it too. */
  locale?: AppLocale
}

function TrainGlobe({
  feed = DEFAULT_FEED,
  facetNotes,
  locale,
}: {
  feed?: readonly string[]
  facetNotes?: readonly string[]
  locale?: AppLocale
}) {
  const reduce = useHydratedReducedMotion()
  const [lit, setLit] = useState(0)
  const [trained, setTrained] = useState(false)
  // Start already showing the first source, then loop the six.
  const [active, setActive] = useState(0)
  // A clicked source latches: the globe keeps its own free spin, and that
  // source stays "selected" (paused tour) until you click it again.
  const [selected, setSelected] = useState(false)
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([])
  // Read imperatively inside the per-frame handlers + handed to the bloom.
  // activeRef drives the DOM chip's highlight + which channel colours the globe.
  const activeRef = useRef<number | null>(0)
  const selectedRef = useRef(false)
  // Per-chip eased highlight amount (0..1), so a badge grows/brightens smoothly
  // when it becomes active instead of snapping. Written each frame in anchors.
  const chipAmt = useRef([1, 0, 0, 0, 0, 0])
  // Begin the loop on the next source so the opening facet holds a beat first.
  const tourIdx = useRef(1)
  const tourStarted = useRef(false)

  const feedItems = feed.slice(0, 6)

  // Point the highlight at a source. The globe never whips — it just recolours.
  const setActiveFacet = useCallback((i: number) => {
    activeRef.current = i
    setActive(i)
  }, [])

  // Click latches a source (pauses the tour on it); clicking it again resumes.
  const handleSelect = useCallback(
    (i: number) => {
      setSelected(wasSelected => {
        const sameChip = activeRef.current === i
        if (wasSelected && sameChip) {
          // Release: keep this facet on screen and let the tour resume from it.
          return false
        }
        setActiveFacet(i)
        return true
      })
    },
    [setActiveFacet],
  )

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  // Driven by the bloom's timeline so the DOM and 3D stay in lockstep. Guards
  // return the previous value so identical steps bail out of re-render.
  const handleProgress = useCallback((p: number) => {
    const nextLit = CHIP_LIT_AT.filter(t => p >= t).length
    setLit(prev => (prev === nextLit ? prev : nextLit))
    const nextTrained = p >= TRAINED_AT
    setTrained(prev => (prev === nextTrained ? prev : nextTrained))
  }, [])

  // The self-playing tour: once trained and idle (nothing clicked), step
  // through the six sources so the right panel changes on its own. It only
  // updates the highlight (never whips a chip forward), so the globe reads as a
  // calm rotation while the story tells itself.
  useEffect(() => {
    if (reduce || !trained || selected) return
    let interval: ReturnType<typeof setInterval> | undefined
    const advance = () => {
      setActiveFacet(tourIdx.current)
      tourIdx.current = (tourIdx.current + 1) % TOUR_BEATS
    }
    const start = setTimeout(
      () => {
        tourStarted.current = true
        advance()
        interval = setInterval(advance, TOUR_INTERVAL_MS)
      },
      tourStarted.current ? 500 : TOUR_START_DELAY_MS,
    )
    return () => {
      clearTimeout(start)
      if (interval) clearInterval(interval)
    }
  }, [reduce, trained, selected, setActiveFacet])

  // Imperative per-frame ride-along: the bloom hands us each chip's projected
  // orbit position and we write it straight to the DOM (no re-render), so the
  // labels travel off their corners, dock onto the mind, and circle it in 3D as
  // parts of the formation — shrinking + fading as the orbit carries them back.
  const handleAnchors = useCallback((anchors: ChipAnchor[]) => {
    const active = activeRef.current
    const amt = chipAmt.current
    for (let i = 0; i < anchors.length; i++) {
      const el = chipRefs.current[i]
      const a = anchors[i]
      if (!el || !a) continue
      const isActive = i === active
      // Ease this chip's highlight toward its target so becoming active grows +
      // lifts it smoothly (the badge animates), while the globe just spins on.
      const target = isActive ? 1 : 0
      const eased = (amt[i] ?? 0) + (target - (amt[i] ?? 0)) * 0.12
      amt[i] = eased
      const lift = eased * (selectedRef.current ? 0.28 : 0.18)
      const scale = a.scale * (1 + lift)
      el.style.left = `${a.x * 100}%`
      el.style.top = `${a.y * 100}%`
      el.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`
      // Front chips sit above the canvas; back chips sit BELOW it so the point
      // cloud paints over them (fake depth occlusion). Active lifts to the top.
      el.style.opacity = Math.max(a.opacity, eased).toFixed(3)
      el.style.zIndex = eased > 0.5 ? '30' : a.front ? '20' : '5'
    }
  }, [])

  // isolate: the panel out-stacks the orbiting chips WITHIN this section
  // only — without it the panel's z-index competes with the sticky nav
  // (also z-40) and paints over it once the section scrolls up.
  return (
    <div
      data-train-demo="globe"
      className="isolate mx-auto grid max-w-5xl items-center gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12"
    >
      {/* LEFT — the interactive globe. The context corners feed a cloud that
          organises + ignites; each source recolours the mind as it goes live. */}
      <div className="relative mx-auto aspect-[4/3] w-full max-w-lg sm:aspect-[16/10] lg:aspect-square lg:max-w-none">
        {/* Canvas is pointer-transparent so back chips (painted behind it for
            depth) still receive clicks — that's what lets you grab a source from
            behind the sphere. */}
        <TrainBloom
          onProgress={handleProgress}
          onAnchors={handleAnchors}
          activeRef={activeRef}
          className="pointer-events-none absolute inset-0 z-10 h-full w-full"
        />

        {/* The six context sources: parked around the mind, then flown onto the
            orbiting mind. Position/scale/opacity/z are written imperatively by
            handleAnchors; className carries only the lit/active styling.
            Click LATCHES: clicking a chip pauses the tour on it while the globe
            keeps rotating; clicking it again resumes the loop. */}
        {feedItems.map((chip, i) => {
          const isLit = i < lit
          const isActive = i === active
          const isSelected = isActive && selected
          const accent = facetAccent(chip)
          const ChipGlyph = facetIcon(chip)
          const start = CORNER_START[i] ?? CORNER_START[0]
          return (
            <button
              type="button"
              key={chip}
              ref={el => {
                chipRefs.current[i] = el
              }}
              onClick={() => handleSelect(i)}
              aria-pressed={isSelected}
              aria-label={`Explore what ${chip} adds`}
              className={cn(
                'pointer-events-auto absolute inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] font-medium backdrop-blur-sm transition-colors duration-500 will-change-transform focus:outline-none sm:text-[11px]',
                isActive
                  ? 'border-transparent text-foreground'
                  : isLit
                    ? 'border-transparent text-foreground/85'
                    : 'border-dashed border-foreground/20 text-foreground/45',
              )}
              style={{
                left: start.left,
                top: start.top,
                transform: 'translate(-50%, -50%)',
                backgroundColor:
                  isLit || isActive
                    ? `color-mix(in srgb, ${accent} ${isActive ? 22 : 15}%, transparent)`
                    : undefined,
                boxShadow: isActive
                  ? isSelected
                    ? `0 0 0 1.5px color-mix(in srgb, ${accent} 78%, transparent), 0 6px 22px -6px color-mix(in srgb, ${accent} 68%, transparent)`
                    : `0 0 0 1.5px color-mix(in srgb, ${accent} 48%, transparent)`
                  : undefined,
              }}
            >
              <ChipGlyph
                weight={isLit || isActive ? 'fill' : 'regular'}
                className="size-3 shrink-0 transition-colors duration-500"
                style={{
                  color: isLit || isActive ? accent : 'currentColor',
                }}
              />
              {chip}
            </button>
          )
        })}
      </div>

      {/* RIGHT — the reactive story: one swapping panel that walks each source's
          bespoke scene on its own. Click a source to latch it; click again to
          resume the loop. */}
      {/* Above the orbiting chips (max z-30): a chip's flight may cross this
          column, and it must pass behind the copy. Scoped by the grid's
          `isolate` so it never competes with the sticky nav. */}
      <div className="relative z-40 mx-auto w-full max-w-md lg:mx-0">
        <div className="relative min-h-[15rem]">
          <AnimatePresence mode="wait">
            <FacetPanel
              locale={locale}
              key={`facet-${active}`}
              label={feedItems[active] ?? ''}
              note={facetNotes?.[active] ?? facetNote(feedItems[active] ?? '')}
              reduce={reduce}
            />
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/** True at >= lg (1024px). Starts false so the SSR markup and first client
 * render match, then a layout effect corrects it before paint on desktop — so
 * the globe never flashes on desktop and the WebGL bloom never even mounts on
 * phones/tablets (its particle sim tanks mobile frame rates). */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false)
  useIsoLayoutEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return isDesktop
}

/** The centrepiece for everyone the globe can't serve — phones and tablets, and
 * any client with no WebGL: a light DOM switcher that carries the same story
 * without a canvas. The six sources are tappable pills that swap the bespoke
 * facet scene below; it also auto-tours so the beat still plays untouched.
 * Tapping a source latches it (tap again to resume the loop). */
function TrainSwitcher({
  feed = DEFAULT_FEED,
  facetNotes,
  locale,
}: {
  feed?: readonly string[]
  facetNotes?: readonly string[]
  locale?: AppLocale
}) {
  const reduce = useHydratedReducedMotion()
  const feedItems = feed.slice(0, 6)
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (reduce || paused) return
    const id = setInterval(() => {
      setActive(i => (i + 1) % feedItems.length)
    }, TOUR_INTERVAL_MS)
    return () => clearInterval(id)
  }, [reduce, paused, feedItems.length])

  const handleTap = useCallback(
    (i: number) => {
      // Tapping the already-latched source resumes the tour; any other tap
      // selects it and pauses.
      setPaused(wasPaused => !(i === active && wasPaused))
      setActive(i)
    },
    [active],
  )

  return (
    <div data-train-demo="switcher" className="mx-auto flex max-w-md flex-col gap-6">
      <div className="flex flex-wrap justify-center gap-2">
        {feedItems.map((chip, i) => {
          const isActive = i === active
          const accent = facetAccent(chip)
          const ChipGlyph = facetIcon(chip)
          return (
            <button
              type="button"
              key={chip}
              onClick={() => handleTap(i)}
              aria-pressed={isActive}
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-300 focus:outline-none',
                isActive
                  ? 'border-transparent text-foreground'
                  : 'border-foreground/15 text-foreground/60',
              )}
              style={{
                backgroundColor: isActive
                  ? `color-mix(in srgb, ${accent} 18%, transparent)`
                  : undefined,
                boxShadow: isActive
                  ? `0 0 0 1.5px color-mix(in srgb, ${accent} 55%, transparent)`
                  : undefined,
              }}
            >
              <ChipGlyph
                weight={isActive ? 'fill' : 'regular'}
                className="size-3.5 shrink-0"
                style={{ color: isActive ? accent : 'currentColor' }}
              />
              {chip}
            </button>
          )
        })}
      </div>
      <div className="relative min-h-[15rem]">
        <AnimatePresence mode="wait">
          <FacetPanel
            locale={locale}
            key={`facet-${active}`}
            label={feedItems[active] ?? ''}
            note={facetNotes?.[active] ?? facetNote(feedItems[active] ?? '')}
            reduce={reduce}
          />
        </AnimatePresence>
      </div>
    </div>
  )
}

/** Chooses the right centrepiece for the client: the WebGL globe on a desktop
 * that can actually give it a GL context, the light switcher everywhere else.
 * The switcher is not only the phone layout — it is also what a client without
 * WebGL is served, so the section keeps telling its story instead of letting
 * three.js throw and take the page down with it. */
function TrainDemo({
  feed,
  facetNotes,
  locale,
}: {
  feed?: readonly string[]
  facetNotes?: readonly string[]
  locale?: AppLocale
}) {
  const isDesktop = useIsDesktop()
  const hasWebgl = useHasWebgl()
  return isDesktop && hasWebgl ? (
    <TrainGlobe feed={feed} facetNotes={facetNotes} locale={locale} />
  ) : (
    <TrainSwitcher feed={feed} facetNotes={facetNotes} locale={locale} />
  )
}

export function TrainSection({
  eyebrow,
  title,
  intro,
  feed,
  facetNotes,
  band,
  locale,
}: TrainSectionCopy) {
  return (
    <section className={cn('relative overflow-hidden', band)}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <SubtleBackdrop />
        <GrainVeil opacity={0.025} />
      </div>
      <div className="relative mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <SectionReveal className="mx-auto max-w-3xl text-center">
          <RevealItem>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-foreground/65">
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
          <RevealItem>
            <p className="mx-auto mt-5 max-w-2xl text-balance text-base leading-relaxed text-foreground/70 sm:text-lg">
              {intro}
            </p>
          </RevealItem>
        </SectionReveal>
        <SectionReveal className="mt-12" amount={0.3}>
          <RevealItem>
            <TrainDemo feed={feed} facetNotes={facetNotes} locale={locale} />
          </RevealItem>
        </SectionReveal>
      </div>
    </section>
  )
}
