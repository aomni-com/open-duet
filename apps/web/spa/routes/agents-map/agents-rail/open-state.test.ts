/* The rail is furniture, so whether it is out is a fact about the reader rather
   than about the drive — and every function that carries it has to be total.
   Storage is a thing a browser is allowed to refuse: private modes throw on the
   access itself rather than returning null, and a value written by an older
   build or by hand is not a schema. Nothing in here is worth a map that does not
   draw, so the failure of all of it is "the rail is however you left it, or shut".
*/
import { expect, test } from 'bun:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { railOpenKey, readRailOpen, useRailOpen, writeRailOpen } from './open-state'

/** The smallest thing that behaves like `localStorage`. */
function store(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    read: (key: string) => map.get(key) ?? null,
  }
}

/** One that behaves like a browser refusing to hand it over at all. */
const HOSTILE = {
  getItem: () => {
    throw new Error('denied')
  },
  setItem: () => {
    throw new Error('denied')
  },
}

test('the rail comes back the way it was left, in both directions', () => {
  const open = store()
  writeRailOpen(open, true)
  expect(open.read(railOpenKey)).toBe('open')
  expect(readRailOpen(open, false)).toBe(true)

  const shut = store()
  writeRailOpen(shut, false)
  expect(shut.read(railOpenKey)).toBe('shut')
  /* The fallback is deliberately the opposite of what was stored: a `readRailOpen`
     that merely tested "is there a value here" would pass this with `true`. */
  expect(readRailOpen(shut, true)).toBe(false)
})

test('a reader who has never touched it gets the default they were given', () => {
  expect(readRailOpen(store(), false)).toBe(false)
  expect(readRailOpen(store(), true)).toBe(true)
})

test('a value from an older build, or from nobody, is not a state', () => {
  expect(readRailOpen(store({ [railOpenKey]: 'yes' }), false)).toBe(false)
  expect(readRailOpen(store({ [railOpenKey]: '' }), true)).toBe(true)
})

test('storage the browser refuses breaks neither the read nor the write', () => {
  expect(readRailOpen(HOSTILE, true)).toBe(true)
  expect(() => writeRailOpen(HOSTILE, true)).not.toThrow()
  expect(readRailOpen(undefined, true)).toBe(true)
  expect(() => writeRailOpen(undefined, true)).not.toThrow()
})

/* The default itself, not just the plumbing that carries one. Every test above
   hands `readRailOpen` an explicit fallback, so all of them would stay green if
   the product's own default were flipped back — and that default is the whole
   of "the roster is out by default", which is the decision this feature turns
   on. `useRailOpen` is where the constant is actually spent, so this asks it. */
test('a reader who has never touched the control gets the roster out', () => {
  const empty = store({})
  let seen: boolean | undefined
  function Probe() {
    seen = useRailOpen(empty).open
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  expect(seen).toBe(true)
})

/* The rotation, pinned so it cannot be quietly undone. A build that read the
   old key again would hand a share of readers a folded roster on the product's
   front door, for a preference they expressed about a control that no longer
   exists. */
test('a preference stored under the retired key is not read', () => {
  expect(readRailOpen(store({ 'duet.agents-rail-open': 'shut' }), true)).toBe(true)
})
