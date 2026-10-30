'use client'

/* The map's own surfaces, because this page is the map's neighbour: the same
   `--km-*` ground, the same glass, the same hairlines. */
import '../../knowledge-map/knowledge-map.css'

import type { ReactNode } from 'react'

/* ============================================================================
   One agent, as a page.

   ---- what this replaced ----
   The agent used to be a *state of the ring*: `agents/*` was one route, the
   canvas stayed mounted for every URL under it, and the surface unfolded as an
   overlay while a camera flew the face you clicked into a hole the layout left
   for it. Everything in that sentence is gone. The face is drawn by the surface
   (see `agent-surface`), the flight is gone with the hole, and the ring is not
   here at all — an agent is a place you go, not a place the camera parks.

   ---- it carries the hues, because it is not inside the canvas ----
   `km-hues` is the class the map's stylesheet uses for its own surfaces drawn
   *outside* the `.knowledge-map` element — the roster column and the jobs
   dialog both wear it. This page needs it for the same reason and did not have
   it: the palette (`--km-bg`, `--km-slab`, the two colour axes) is declared on
   that selector, and while this surface was an overlay *inside* the canvas it
   inherited them. As a page of its own it inherited nothing, so every panel on
   it resolved `background: var(--km-bg)` to an invalid value and painted
   transparent — the card, the conversation and the page's own ground.

   ---- the roster IS beside it now, and the old post-mortem still stands ----
   This page once carried the roster folded to zero width and `inert`, on the
   argument that it is what you steer this surface with. It never steered
   anything: the resolver refused to open it inside an agent and the control
   that folds it was not drawn, so what this page carried was a roster nobody
   could see or reach — one row of DOM per agent on the drive, in a column zero
   pixels wide. It was not free, either. The shell's grid row was sized by its
   tallest item, so past a roster longer than the window that invisible column
   made this page taller than the screen it was on.

   The roster is back, and **both of those failure modes are now impossible by
   construction rather than by care.** It is visible by default and folds by a
   control the reader can see (`agents-rail/out.ts`), so there is no such thing
   as a roster nobody can reach; and the row is declared `minmax(0, 1fr)` in
   `agents-section`, so a long list scrolls inside the window instead of sizing
   it. Neither of those is this file's doing — which is the point. This page is
   the surface, and where it stands is somebody else's question.
   ========================================================================= */
export function AgentPage({
  /** the unfolded agent — `AgentSurface`, mounted by the route */
  children,
}: {
  children: ReactNode
}) {
  /* No `<main>` and no heading: `agents-section` owns the landmark for every
     destination under `/agents`, and a second one here would put two on a page.
     `km-hues` stays, because the palette belongs to what is drawn rather than
     to the frame — the section is ordinary product chrome and the roster
     declares its own. */
  return (
    <div className="km-hues relative h-full min-h-0 min-w-0 overflow-hidden bg-background">
      {/* `.km-page` is the `km-frame` container the agent surface's phone
          composition queries at 30rem. The roster is deliberately OUTSIDE it —
          a sibling one level up, in the section's other track — so this frame
          measures only what the destination actually has. Nest the roster in
          here and that query fires at the wrong width, silently. */}
      <div className="km-page">{children}</div>
    </div>
  )
}
