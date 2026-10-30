/* Escape, and who gets to answer it.

   The interesting case is not the keypress — it is the keypress arriving after
   something else has already dealt with it. See `keys.ts`: the map is the
   outermost thing on the screen, so it is the last to be asked and the only one
   that has to check whether it is still being asked at all.
*/
import { expect, test } from 'bun:test'

import { leavesAgent } from './keys'

test('Escape leaves the agent when nothing above it answered', () => {
  expect(leavesAgent({ key: 'Escape', defaultPrevented: false })).toBe(true)
})

test('a layer that already answered keeps the reader on the agent', () => {
  // A dialog, menu or popover open over the surface dismissed itself and said
  // so. Flying back to the ring as well is one Escape doing two things.
  expect(leavesAgent({ key: 'Escape', defaultPrevented: true })).toBe(false)
})

test('no other key leaves the agent, answered or not', () => {
  for (const key of ['Enter', 'Tab', ' ', 'Esc', 'escape']) {
    expect(leavesAgent({ key, defaultPrevented: false })).toBe(false)
    expect(leavesAgent({ key, defaultPrevented: true })).toBe(false)
  }
})
