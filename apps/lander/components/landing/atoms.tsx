'use client'

import { animate, useInView, useReducedMotion } from 'framer-motion'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

/**
 * Small shared atoms of the landing design grammar: hairline rules instead of
 * boxes, and a single rationed brand blue (`hsl(214 65% 56%)`) that is only
 * ever allowed to mean "live / earning / active" — never decoration. These
 * primitives are the carriers of that rule.
 */

/**
 * Reads the browser preference after mount and returns `false` beforehand, so
 * the first client render matches the server (which has no `matchMedia`). Use
 * this — never raw `useReducedMotion` — whenever the value
 * gates RENDER output or a motion `initial`/`animate` prop, to avoid hydration
 * mismatches for reduced-motion users. The page-level `MotionConfig
 * reducedMotion="user"` still strips the real transforms post-mount, so the
 * accessibility behavior is preserved; this only fixes first-paint parity.
 */
export function useHydratedReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const read = () => setReduce(query.matches)
    read()
    query.addEventListener('change', read)
    return () => query.removeEventListener('change', read)
  }, [])
  return reduce
}

/**
 * Tracks the html root's `.dark` class (next-themes) after mount; `false` on
 * the server so the first client render matches SSR output.
 */
export function useIsDark() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const root = document.documentElement
    const read = () => setDark(root.classList.contains('dark'))
    read()
    const o = new MutationObserver(read)
    o.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => o.disconnect()
  }, [])
  return dark
}

/** One answer per document: a browser that cannot hand out a GL context now
 * will not start during this page's life, and each probe costs a real context
 * out of the browser's small pool. */
let webglSupport: boolean | undefined

function detectWebgl(): boolean {
  if (webglSupport !== undefined) return webglSupport
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl')
    // Hand the context straight back — the probe only asked a question.
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    webglSupport = gl !== null
  } catch {
    webglSupport = false
  }
  return webglSupport
}

/**
 * Whether this client can actually run the WebGL scenes, read after mount and
 * `false` beforehand so the first client render matches SSR. Gate RENDER on
 * this — do not let a three.js or shader component mount and find out for
 * itself, because the way it finds out is by throwing, and a throw inside a
 * decorative background unmounts the whole page for a scraper, an agent's
 * headless browser, or anyone whose GPU process has died.
 *
 * Deliberately a passive effect rather than a layout effect: creating the probe
 * context is real GPU work, and blocking first paint on it would buy nothing —
 * the server already renders the no-WebGL branch, so that frame is painted
 * either way.
 */
export function useHasWebgl(): boolean {
  const [supported, setSupported] = useState(false)
  useEffect(() => setSupported(detectWebgl()), [])
  return supported
}

/**
 * The rationed brand-blue "live" dot. This is the one place brand blue is
 * allowed to appear at rest — it marks an agent that is actually running.
 * `lv2-halo-pulse` lives under `.landing-v2` (added by `LandingChrome`), so the
 * dot must render inside a landing surface.
 */
export function LiveDot({ className, pulse = true }: { className?: string; pulse?: boolean }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden="true">
      {pulse ? (
        <span className="lv2-halo-pulse absolute inset-[-5px] rounded-full bg-[radial-gradient(circle,hsl(214_70%_56%/0.6),transparent_70%)]" />
      ) : null}
      <span className="relative size-2 rounded-full bg-[hsl(214_65%_56%)] shadow-[0_0_8px_hsl(214_70%_56%/0.7)]" />
    </span>
  )
}

/** Uppercase kicker over a section headline — the one eyebrow style shared
 * across all three pages so the family reads as one system. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'text-[11px] font-semibold uppercase tracking-[0.22em] text-foreground/65',
        className,
      )}
    >
      {children}
    </p>
  )
}

/**
 * Odometer figure that animates from `from` to `to` exactly once, the first
 * time it scrolls into view. Used for the receipt "before → after" rolls.
 * Honors `prefers-reduced-motion` by snapping straight to the final value.
 */
export function CountUp({
  to,
  from = 0,
  durationMs = 1300,
  delayMs = 0,
  format = v => Math.round(v).toLocaleString('en-US'),
  className,
}: {
  to: number
  from?: number
  durationMs?: number
  delayMs?: number
  format?: (v: number) => string
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: '-12%' })
  const reduce = useReducedMotion()
  const [val, setVal] = useState(from)

  useEffect(() => {
    if (!inView) return
    if (reduce) {
      setVal(to)
      return
    }
    const controls = animate(from, to, {
      duration: durationMs / 1000,
      delay: delayMs / 1000,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: setVal,
    })
    return () => controls.stop()
  }, [inView, reduce, from, to, durationMs, delayMs])

  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      {format(val)}
    </span>
  )
}
