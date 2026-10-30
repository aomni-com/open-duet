/* ============================================================================
   How two nodes are joined. Pure: positions in, a path `d` out.

   Trunks and limbs leave one rim and stop at the next rather than running
   centre to centre — twelve lines converging on the middle of the core made a
   bright knot there, and every limb was drawn straight through the disc it
   started from. `rim()` in metrics.ts owns how far out that is, derived from
   the same box the camera frames with.
   ========================================================================= */
import { px as p, rim, type Density } from './metrics'
import type { MapNode, Vec } from './types'

export function routeEdge(from: Vec, to: Vec, fromNode: MapNode, toNode: MapNode, ctx: Density) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const d = Math.hypot(dx, dy) || 1
  const a = rim(fromNode, dy / d, ctx)
  const b = rim(toNode, -dy / d, ctx)
  return (
    `M${p(from.x + (dx / d) * a)} ${p(from.y + (dy / d) * a)} ` +
    `L${p(to.x - (dx / d) * b)} ${p(to.y - (dy / d) * b)}`
  )
}
