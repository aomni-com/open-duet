import { type CSSProperties } from 'react'

import { cn } from '@repo/ui/lib/utils'

/**
 * Film-grain veil — the same inline feTurbulence data-URI convention as
 * ambient-background.tsx, so the porcelain reads as a developed print rather
 * than a backlit screen. Zero network, zero JS, paints on the first frame, so
 * it's the safest possible texture over any hero (and doubles as the frame-1
 * poster substrate under heavier backdrops). The color matrix bakes a neutral
 * blue-ink tint (0.08 0.12 0.20) so the grain darkens *into* the paper.
 */
const GRAIN_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='hg'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.08 0 0 0 0 0.12 0 0 0 0 0.20 0 0 0 0.5 0'/></filter><rect width='100%' height='100%' filter='url(%23hg)'/></svg>`

export const GRAIN_URL = `url("data:image/svg+xml;utf8,${GRAIN_SVG}")`

/**
 * A full-bleed grain layer. Multiply in light mode (tint sits *inside* the
 * paper), screen in dark mode (a faint lift instead of a smear). Defaults are
 * tuned to be felt, not seen.
 */
export function GrainVeil({
  opacity = 0.045,
  className,
  style,
}: {
  opacity?: number
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-0 mix-blend-multiply dark:mix-blend-screen',
        className,
      )}
      style={{
        backgroundImage: GRAIN_URL,
        backgroundRepeat: 'repeat',
        backgroundSize: '300px 300px',
        opacity,
        ...style,
      }}
    />
  )
}
