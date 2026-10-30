import { expect, test } from 'bun:test'

/* The one promise the camera makes: everything drawn is on screen, always.

   There is no pan and no zoom, so a reader who cannot see something has no way
   to go and look at it — a clipped map is simply a wrong map. And what clips
   first is never the discs: it is the captions, which is exactly why `size()`
   reserves room for them and why this test measures the same boxes the camera
   solves against rather than the node positions.

   Fleet sizes across aspect ratios, because the failure was a shape failure:
   the numbers were right on a square surface and wrong on a wide one.
*/
import { ROOT_AGENT_SCOPE } from '@repo/contract'

import { at, centre, height, same, unionAll, width } from './box'
import { build, CX, CY, viewport, type Viewport } from './layout'
import { size } from './metrics'
import type { Box, MapData, Scene, Vec } from './types'
import { CENTRED, fitScale } from './use-map-camera'
import { framedBox } from './use-map-motion'

function data(agents: number, apps = 4, jobs = 6): MapData {
  return {
    duet: {
      id: ROOT_AGENT_SCOPE,
      name: 'Walter Monecke’s Workspace',
      avatarKey: ROOT_AGENT_SCOPE,
      jobs: [],
      apps: [],
    },
    coreMeta: '12 agents · 40 apps',
    agents: Array.from({ length: agents }, (_, i) => ({
      id: `agent-${i}`,
      name: `agent-number-${i}`,
      avatarKey: `agent-${i}`,
      jobs: Array.from({ length: jobs }, (_, j) => ({
        id: `agent-${i}-job-${j}`,
        title: 'Q3 revenue reconciliation',
        when: 'now',
        state: 'running' as const,
        unread: false,
      })),
      apps: Array.from({ length: apps }, (_, j) => ({
        id: `agent-${i}-app-${j}`,
        title: `Some App ${j}`,
        when: 'now',
        state: 'connected' as const,
      })),
    })),
  }
}

/* The three shapes the brief names, in the map's own content box — the route
   pads the surface, so these are the numbers the observer really reports. */
const SURFACES = [
  ['1440×900 landscape', viewport(1408, 804)],
  ['900×900 square', viewport(868, 804)],
  ['500×900 portrait', viewport(468, 804)],
] as const

const FLEETS = [1, 2, 4, 12, 20]

type Camera = { s: number; x: number; y: number }

/** Where a world point lands inside the viewBox, once the camera has moved. */
function project(p: Vec, cam: Camera): Vec {
  return { x: CX + cam.s * (p.x - cam.x), y: CY + cam.s * (p.y - cam.y) }
}

/** The camera the map is at rest under: what it framed, centred and whole. */
function restingAt(box: Box, view: Viewport): Camera {
  return { s: fitScale(box, view, CENTRED.margin), ...centre(box) }
}

/**
 * How much clear surface there is between what is drawn and each edge.
 *
 * Measured against what the nodes *paint* rather than against the box the
 * camera solved on, because those are two different boxes on purpose — the
 * framing box reserves caption room a node may not use — and the reader only
 * ever sees the first one.
 */
function airAround(scene: Scene, cam: Camera, view: Viewport) {
  const drawn = unionAll(scene.nodes.map(n => at(size(n, { dense: scene.geom.dense }), n.pos)))!
  const a = project({ x: drawn.x0, y: drawn.y0 }, cam)
  const b = project({ x: drawn.x1, y: drawn.y1 }, cam)
  return {
    left: a.x - (CX - view.w / 2),
    right: CX + view.w / 2 - b.x,
    top: a.y - (CY - view.h / 2),
    bottom: CY + view.h / 2 - b.y,
  }
}

for (const [shape, view] of SURFACES) {
  test.each(FLEETS)(`a ${shape} map holds all %i agents, captions and all`, agents => {
    const scene = build(data(agents))
    /* The camera centres what it framed, which is what the map does at rest. */
    const air = airAround(scene, restingAt(framedBox(scene, null)!, view), view)

    /* Not merely inside: clear of the surface's own edge fade, which takes the
       outer 3.5% under a mask. A caption that only just fits is a caption whose
       last letters are already half gone — which is what the reader sees and
       what a bounds check on its own would call a pass. The bar is stated here
       rather than read off `CENTRED`, so cutting the margin fails this. */
    const bar = Math.min(view.w, view.h) * 0.05
    expect(air.left).toBeGreaterThanOrEqual(bar - 0.5)
    expect(air.top).toBeGreaterThanOrEqual(bar - 0.5)
    expect(air.right).toBeGreaterThanOrEqual(bar - 0.5)
    expect(air.bottom).toBeGreaterThanOrEqual(bar - 0.5)
  })

  test.each(FLEETS)(`a ${shape} map centres all %i agents optically`, agents => {
    const scene = build(data(agents))
    const air = airAround(scene, restingAt(framedBox(scene, null)!, view), view)

    /* Equal air either side, and top to bottom. The failure this catches is a
       solve that fits the picture and then leaves it against one edge — which
       reads as a bug even though nothing is technically cut off. */
    expect(Math.abs(air.left - air.right)).toBeLessThan(1)
    expect(Math.abs(air.top - air.bottom)).toBeLessThan(1)
  })

  /* ---- and the promise is made of a map that is still arriving ----

     `listAgents`, `listApps` and `listSessionActivity` answer independently and
     the map draws as soon as the first of them does, so a fresh session paints
     the picture two or three times over: a bare ring, fans hanging off it, then
     job rows under the fans. Every wave is strictly larger than the last and
     none of them is a navigation — nobody clicked, nothing resized — so a
     camera solved on the first wave is still standing there for the third, too
     close, with the edges of the map outside a window that cannot be panned.

     Which is why the camera re-solves off the box it framed rather than off any
     one read landing: `same` is the whole test, and `useMapCamera` runs it
     against every scene it is handed. The waves race, so both orders are
     walked — apps can beat jobs or lose to them. */
  test.each(FLEETS)(`a ${shape} map is framed at every wave of a %i-agent load`, agents => {
    const bar = Math.min(view.w, view.h) * 0.05
    for (const waves of [
      [data(agents, 0, 0), data(agents, 4, 0), data(agents, 4, 6)],
      [data(agents, 0, 0), data(agents, 0, 6), data(agents, 4, 6)],
    ]) {
      let solved: Box | null = null
      let cam: Camera | null = null
      for (const wave of waves) {
        const scene = build(wave)
        const box = framedBox(scene, null)!
        if (solved === null || !same(solved, box)) {
          solved = box
          cam = restingAt(box, view)
        }
        const air = airAround(scene, cam!, view)
        expect(air.left).toBeGreaterThanOrEqual(bar - 0.5)
        expect(air.top).toBeGreaterThanOrEqual(bar - 0.5)
        expect(air.right).toBeGreaterThanOrEqual(bar - 0.5)
        expect(air.bottom).toBeGreaterThanOrEqual(bar - 0.5)
      }
    }
  })
}

/* The other half of that rule, and the reason it is a box comparison rather
   than a scene comparison. The map's clock ticks once a minute and every
   session refetch hands the layout a new object; if any of that re-aimed the
   camera, a flight the reader is halfway through would be re-solved under them
   once a minute, forever. A picture that has not moved does not move it. */
test('a data tick that redraws the same picture leaves the camera alone', () => {
  const before = framedBox(build(data(4)), null)!
  const after = framedBox(build(data(4)), null)!
  expect(same(before, after)).toBe(true)
})

/* One agent is the shape the ring cannot help being a line, and the size the
   camera is most tempted to fill the frame with. It should read as a portrait
   with a mount around it rather than as a picture cropped to its own edges. */
test('a one-agent drive is composed with air rather than filling the frame', () => {
  const [, view] = SURFACES[0]
  const scene = build(data(1, 1))
  const box = framedBox(scene, null)!
  const s = fitScale(box, view, CENTRED.margin)
  expect((width(box) * s) / view.w).toBeLessThan(0.8)
  expect((height(box) * s) / view.h).toBeLessThan(0.8)
})
