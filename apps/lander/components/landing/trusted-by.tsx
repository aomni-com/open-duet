'use client'

import { type CSSProperties, useEffect, useRef } from 'react'

import { serifStyle } from '@/components/landing/landing-styles'

/**
 * Social-proof strip that sits directly under the hero — a depth-of-field
 * "logo cloud" rather than a static grid.
 *
 * Three parallax lanes drift right → left at different speeds. Depth is real
 * and layered from several cues that all move together:
 *   • size + opacity + blur + speed — nearer = bigger, crisper, brighter, faster.
 *   • atmospheric haze — the far lane is tinted slightly cool, the way distance
 *     desaturates real scenes.
 *   • a soft drop-shadow on the front lane so it lifts off the plane.
 *   • a gentle vertical float so the whole field feels suspended in a volume.
 *   • SCROLL PARALLAX — as the page scrolls, each lane shifts vertically by its
 *     depth (front lanes travel a touch more than far ones). Very subtle; it
 *     just adds a sense of the layers sitting at different distances. Driven by
 *     a single `--tb-scroll` (-1..1) the section publishes on scroll.
 * The lanes overlap vertically so a big front logo passes in front of a faint
 * back one — the scene reads as logos floating at different distances.
 *
 * Logos are painted with `mask-image` + `currentColor`, so every mark is a
 * single ink that adapts to light/dark; depth tints it via the lane's color.
 * The field is clipped by an edge gradient mask so logos dissolve in on the
 * left and out on the right.
 *
 * Implementation note on the seamless loop: each lane holds two identical
 * groups; every cell carries a trailing margin (no flex `gap`), so a group's
 * width is an exact `n × (logo + gap)`. Translating the lane by -50% lands the
 * second group precisely where the first began — no seam, no jump. The scroll
 * shift and the float live on separate wrapper/child elements so they never
 * fight the marquee's own transform.
 */

type Logo = {
  /** File in /public/landing/brands. */
  file: string
  /** Display name, used for the alt/title. */
  name: string
  /** Trimmed aspect ratio (content bbox w / h) — width is derived from lane
   *  height so every logo's *box* is the same height per lane. */
  aspect: number
  /**
   * Optical-size nudge (0–1) applied via `mask-size` so the artwork fills only
   * this fraction of the (uniform) box height. The box height stays constant —
   * this only balances marks that read heavier/lighter than the rest so the
   * set feels one size. 1 = fills the box. Defaults to 1.
   */
  scale?: number
}

// Aspects are the measured *content* bounding boxes (see the bbox calibration),
// so trailing whitespace never makes a logo render small. `scale` pulls the
// visually heaviest marks down a touch toward a common optical height.
const LOGOS: Logo[] = [
  { file: 'stravito.svg', name: 'Stravito', aspect: 5.22, scale: 0.9 },
  { file: 'panzura.svg', name: 'Panzura', aspect: 5.39, scale: 0.84 },
  { file: 'semperis.svg', name: 'Semperis', aspect: 4.82, scale: 0.9 },
  { file: 'social-plus.svg', name: 'Social+', aspect: 5.78, scale: 0.9 },
  // Mint is a heavy all-caps mark; it needs the deepest cut to sit level.
  { file: 'mint.svg', name: 'Mint', aspect: 7.48, scale: 0.56 },
  { file: 'furiosa.svg', name: 'Furiosa', aspect: 3.8, scale: 0.78 },
  { file: 'parallax.svg', name: 'Parallax', aspect: 4.1, scale: 1 },
  // Stacked two-line mark — left at full box height; it reads a touch smaller
  // by nature, which is fine.
  { file: 'boots-n-bubbles.svg', name: 'Boots & Bubbles', aspect: 2.06, scale: 1 },
]

/** Rotate the logo order so each lane shows a different sequence. */
function rotate<T>(arr: T[], by: number): T[] {
  const n = arr.length
  const k = ((by % n) + n) % n
  return [...arr.slice(k), ...arr.slice(0, k)]
}

// Small deterministic vertical jitter (no Math.random → no hydration drift) so
// logos inside a lane don't sit on one perfect baseline, adding to the organic,
// floating feel. Kept modest so it never clips against the field edges once the
// float and scroll shift are added on top.
const JITTER = [-5, 4, -2, 5, -4, 2, -6, 4, -2, 3]

type Lane = {
  /** Logo order for this lane. */
  logos: Logo[]
  /** Lane height in px → drives logo size (depth). */
  h: number
  /** Top offset within the field, in px (lanes overlap). */
  top: number
  /** Stacking — higher = nearer the viewer. */
  z: number
  /** Loop duration in seconds (shorter = faster = nearer). */
  dur: number
  /** Opacity for the whole lane. */
  opacity: number
  /** Backdrop blur in px (depth-of-field). 0 = crisp. */
  blur: number
  /** Ink color token for this depth. */
  color: string
  /** Gap between logos, in px. */
  gap: number
  /** Scroll-parallax travel in px — nearer lanes move a touch more. */
  par: number
  /** Vertical float amplitude in px. */
  famp: number
  /** Float cycle duration in seconds. */
  fdur: number
  /** Float phase offset in seconds (desyncs the lanes). */
  fdelay: number
  /** Nearest lane — gets the lift shadow instead of blur. */
  front?: boolean
}

// Back → front. Every cue scales with depth so the illusion stays consistent.
const LANES: Lane[] = [
  {
    logos: rotate(LOGOS, 0),
    h: 18,
    top: 10,
    z: 1,
    dur: 92,
    opacity: 0.5,
    blur: 1.2,
    // Atmospheric haze — nudged cool/blue so the far lane reads as distance.
    color: 'color-mix(in srgb, var(--lv2-line-strong) 80%, var(--lv2-accent) 20%)',
    gap: 52,
    par: 4,
    famp: 2,
    fdur: 9,
    fdelay: 0,
  },
  {
    logos: rotate(LOGOS, 3),
    h: 26,
    top: 50,
    z: 2,
    dur: 66,
    opacity: 0.82,
    blur: 0.3,
    color: 'var(--lv2-muted)',
    gap: 62,
    par: 8,
    famp: 3,
    fdur: 7.5,
    fdelay: -2,
  },
  {
    logos: rotate(LOGOS, 6),
    h: 35,
    top: 92,
    z: 3,
    dur: 48,
    opacity: 1,
    blur: 0,
    color: 'var(--lv2-fg-soft)',
    gap: 76,
    par: 13,
    famp: 3,
    fdur: 6.5,
    fdelay: -4,
    front: true,
  },
]

function LogoCell({ logo, jitter }: { logo: Logo; jitter: number }) {
  const url = `/landing/brands/${logo.file}`
  return (
    <span className="tb-cell" style={{ marginTop: jitter }}>
      <span
        className="lv2-ink-mask tb-logo"
        role="img"
        aria-label={logo.name}
        title={logo.name}
        style={
          {
            // Uniform box height per lane; width tracks the logo's aspect so
            // spacing reflects each mark's real footprint.
            width: `calc(var(--tb-h) * ${logo.aspect})`,
            // Optical nudge: shrink the heavier marks within their (fixed) box
            // so the set reads as one size. Transform keeps the layout box, so
            // row heights stay uniform.
            transform: logo.scale ? `scale(${logo.scale})` : undefined,
            WebkitMaskImage: `url(${url})`,
            maskImage: `url(${url})`,
          } as CSSProperties
        }
      />
    </span>
  )
}

function LaneGroup({ lane, ariaHidden }: { lane: Lane; ariaHidden?: boolean }) {
  return (
    <div className="tb-group" aria-hidden={ariaHidden}>
      {lane.logos.map((logo, i) => (
        <LogoCell key={`${logo.file}-${i}`} logo={logo} jitter={JITTER[i % JITTER.length]!} />
      ))}
    </div>
  )
}

type TrustedByCopy = {
  lead: string
  count: string
  trail: string
}

/** Every lander shows the same heading today; pass `copy` only to diverge. */
const DEFAULT_COPY: TrustedByCopy = {
  lead: 'Trusted by teams at',
  count: 'growing',
  trail: 'companies',
}

export function TrustedBy({
  copy = DEFAULT_COPY,
  headingClassName,
}: {
  copy?: TrustedByCopy
  headingClassName?: string
}) {
  const fieldRef = useRef<HTMLDivElement>(null)

  // Scroll parallax: publish a single -1..1 progress as the section travels
  // through the viewport (0 when it's centred). Each lane reads it and shifts
  // vertically by its own `--tb-par`, so nearer lanes move a little more —
  // subtle depth. rAF-throttled, passive, and skipped under reduced motion.
  useEffect(() => {
    const el = fieldRef.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let raf = 0
    const update = () => {
      raf = 0
      const r = el.getBoundingClientRect()
      const vh = window.innerHeight || 1
      const center = r.top + r.height / 2
      const p = Math.max(-1, Math.min(1, (center - vh / 2) / (vh / 2 + r.height / 2)))
      el.style.setProperty('--tb-scroll', p.toFixed(3))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const resolvedHeadingClassName =
    headingClassName ??
    'text-lv2-fg-soft text-center text-[clamp(1.5rem,3.4vw,2.25rem)] font-normal leading-tight tracking-[-0.02em]'

  return (
    <section
      className="lv2-paper relative z-10 overflow-hidden px-6 py-20 sm:py-24"
      aria-labelledby="trusted-by-heading"
    >
      <div className="mx-auto max-w-7xl">
        <h2 id="trusted-by-heading" className={resolvedHeadingClassName} style={serifStyle}>
          {copy.lead} <span className="text-lv2-accent font-medium">{copy.count}</span> {copy.trail}
        </h2>
      </div>

      {/* The depth field. `overflow: hidden` clips the lanes; the edge gradient
          mask dissolves logos as they enter (left) and exit (right). */}
      <div ref={fieldRef} className="tb-field mx-auto mt-12 max-w-[1600px]">
        {LANES.map((lane, i) => (
          <div
            key={i}
            className="tb-lane-wrap"
            style={
              {
                // Scaled with the field so the lanes stay proportionally
                // stacked as the cloud shrinks on narrow screens.
                top: `calc(${lane.top}px * var(--tb-scale, 1))`,
                zIndex: lane.z,
                opacity: lane.opacity,
                '--tb-par': lane.par,
              } as CSSProperties
            }
          >
            <div
              className={lane.front ? 'tb-lane tb-front' : 'tb-lane'}
              style={
                {
                  color: lane.color,
                  filter: lane.blur ? `blur(${lane.blur}px)` : undefined,
                  // `--tb-h` drives both the logo height (CSS) and its width
                  // (`--tb-h * aspect`, below), so scaling it here keeps every
                  // mark's aspect intact while shrinking the set. `--tb-gap`
                  // scales with it so spacing stays proportional.
                  '--tb-h': `calc(${lane.h}px * var(--tb-scale, 1))`,
                  '--tb-gap': `calc(${lane.gap}px * var(--tb-scale, 1))`,
                  '--tb-dur': `${lane.dur}s`,
                  '--tb-famp': `${lane.famp}px`,
                  '--tb-fdur': `${lane.fdur}s`,
                  '--tb-fdelay': `${lane.fdelay}s`,
                } as CSSProperties
              }
            >
              <LaneGroup lane={lane} />
              <LaneGroup lane={lane} ariaHidden />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
