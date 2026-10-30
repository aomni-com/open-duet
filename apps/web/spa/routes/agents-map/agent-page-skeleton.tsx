'use client'

/* ============================================================================
   The shape of an agent, before the agent.

   The ring has had one of these since it stopped drawing itself at seventy per
   cent — `HomeLoadingIsland` is the map's own composition with nobody's name in
   it, solved from the same layout so the real faces land where the placeholder
   was. This is that promise kept on the other route: the agent's page drawn in
   its own two columns, so what replaces it is this composition with a face and
   a conversation in it rather than a different picture.

   It borrows the surface's own classes rather than approximating them with
   utilities. `.km-sheet` is where the two columns and their proportions are
   declared, `.km-well` is the cluster's box, `.km-chat` and `.km-card` are the
   panels — so the bars below stand exactly where the real thing will, at every
   width, including the one where the container query restacks the cluster. A
   hand-built lookalike is a second copy of a layout that has already moved
   once.

   What it does NOT do is guess. There is no bar where the agent's slug goes,
   because plenty of agents have none; no chips for child agents, because most
   have none; and nothing at all in the card's stage, because what opens there
   is chosen by the reader's own arranged row and a placeholder that picked one
   would be a picture of somebody else's drive. Under-drawing resolves into the
   truth. Over-drawing has to be taken away again, and that reads as a fault. */
import { useTranslations } from 'next-intl'

import { Skeleton } from '@repo/ui/components/shadcn/skeleton'

import { SectionHead } from './agent-surface/parts'

/* One class on every bar. The map's own reduced-motion rule covers what it
   draws inside the canvas; these are DOM beside it, so they say it themselves —
   a page that pulses at somebody who asked for stillness is worse than a page
   that simply waits. */
const BAR = 'motion-reduce:animate-none'

export function AgentPageSkeleton({ label }: { label: string }) {
  const t = useTranslations('duetApp.agentSurface')
  return (
    <section
      role="status"
      aria-busy="true"
      aria-label={label}
      // The family marker every page-level wait carries; see `home-loading.tsx`.
      data-loading-view="agent-page"
      className="km-sheet"
    >
      <div className="km-sheet-left">
        <div className="km-well">
          {/* The face, at the size the face is: `--km-well` is the box both this
              and the real avatar are laid into, so the portrait resolves in
              place instead of arriving beside where it was waited for. */}
          <Skeleton className={`km-face rounded-[28%] ${BAR}`} />
          <div className="km-ident">
            <div className="km-well-cap grid gap-2">
              <Skeleton className={`h-6 w-40 max-w-full ${BAR}`} />
            </div>
            {/* The two doors under the name — Train and Settings — which are
                the one part of this cluster every agent has. There were three
                while Jobs stood beside them; a skeleton that keeps drawing a
                door the page no longer has is a bar that has to be taken away
                again when the read lands, which reads as a fault. */}
            <div className="km-well-acts flex flex-wrap gap-2">
              <Skeleton className={`h-7 w-20 rounded-lg ${BAR}`} />
              <Skeleton className={`h-7 w-24 rounded-lg ${BAR}`} />
            </div>
          </div>
        </div>

        <div className="km-chat">
          {/* The panel's own heading, from the component that draws it on the
              real surface — it is the one thing on this page already known
              while the agent is not, and a grey rectangle standing in for a
              word nobody is waiting for is a worse answer than the word. */}
          <SectionHead title={t('chat')} />
          <div className="grid content-start gap-3 p-1">
            <Skeleton className={`h-4 w-3/5 justify-self-end ${BAR}`} />
            <Skeleton className={`h-4 w-4/5 ${BAR}`} />
            <Skeleton className={`h-4 w-2/5 ${BAR}`} />
          </div>
        </div>
      </div>

      {/* The card, with its selector strip and an empty stage. Which face of the
          agent opens there is the reader's own arrangement, so this draws the
          room and not a guess at what fills it. */}
      <div className="km-card">
        <header className="km-picker flex gap-2">
          <Skeleton className={`h-7 w-24 rounded-lg ${BAR}`} />
          <Skeleton className={`h-7 w-20 rounded-lg ${BAR}`} />
          <Skeleton className={`h-7 w-20 rounded-lg ${BAR}`} />
        </header>
        <div className="km-stage" />
      </div>
    </section>
  )
}
