/* The map has to be a correct drawing whether or not anybody gives it frames.

   A node is born at its parent and eased to its place, so a tween that stops
   part way is not a paused animation — it is an app node sitting on the face it
   hangs off, with its caption under the agent's name. That shipped: on a
   throttled tab the fan reached `translate(1056.73,700)` and stayed there, for
   a node whose place is `translate(1164,700)`.

   The loop cannot see that happening to it; the watchdog is the only thing that
   can, so what the watchdog decides is the behaviour worth pinning. */
import { expect, test } from 'bun:test'

import { watchdogAction } from './use-map-motion'

test('a travelling map with absent or stalled frames is landed by hand', () => {
  expect(watchdogAction({ drew: false, travelling: true })).toBe('land')
})

test('a map that is being drawn is left alone', () => {
  /* Frames are arriving: whatever is travelling is somebody else's job, and
     snapping it would be a visible jump in the middle of a flight. */
  expect(watchdogAction({ drew: true, travelling: true })).toBe('watch')
})

test('a map with nothing left to move stops being watched', () => {
  /* Both ways in: parked after a flight, and landed by the check before this
     one. A watchdog that re-armed here would be a timer running for as long as
     the page is open, which is the cost the loop parks to avoid. */
  expect(watchdogAction({ drew: false, travelling: false })).toBe('rest')
  expect(watchdogAction({ drew: true, travelling: false })).toBe('watch')
})
