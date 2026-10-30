'use client'

/* ============================================================================
   The agents section: a roster, and whatever the URL says to put beside it.

   Every destination under `/agents` is this shape — the workspace drawn as a
   picture, or one agent unfolded — and the difference between them is only what
   goes in the second track. The roster is section furniture: mounted once, here,
   and it does not know or care which of them is beside it.

   ---- the grid moved, it was not copied ----
   This is `knowledge-map-home`'s `<main>`, lifted whole. It had to move rather
   than be duplicated: it is the one place that knows how a roster and a
   destination share a window, and two copies of that knowledge is two places for
   it to drift. Both ⚠️ comments below came with it, because both were bugs once
   and neither is styling.

   ---- and the roster must be a sibling of `.km-page`, never inside it ----
   `.km-page` declares `container: km-frame / inline-size`, and the agent
   surface's phone composition queries that container at 30rem. Nest the roster
   inside and `km-frame` measures roster + sheet, so the phone composition fires
   at the wrong width — silently, because a container query that never matches
   raises nothing at all. The grid below keeps them as siblings, which is what
   makes the frame measure only what the destination actually has.

   ---- one landmark, and this file owns it ----
   `<main>` and the section's `<h1>` live here and nowhere under it. They used to
   be spelled by each destination, which was correct while each destination was
   the whole window; with both of them inside this, two `<main>` elements and two
   `<h1>`s would end up on one page.
   ========================================================================= */
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'

export function AgentsSection({
  /**
   * The column, already resolved. This file does not decide whether it is out —
   * `agents-rail/out.ts` does, from three facts, and the roster draws itself
   * folded or standing accordingly.
   */
  roster,
  /** the destination the URL named: the canvas, or one agent */
  children,
}: {
  roster: ReactNode
  children: ReactNode
}) {
  const t = useTranslations('duetApp.homeSurface')
  return (
    /* Two columns and no gutter between them: the roster's own right edge is the
       seam, and a section-level gap would put a stripe of background between the
       column and the thing it is a list of. `auto` rather than a width, because
       the roster is the one that knows how wide it is — and how wide it is is
       zero whenever it is folded.

       `minmax(0, 1fr)` and not `1fr`: a grid track's automatic minimum is its
       content, and the canvas declares a `min-height` of its own, so without the
       floor the second column refuses to shrink and the roster pushes the
       destination off the right of the window instead of taking room from it.

       ⚠️ The row is declared for the same reason, and leaving it implicit was a
       bug rather than a shorthand. An implicit row is `auto`, so it is sized by
       the tallest thing in it — and the roster is one row per agent inside a
       column whose height is percentages the whole way down. A percentage
       against an auto row resolves to `auto`, so past a roster taller than the
       window the list stopped scrolling and started *sizing the row*: twelve
       agents on a 900px window measured a 1978px canvas with the ring 540px low.
       `minmax(0, 1fr)` pins the row to the window and hands the roster a
       definite height to scroll inside.

       This is also the half of the old post-mortem in `agent-page.tsx` that made
       a mounted roster dangerous on an agent's page — the shell's row sized to
       its tallest item, so a long roster made the page taller than the screen.
       Declared here, it cannot happen again on either destination. */
    <main className="relative grid h-full min-h-0 min-w-0 grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-background">
      <h1 className="sr-only">{t('title')}</h1>
      {roster}
      {/* ⚠️ `col-start-2` is load-bearing and it is not styling. The roster
          collapses to a zero-width track when folded, and with an empty first
          track this box auto-places into it — the `auto` one — where a child's
          `width: 100%` has no definite track to resolve against and computes to
          **zero**. The destination then draws nothing at all, which is a blank
          screen rather than a wrong one, and it is invisible to every test that
          does not photograph it. Say which column this is and the empty track
          stays empty. */}
      <div className="relative col-start-2 grid min-h-0 min-w-0 overflow-hidden">{children}</div>
    </main>
  )
}
