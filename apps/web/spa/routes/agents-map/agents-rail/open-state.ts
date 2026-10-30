'use client'

/* ============================================================================
   Whether the roster is out, and it is the reader's answer rather than the
   product's.

   The desktop column is permanent. This preference governs only the smaller
   overlay drawer, where the roster covers the destination and therefore needs
   an explicit open or closed state.

   Deliberately not in the URL: a link that lands somebody on somebody else's
   furniture is not a destination. And deliberately not per workspace either —
   how you like to read a list is a fact about you.

   This module is the durable half only. Two other things fold the drawer and
   neither may be written here: the window crossing the band, and a tap that
   dismisses the panel below `lg`. `out.ts` resolves all three; `setOpenForNow`
   below is what those two spend.

   Every function here is total. Storage is something a browser is allowed to
   refuse outright: private modes throw on the access itself. Nothing about this
   is worth a roster that fails to draw, so the failure of all of it is the
   default the caller asked for — which the product answers **out**.
   ========================================================================= */

import { useCallback, useMemo, useState } from 'react'

/** Exported so the storage contract and its tests name one key. */
export const railOpenKey = 'duet.agents-roster-open'

/**
 * Out, for a reader who has never said otherwise.
 *
 * The window resolver still folds the overlay wherever it would cover the
 * useful first view; list-first destinations may opt into showing it.
 */
const OUT_UNTIL_ASKED = true

/* One token per state rather than `JSON.parse`. The value is a single bit and
   these are the only two spellings of it the product has ever written, so
   anything else — an older build, a hand-edited value, an empty string — is not
   a state this can be in and falls through to what the caller asked for. */
const OPEN = 'open'
const SHUT = 'shut'

export function readRailOpen(
  storage: Pick<Storage, 'getItem'> | undefined,
  fallback: boolean,
): boolean {
  if (storage === undefined) return fallback
  try {
    const raw = storage.getItem(railOpenKey)
    return raw === OPEN ? true : raw === SHUT ? false : fallback
  } catch {
    return fallback
  }
}

/** Store it, and never let failing to do so break the click that caused it. */
export function writeRailOpen(storage: Pick<Storage, 'setItem'> | undefined, open: boolean): void {
  if (storage === undefined) return
  try {
    storage.setItem(railOpenKey, open ? OPEN : SHUT)
  } catch {
    /* A reader whose browser will not remember this still gets to open it. */
  }
}

/**
 * The rail's one piece of state, and where it is kept between visits.
 *
 * Held in React as well as in storage rather than read on every render, for the
 * reason the header row's order is: storage is the slow copy, written after the
 * fact, and the column has to start moving in the same frame as the click.
 */
export function useRailOpen(storage?: Pick<Storage, 'getItem' | 'setItem'>): {
  open: boolean
  /** the control's setter — the only thing in the product that writes storage */
  setOpen: (open: boolean) => void
  /** for the two folds nobody chose: the window's, and a tap that dismisses a panel */
  setOpenForNow: (open: boolean) => void
} {
  const store = useMemo(() => {
    if (storage !== undefined) return storage
    /* A browser can refuse to hand this over at all — private modes do, and the
       access itself throws rather than returning null. */
    try {
      return typeof window === 'undefined' ? undefined : window.localStorage
    } catch {
      return undefined
    }
  }, [storage])

  const [open, set] = useState(() => readRailOpen(store, OUT_UNTIL_ASKED))
  const setOpen = useCallback(
    (next: boolean) => {
      set(next)
      writeRailOpen(store, next)
    },
    [store],
  )
  /* The same move, remembered for this visit only.
     Two things fold the column without the reader ever choosing to: the window
     crossing the band, and — below `sm`, where the column covers what it sends
     you to — picking something in it. Neither is a preference, and writing
     either one would hand a reader a folded roster on their next visit for a
     choice they did not make. This is the setter those use, and the reason
     `setOpen` above is reachable only from the control. */
  const setOpenForNow = useCallback((next: boolean) => set(next), [])

  return { open, setOpen, setOpenForNow }
}
