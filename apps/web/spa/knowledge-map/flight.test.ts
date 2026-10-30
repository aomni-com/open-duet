/* The shape of the flight, which is the whole of whether it reads as calm.

   Duration is not the thing. A half-second that starts at full speed and then
   crawls is a jump cut followed by a drift, and a half-second that overshoots
   and comes back is a spring — both of them are what makes a camera at this
   scale unpleasant to sit through fifty times in a session. So what is asserted
   here is the curve: still at both ends, monotone in between, and the one point
   the reader is actually following travelling in a straight line.
*/
import { expect, test } from 'bun:test'

import { advance, flying, flyTo, restingCamera, type CameraState } from './use-map-motion'

const CENTRE = { x: 700, y: 700 }
const DUR = 520

/** A flight from the resting camera into a face off to one side. */
function flight(): CameraState {
  const cam = restingCamera(CENTRE)
  cam.s = 0.6
  cam.x = 700
  cam.y = 700
  flyTo(cam, { s: 1.45, x: 1010, y: 520 }, { x: 1016, y: 512 }, 0, DUR)
  return cam
}

/** Where the anchor sits on screen, relative to the middle of the surface. */
function onScreen(cam: CameraState): { x: number; y: number } {
  return { x: (cam.anchor.x - cam.x) * cam.s, y: (cam.anchor.y - cam.y) * cam.s }
}

function frames(cam: CameraState, step = 20): { at: number; screen: { x: number; y: number } }[] {
  const out = []
  for (let t = 0; t <= DUR; t += step) {
    advance(cam, t, false)
    out.push({ at: t, screen: onScreen(cam) })
  }
  return out
}

test('it arrives exactly, and stops', () => {
  const cam = flight()
  expect(advance(cam, DUR, false)).toBe(false)
  expect(cam.s).toBe(1.45)
  expect(cam.x).toBe(1010)
  expect(cam.y).toBe(520)
})

test('it sets off gently rather than at full speed', () => {
  const cam = flight()
  const path = frames(cam, DUR / 20)
  const total = Math.abs(path[path.length - 1]!.screen.x - path[0]!.screen.x)
  /* The first twentieth of the time covers well under a twentieth of the
     distance. An exponential ease — which is what this replaced — covers about
     a sixth of it in the same slice, and that first frame is the jump cut. */
  const firstStep = Math.abs(path[1]!.screen.x - path[0]!.screen.x)
  expect(firstStep / total).toBeLessThan(1 / 20)
})

test('it settles rather than arriving at speed', () => {
  const cam = flight()
  const path = frames(cam, DUR / 20)
  const total = Math.abs(path[path.length - 1]!.screen.x - path[0]!.screen.x)
  const lastStep = Math.abs(path[path.length - 1]!.screen.x - path[path.length - 2]!.screen.x)
  expect(lastStep / total).toBeLessThan(1 / 20)
})

test('nothing overshoots and comes back', () => {
  const cam = flight()
  const path = frames(cam)
  const scales: number[] = []
  for (let i = 1; i < path.length; i += 1) {
    /* Monotone in both axes: a point that passes its target and returns is a
       spring, and at this scale a spring reads as the map wobbling. */
    expect(path[i]!.screen.x).toBeLessThanOrEqual(path[i - 1]!.screen.x + 1e-9)
    expect(path[i]!.screen.y).toBeGreaterThanOrEqual(path[i - 1]!.screen.y - 1e-9)
  }
  const walk = restingCamera(CENTRE)
  walk.s = 0.6
  flyTo(walk, { s: 1.45, x: 1010, y: 520 }, { x: 1016, y: 512 }, 0, DUR)
  for (let t = 0; t <= DUR; t += 20) {
    advance(walk, t, false)
    scales.push(walk.s)
  }
  for (const s of scales) {
    expect(s).toBeGreaterThanOrEqual(0.6 - 1e-9)
    expect(s).toBeLessThanOrEqual(1.45 + 1e-9)
  }
})

test('the point the eye is following crosses the screen in a straight line', () => {
  /* The camera pans and zooms at once, and tweening its own x, y and scale is
     three races to the same finish line — the face swings through an arc while
     they run. Solving the pan backwards from the anchor is what makes the thing
     you clicked travel from where it was to where it lands and nowhere else. */
  const cam = flight()
  const path = frames(cam)
  const a = path[0]!.screen
  const b = path[path.length - 1]!.screen
  for (const { screen } of path) {
    /* Distance from the straight line through the two ends, in screen units. */
    const cross = Math.abs((b.x - a.x) * (a.y - screen.y) - (a.x - screen.x) * (b.y - a.y))
    const span = Math.hypot(b.x - a.x, b.y - a.y)
    expect(cross / span).toBeLessThan(0.001)
  }
})

test('reduced motion is a cut, never a partial state', () => {
  const cam = flight()
  expect(advance(cam, 0, true)).toBe(false)
  expect(cam.s).toBe(1.45)
  expect(cam.x).toBe(1010)
})

/* Arriving somewhere solves the framing more than once — the surface mounts and
   is measured, then the viewBox lands as state a render later — and only the
   first of those was ever meant to be a flight. `flying` is what the second one
   asks before deciding whether it is re-aiming or cutting, and getting that
   answer wrong is not a small thing: the flight is killed a frame or two after
   it starts, so the whole move happens in the distance those frames cover. It
   reads as a jump, and it read as one only on the way *in*, because leaving
   solves once and had nothing to cut it.

   Told in distance rather than in booleans: a cut is a camera that has already
   arrived while the clock says it should still be most of the way out. */
test('a re-aim a frame into the flight does not cut it short', () => {
  const cam = flight()
  const oneFrame = 16
  advance(cam, oneFrame, false)
  expect(flying(cam, oneFrame)).toBe(true)

  /* What the second solve does when it believes the flight is still running:
     re-aim, keep flying, and let the curve carry on from where it is. */
  flyTo(cam, { s: 1.45, x: 1010, y: 520 }, { x: 1016, y: 512 }, oneFrame, DUR)
  advance(cam, oneFrame + 40, false)
  const travelled = Math.abs(cam.s - 0.6) / Math.abs(1.45 - 0.6)
  expect(travelled).toBeLessThan(0.2)
  expect(flying(cam, oneFrame + 40)).toBe(true)
})

test('a flight that has landed is no longer flying', () => {
  const cam = flight()
  expect(flying(cam, DUR - 1)).toBe(true)
  expect(flying(cam, DUR)).toBe(false)
  /* A cut is not a flight, so nothing can mistake one for something to protect. */
  const cut = flight()
  flyTo(cut, { s: 1, x: 700, y: 700 }, CENTRE, 0, 0)
  expect(flying(cut, 0)).toBe(false)
})
