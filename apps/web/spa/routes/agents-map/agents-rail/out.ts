'use client'

/* ============================================================================
   Whether the roster is drawn.

   Three facts, and they are deliberately not interchangeable:

   - `open` is the **reader's**, and it is the only one that outlives the visit.
     It lives in storage (`open-state.ts`) and nothing here ever writes it.
   - `cramped` is the **window's**. Below the band there is not room for the
     roster and two equal columns at once, so the roster gives its width back.
   - `said` is the **conversation between them**: has the reader touched the
     control since the window last crossed the band? Until they have, the
     window's answer stands over the stored one; once they have, theirs does.

   ---- why `said` has to exist ----
   Without it the two remaining facts cannot express the one state a reader in a
   small window actually wants: "I know it is tight, show me the roster anyway."
   Either the auto-fold wins forever and the control does nothing inside the
   band, or the preference wins forever and the auto-fold does nothing at all.
   `said` is what lets the window decide by default and the reader overrule it,
   which is the whole contract.

   It is component state, not storage, and it resets when the band changes —
   because "I want it out at 1100" is an answer about this window, not a new
   preference. A reader who then widens the window is back to the default they
   actually chose.

   ---- the auto-fold may never be remembered ----
   Structural rather than a discipline: this function is pure, and `writeRailOpen`
   is reachable only from the click. There is no path from a resize to storage.
   A resize that rewrote the preference would be the window deciding how the
   reader likes to work, which is the same mistake a remembered hover would have
   been.

   ========================================================================= */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { useRailOpen } from './open-state'

/**
 * Whether the column is drawn *over* its neighbour rather than beside it.
 *
 * Below `lg` there is no room for the full workspace sidebar beside the canvas,
 * so the roster slides
 * across as a full-width panel — the same records, the only shape that fits.
 * That is a presentation detail everywhere except one place: a panel that
 * covers the conversation must get out of the way when the reader picks
 * something, or tapping a row leaves them looking at the list they tapped it
 * from. Beside its neighbour there is nothing to get out of the way of, and
 * folding on every click would be the column flickering.
 *
 * The breakpoint is the rail's own `lg:`, stated here because this is the only
 * place JavaScript needs to know it.
 */
const OVERLAY_QUERY = '(max-width: 1023px)'

function subscribeToOverlay(onChange: () => void) {
  const query = window.matchMedia(OVERLAY_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function useRosterOverlays(): boolean {
  return useSyncExternalStore(
    subscribeToOverlay,
    () => window.matchMedia(OVERLAY_QUERY).matches,
    () => false,
  )
}

/**
 * The roster's out-ness, and the one control that changes it.
 *
 * The whole of the three-fact contract in one place: the stored preference, the
 * window's band, and whether the reader has answered the band. Callers get a
 * boolean and a toggle and never see the parts.
 *
 * `said` resets whenever the band changes, in an effect rather than during
 * render, because the reset is a response to the *window* moving rather than to
 * anything this component did — and because clearing it during render would
 * discard an overrule the reader made in the same frame they resized.
 */
export function useRosterOut({
  storage,
  preferOutWhenCramped = false,
}: {
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  /** A list-first destination may keep its full-screen mobile navigator visible initially. */
  preferOutWhenCramped?: boolean
} = {}): {
  out: boolean
  toggle: () => void
  /**
   * Called when the reader picks something in the column.
   *
   * A no-op wherever the column stands beside its neighbour; below `sm`, where
   * it covers the conversation, it folds — because a panel that stays open over
   * the thing you just chose is a panel you have to dismiss to see your own
   * click land.
   */
  dismissAfterPick: () => void
} {
  const { open, setOpen, setOpenForNow } = useRailOpen(storage)
  const overlays = useRosterOverlays()
  const cramped = overlays
  const [said, setSaid] = useState(false)

  const lastBand = useRef(cramped)
  useEffect(() => {
    if (lastBand.current === cramped) return
    lastBand.current = cramped
    setSaid(false)
  }, [cramped])

  /* Out-ness is the drawer's question, and only the drawer's. At `lg` and above
     the column is permanent at the same width as Work. There is nothing there
     worth taking away, so nothing takes it away:
     no control, no stored preference, no auto-fold.

     Below `lg` it is a panel over the conversation, and a panel that
     covers what you are reading has to be closable or it is a trap. That is the
     one place the three facts below still decide anything. */
  const out = !overlays || railIsOut({ open, cramped, said, preferOutWhenCramped })
  /* The reader's answer is always "make it the other thing", which inside the
     band means the stored preference and the visible state can legitimately
     disagree — folded at 1100 with `open` still true. Writing `!out` rather
     than `!open` is what makes the control do what it looks like it does. */
  const toggle = useCallback(() => {
    setSaid(true)
    setOpen(!out)
  }, [out, setOpen])

  const dismissAfterPick = useCallback(() => {
    if (!overlays) return
    setSaid(true)
    /* For this visit only. A tap that dismisses a panel is the reader getting
       on with what they picked, not a statement about how they like to work —
       and storing it would fold the roster on their desktop next time. Same
       reason the auto-fold does not write: see the header. */
    setOpenForNow(false)
  }, [overlays, setOpenForNow])

  return { out, toggle, dismissAfterPick }
}

/** Whether the roster is drawn, from the three facts that decide it. */
export function railIsOut({
  open,
  cramped,
  said,
  preferOutWhenCramped = false,
}: {
  /** the reader's stored preference — never written from here */
  open: boolean
  /** the window is too narrow for the roster and two equal columns */
  cramped: boolean
  /** the reader has used the control since the window last crossed the band */
  said: boolean
  /** whether the destination's useful first mobile view is the navigator itself */
  preferOutWhenCramped?: boolean
}): boolean {
  return said ? open : open && (!cramped || preferOutWhenCramped)
}
