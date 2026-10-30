import { expect, test } from 'bun:test'

/* The map's promise about words: one is either readable or it is not drawn.

   Everything on this canvas is set in world units and multiplied by whatever
   scale the camera solved, so the size a name is *declared* at says nothing
   about the size it is *read* at — on a big fleet the smallest tier was landing
   at a third of the size it was chosen for. The floor is the fix, and the only
   honest way to test it is against the scales the camera really reaches: the
   layout, the framing and the type scale have to be asked the question together,
   because separately each of them is fine.
*/
import { ROOT_AGENT_SCOPE } from '@repo/contract'

import { build, familyIds, viewport } from './layout'
import { labelScale, smallestText, TEXT_FLOOR, TYPE } from './metrics'
import type { MapData } from './types'
import { CENTRED, fitScale, MAX_SCALE, MIN_SCALE } from './use-map-camera'
import { framedBox } from './use-map-motion'

function data(agents: number, apps = 4): MapData {
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
      name: `agent-${i}`,
      avatarKey: `agent-${i}`,
      /* Work in flight, because it is what the second row is drawn from — and
         a fixture with none of it measures a map the product does not ship. */
      jobs: Array.from({ length: 6 }, (_, j) => ({
        id: `agent-${i}-job-${j}`,
        title: 'Q3 revenue reconciliation',
        when: 'now',
        state: 'running' as const,
        unread: false,
      })),
      apps: Array.from({ length: apps }, (_, j) => ({
        id: `agent-${i}-app-${j}`,
        title: `App ${j}`,
        when: 'now',
        state: 'connected' as const,
      })),
    })),
  }
}

/* The three the brief names, plus the widest and the tallest the product is
   drawn at. `viewport` takes the container's own shape, so this is the real
   input the camera solves against. */
const SURFACES = [
  ['1440×900', viewport(1408, 804)],
  ['900×900', viewport(868, 804)],
  ['500×900', viewport(468, 804)],
  ['1920×1080', viewport(1888, 984)],
  ['1280×1600', viewport(1248, 1504)],
] as const

/* Twenty is the contract the crowded tier exists to keep, and it is the size the
   ring used to fail at — a list stopping at sixteen stops one rung before the
   promise, which is exactly where it stopped while the promise was being made. */
const FLEETS = [1, 2, 3, 5, 7, 8, 12, 16, 18, 20]

test.each(SURFACES)('nothing on a %s map is drawn below the floor', (_name, view) => {
  for (const agents of FLEETS) {
    const scene = build(data(agents))
    const box = framedBox(scene, null)!
    const cam = fitScale(box, view, CENTRED.margin)
    /* Rounded, because the property is written to three decimal places and a
       floor missed by a thousandth of a pixel is not a bug. */
    expect(Number(smallestText(cam).toFixed(2))).toBeGreaterThanOrEqual(TEXT_FLOOR)
  }
})

test('the floor holds all the way inside an agent, where the flight ends', () => {
  const scene = build(data(3))
  const inside = fitScale(
    framedBox(scene, familyIds(scene, 'agent-1'))!,
    SURFACES[0][1],
    CENTRED.margin,
  )
  expect(Number(smallestText(inside).toFixed(2))).toBeGreaterThanOrEqual(TEXT_FLOOR)
})

/* Flying in is the one direction the correction stays out of: growing with the
   scene is what going inside something looks like, and a name pinned to 11px
   while the face it belongs to fills the screen reads as a rendering fault. */
test.each([1, 1.2, MAX_SCALE])('a camera at %f leaves the type scale alone', cam => {
  expect(labelScale(cam)).toBe(1)
})

test.each([0.9, 0.75, 0.566])('a camera at %f holds the type instead of shrinking it', cam => {
  /* Exactly the floor, not near it: what the reader sees is the size the tier
     was chosen at rather than a compromise between that and the camera. 0.566 is
     the furthest back the map above actually solves. */
  expect(smallestText(cam)).toBeCloseTo(TEXT_FLOOR, 6)

  /* And the tiers keep their distance from each other. Floors applied per tier
     would collapse 21/16/13/11 towards one number exactly when there is most on
     screen to tell apart, so there is one correction for all four. */
  expect(TYPE.t2 * labelScale(cam) * cam).toBeCloseTo((TYPE.t2 / TYPE.t4) * TEXT_FLOOR, 6)
})

/* Where the promise actually ends, pinned rather than remembered.

   The floor holds to twenty-two agents with every one of them working, and at
   twenty-four the correction has hit its own cap and the caption lands at
   10.7px. That is the real ceiling of this drawing, and it is asserted from both
   sides so that a change which quietly lowers it goes red here rather than
   being discovered on somebody's twenty-three-agent drive. */
test('the drawing runs out at twenty-three agents, and says so', () => {
  const view = SURFACES[0][1]
  const floorAt = (agents: number): number =>
    smallestText(fitScale(framedBox(build(data(agents)), null)!, view, CENTRED.margin))

  expect(Number(floorAt(22).toFixed(2))).toBeGreaterThanOrEqual(TEXT_FLOOR)
  expect(floorAt(24)).toBeLessThan(TEXT_FLOOR)
})

/* The correction cannot run for ever. A caption held at a fixed screen size
   takes more *world* room the further back the camera goes, and the room it is
   budgeted against does not move — so past the cap the names would start running
   into their neighbours', which is a different way of being unreadable.

   The cap is where the reserve runs out, which the surfaces above put at around
   nineteen agents; the map solves 0.61 at sixteen and 0.34 only past forty. Past
   the cap the floor degrades rather than breaking: the words keep getting bigger
   than they would have been, just not big enough. */
test('the correction stops before a caption could outgrow its own room', () => {
  expect(labelScale(MIN_SCALE)).toBe(1.9)
  expect(smallestText(MIN_SCALE)).toBeGreaterThan(TYPE.t4 * MIN_SCALE)
})
