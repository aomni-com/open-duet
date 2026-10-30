/* Box arithmetic, in one place.

   Translating a node's local box by its position, taking the union of a set of
   them, and measuring how much two overlap were each written out three times —
   once in the layout, once in the camera, once in the placer — which is how the
   placer and the test that checks it ended up disagreeing about whether two
   exactly-touching boxes count as a collision. They do not: overlap is area, and
   touching is zero area. */
import type { Box, Vec } from './types'

/** A local box, moved to where the node actually stands. */
export function at(box: Box, p: Vec): Box {
  return { x0: p.x + box.x0, y0: p.y + box.y0, x1: p.x + box.x1, y1: p.y + box.y1 }
}

export function union(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  }
}

export function unionAll(boxes: readonly Box[]): Box | null {
  let out: Box | null = null
  for (const b of boxes) out = out ? union(out, b) : b
  return out
}

/**
 * Whether two boxes are the same box.
 *
 * Sub-pixel differences are the same box, because these are compared to decide
 * whether the camera has anything to re-solve and the alternative is a camera
 * that re-aims on floating-point noise. Half a world unit is a fraction of a
 * hairline at every scale the map reaches.
 */
export function same(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x0 - b.x0) < 0.5 &&
    Math.abs(a.y0 - b.y0) < 0.5 &&
    Math.abs(a.x1 - b.x1) < 0.5 &&
    Math.abs(a.y1 - b.y1) < 0.5
  )
}

/** Area of the intersection. Touching edges are zero, not a collision. */
export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return w > 0 && h > 0 ? w * h : 0
}

export function width(b: Box): number {
  return b.x1 - b.x0
}

export function height(b: Box): number {
  return b.y1 - b.y0
}

export function centre(b: Box): Vec {
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }
}
