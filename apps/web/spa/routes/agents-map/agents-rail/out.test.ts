import { describe, expect, test } from 'bun:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { railOpenKey, useRailOpen } from './open-state'
import { railIsOut } from './out'

describe('railIsOut', () => {
  test('a window too narrow for both columns folds the roster the reader left open', () => {
    expect(railIsOut({ open: true, cramped: true, said: false })).toBe(false)
  })

  test('the reader can overrule the fold inside the band, and their answer wins', () => {
    expect(railIsOut({ open: true, cramped: true, said: true })).toBe(true)
  })

  test('a reader who shut it keeps it shut in a window with room to spare', () => {
    expect(railIsOut({ open: false, cramped: false, said: true })).toBe(false)
    expect(railIsOut({ open: false, cramped: false, said: false })).toBe(false)
  })

  test('out by default: room to spare, nothing said, and the roster stands', () => {
    expect(railIsOut({ open: true, cramped: false, said: false })).toBe(true)
  })

  test('a list-first mobile destination can keep its navigator out until the reader folds it', () => {
    expect(
      railIsOut({
        open: true,
        cramped: true,
        said: false,
        preferOutWhenCramped: true,
      }),
    ).toBe(true)
  })

  /* The band is allowed to decide, never to remember. A reader who overruled a
     fold at 1100 and then widened the window has said nothing about how they
     want to work at 1500 — `said` resets on the crossing, so the default they
     actually chose comes back rather than the answer they gave about one
     cramped window. Asserted here as the pair of states either side of that
     reset, because the reset itself belongs to the hook. */
  test('the resolver uses the supplied stored preference after the band overrule resets', () => {
    expect(railIsOut({ open: true, cramped: true, said: true })).toBe(true)
    expect(railIsOut({ open: true, cramped: false, said: false })).toBe(true)
    expect(railIsOut({ open: false, cramped: true, said: true })).toBe(false)
    expect(railIsOut({ open: false, cramped: false, said: false })).toBe(false)
  })
})

/* ------------------------------------------------- what a fold may remember

   Two things fold the column without the reader choosing to: the window
   crossing the band, and — below `sm`, where the column covers what it sends
   you to — picking something in it. Neither may outlive the visit, or a reader
   who tapped a row on a phone opens their laptop to a roster they never closed.

   Asserted at the storage seam rather than through `dismissAfterPick`, because
   the overlay branch is unreachable here by construction: `useSyncExternalStore`
   takes its *server* snapshot under `renderToStaticMarkup`, which answers "not
   an overlay" for the same reason the real first paint does. Which width
   dismisses is the resolver's and the visual gate's; WHAT IT WRITES is this
   file's, and it is the half that was actually wrong. */
function railOpenProbe() {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
  let seen: ReturnType<typeof useRailOpen> | undefined
  function Probe() {
    seen = useRailOpen(storage)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return { hook: seen!, store }
}

test('the control writes the reader’s preference', () => {
  const { hook, store } = railOpenProbe()
  hook.setOpen(false)
  expect(store.get(railOpenKey)).toBe('shut')
})

test('the temporary-fold setter writes no stored preference', () => {
  const { hook, store } = railOpenProbe()
  hook.setOpenForNow(false)
  expect(store.has(railOpenKey)).toBe(false)
  expect(store.size).toBe(0)
})
