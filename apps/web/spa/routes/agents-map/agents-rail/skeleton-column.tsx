'use client'

/* ============================================================================
   The roster's column, before there is a workspace to fill it.

   Only the pre-identity shell needs this. Everywhere else the roster is the
   real `AgentsRail` and its own `phase` draws the waiting rows — but that shell
   runs before identity resolves, so it has no workspace, no reads, and no fold
   preference to honour. What it does know is that the column will be there.

   Everything it borrows, it borrows rather than restates: the width, the head's
   box, and the rows themselves all come from the column this stands in for. A
   skeleton that spelled its own four numbers would drift from the real one one
   number at a time, and a skeleton one bar-height off is precisely the jump it
   exists to prevent.

   Out, always. The reader's stored preference is not readable yet, and out is
   the default — starting folded and unfolding a beat later would be that same
   jump wearing different clothes.
   ========================================================================= */
import type { CSSProperties } from 'react'

import { ROSTER_HEAD_BOX, ROSTER_WIDTH } from './index'
import { SkeletonRows } from './list'

export function RosterSkeletonColumn() {
  return (
    <aside className="km-hues relative z-10 h-full" aria-hidden>
      <div
        className="hidden h-full w-[var(--rail-w)] border-r border-border lg:block"
        style={{ '--rail-w': ROSTER_WIDTH } as CSSProperties}
      >
        <div className={ROSTER_HEAD_BOX} data-build-sidebar-skeleton="">
          <div className="px-2.5 py-2">
            <div className="grid h-7 grid-cols-2 gap-0.5 rounded-md bg-muted/70 p-0.5">
              <span className="rounded-[5px] bg-muted" />
              <span className="animate-pulse rounded-[5px] bg-background shadow-xs ring-1 ring-border/45" />
            </div>
          </div>
          <div className="px-2.5 pb-3">
            <div className="flex h-8 items-center gap-2 rounded-md px-2">
              <span className="size-4 animate-pulse rounded bg-muted" />
              <span className="h-3 w-12 animate-pulse rounded-full bg-muted" />
            </div>
            <div className="mt-5 px-2">
              <span className="block h-2.5 w-12 animate-pulse rounded-full bg-muted/70" />
            </div>
          </div>
        </div>
        <SkeletonRows compact />
      </div>
    </aside>
  )
}
