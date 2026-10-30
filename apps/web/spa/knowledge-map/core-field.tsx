'use client'

/* ============================================================================
   The knowledge core: a point cloud on a sphere, spun slowly and projected
   flat. Depth drives radius and opacity, so it reads as a real volume without a
   3D library — and because it lives inside the same <g> as everything else, the
   camera carries it for free.

   No pulsing. It just turns, the way something with mass does.

   A fifteenth of the points are warm, and they cycle through the four kinds,
   because that is what the core is: everything the agents know, before
   it was sorted into any of them.

   ---- why this draws into ten paths and not two hundred circles ----
   One <circle> per point meant four setAttribute calls each, every frame: 920
   DOM writes at 60 Hz, about 35,000 a second, to spin a decorative cloud. It
   was by a wide margin the most expensive thing on the map, and it ran forever
   whether or not anything else was happening.

   Depth only has to be *believable*, not continuous, so the points are bucketed
   into a few depth tiers and each tier is drawn as a single path of circular
   subpaths at one opacity and one radius. Ten `d` writes a frame instead of
   nine hundred, and at this scale the banding is invisible.

   ---- and it stops when nobody is looking ----
   Ten writes a frame is still ten writes a frame forever, on what is now the
   signed-in landing page: a tab left open all afternoon rebuilds thirteen
   kilobytes of path string sixty times a second to turn a decoration. So the
   loop runs only while the cloud is actually on screen and the tab is actually
   in front, and it recomputes on a cadence rather than on every frame — the
   sphere turns about six degrees a second, so a step is a fifth of a degree
   either way and half the work.

   The still frame is drawn unconditionally, before any of that. A core that is
   only ever painted by the animation loop is a blank core in every state that
   has no loop, and "blank" is not a state this is allowed to have.
   ========================================================================= */
import { useEffect, useMemo, useRef } from 'react'

import { usePrefersReducedMotion } from '@repo/ui/hooks/use-prefers-reduced-motion'

import { KIND_ORDER } from './kinds'
import type { KindKey } from './types'

const COUNT = 230
const RADIUS = 84
const WARM_EVERY = 15
/** depth buckets for the neutral cloud; more than this is invisible banding */
const TIERS = 6
/** how often the projection is rebuilt; the sphere turns 6°/s, so this is 0.2° */
const PROJECT_MS = 32

type Point = { x: number; y: number; z: number; shell: number; warm: KindKey | null }

/** Fibonacci sphere: an even scatter with no clumping at the poles. */
function sphere(): Point[] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  return Array.from({ length: COUNT }, (_, i) => {
    const y = 1 - (i / (COUNT - 1)) * 2
    const ring = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    const warm = i % WARM_EVERY === 0
    return {
      x: Math.cos(theta) * ring,
      y,
      z: Math.sin(theta) * ring,
      /* each sits at its own depth in the shell, so it is not a hollow ball */
      shell: 0.55 + (((i * 37) % 100) / 100) * 0.45,
      warm: warm ? (KIND_ORDER[Math.floor(i / WARM_EVERY) % KIND_ORDER.length] ?? null) : null,
    }
  })
}

/** depth 0 (back) … 1 (front) */
const opacityAt = (depth: number): number => 0.07 + depth * 0.78
const radiusAt = (depth: number): number => 0.9 + depth * 2.1

/** A dot, as a closed subpath, so many of them can share one `d`. */
function dot(x: number, y: number, r: number): string {
  return `M${x.toFixed(1)} ${y.toFixed(1)}m${-r} 0a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`
}

/* The cloud reads the motion preference itself rather than being handed it. As a
   prop it sat in the memo key of every node on the map, so an OS setting change
   invalidated sixty subtrees to stop one decoration turning. */
export function CoreField() {
  const reduced = usePrefersReducedMotion()
  const points = useMemo(sphere, [])
  const field = useRef<SVGGElement | null>(null)
  const neutral = useRef<(SVGPathElement | null)[]>([])
  const warm = useRef<Record<string, SVGPathElement | null>>({})

  useEffect(() => {
    const project = (t: number): void => {
      const ay = t * 0.00011
      const ax = Math.sin(t * 0.00007) * 0.34
      const ca = Math.cos(ay)
      const sa = Math.sin(ay)
      const cb = Math.cos(ax)
      const sb = Math.sin(ax)

      const tiers: string[] = Array.from({ length: TIERS }, () => '')
      const kinds: Record<string, string> = {}
      for (const key of KIND_ORDER) kinds[key] = ''

      for (const p of points) {
        const s = p.shell * RADIUS
        /* spin about Y, then tilt about X */
        const x1 = p.x * ca + p.z * sa
        const z1 = -p.x * sa + p.z * ca
        const y1 = p.y * cb - z1 * sb
        const z2 = p.y * sb + z1 * cb
        const depth = (z2 + 1) / 2

        if (p.warm) {
          kinds[p.warm] += dot(x1 * s, y1 * s, Number(radiusAt(depth).toFixed(2)))
          continue
        }
        const tier = Math.min(TIERS - 1, Math.floor(depth * TIERS))
        tiers[tier] += dot(x1 * s, y1 * s, Number(radiusAt((tier + 0.5) / TIERS).toFixed(2)))
      }

      for (let i = 0; i < TIERS; i++) neutral.current[i]?.setAttribute('d', tiers[i] ?? '')
      for (const key of KIND_ORDER) warm.current[key]?.setAttribute('d', kinds[key] ?? '')
    }

    /* The still frame, before anything decides whether to animate. The old
       version called its frame function once to "draw a static frame", but that
       function scheduled its own successor — so the opt-out started exactly the
       loop it was avoiding. */
    project(0)
    if (reduced) return

    /* Timed from mount rather than from navigation, so the first animated frame
       continues the still one instead of jumping to wherever the page's clock
       had got to. */
    const origin = performance.now()
    let raf = 0
    let drawn = -PROJECT_MS
    let onScreen = true

    const step = (now: number): void => {
      raf = requestAnimationFrame(step)
      if (now - drawn < PROJECT_MS) return
      drawn = now
      project(now - origin)
    }

    /* Two independent reasons to stop, one place that acts on them: nobody can
       see the cloud, or nobody is looking at the tab. */
    const sync = (): void => {
      const wanted = onScreen && document.visibilityState !== 'hidden'
      const running = raf !== 0
      if (wanted === running) return
      if (wanted) {
        raf = requestAnimationFrame(step)
        return
      }
      cancelAnimationFrame(raf)
      raf = 0
    }

    /* Zooming into an agent carries the camera off the centre, which is the
       common way this ends up off screen — and the cheap way to notice is to be told. */
    const observer =
      field.current && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(entries => {
            onScreen = entries.some(entry => entry.isIntersecting)
            sync()
          })
        : null
    if (observer && field.current) observer.observe(field.current)

    document.addEventListener('visibilitychange', sync)
    sync()
    return () => {
      cancelAnimationFrame(raf)
      observer?.disconnect()
      document.removeEventListener('visibilitychange', sync)
    }
  }, [points, reduced])

  return (
    <g ref={field} className="km-core-field" aria-hidden>
      {Array.from({ length: TIERS }, (_, i) => (
        <path
          key={`tier-${i}`}
          ref={el => {
            neutral.current[i] = el
          }}
          className="km-kn"
          opacity={opacityAt((i + 0.5) / TIERS).toFixed(3)}
        />
      ))}
      {KIND_ORDER.map(key => (
        <path
          key={key}
          ref={el => {
            warm.current[key] = el
          }}
          className="km-kn"
          data-kind={key}
          opacity={0.72}
        />
      ))}
    </g>
  )
}
