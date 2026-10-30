'use client'

import { WarningCircle } from '@phosphor-icons/react'
/* ============================================================================
   The drive, as a portrait of itself.

   Presentational: it takes a `MapData` and reports what was opened. The route
   above owns the queries and every destination — this file decides only what
   the surface looks like while the ring is loading, empty, or broken.

   It is deliberately full-bleed. Every other destination sits inside
   `WorkspacePage`'s centred, padded column, which is right for a document and
   wrong for a map: the camera already solves its own framing, so a second set
   of margins just makes the picture smaller.
   ========================================================================= */
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'

import {
  KnowledgeMap,
  type KnowledgeMapOpen,
  type KnowledgeMapProps,
  type KnowledgeMapZoom,
} from '../../knowledge-map/knowledge-map'
import type { MapData } from '../../knowledge-map/types'
import { HomeLoadingIsland } from '../../loading/home-loading'

/* How long the shape and the map share the canvas. It is the `duration-500` on
   both halves of the dissolve below, said once in a place React can read: the
   element has to outlive its own fade, and a number that drifted from the class
   beside it would either cut the fade short or leave a dead layer on the map. */
const HANDOFF_MS = 500

export type KnowledgeMapHomeProps = {
  data: MapData
  state: 'loading' | 'error' | 'ready'
  /** who is unfolded on the canvas, and the surface that draws them */
  zoom?: KnowledgeMapZoom | null
  onZoom?: (zoom: KnowledgeMapZoom | null) => void
  onOpen: (event: KnowledgeMapOpen) => void
  onAddAgent?: () => void
  onRetry?: () => void
  /** the playground waits on this before it screenshots */
  onSettled?: () => void
  /** which finish the map wears — see `KnowledgeMapProps['look']` */
  look?: KnowledgeMapProps['look']
  /** an agent the rail's pointer is on, marked on the ring */
  highlightId?: string | null
}

export function KnowledgeMapHome({
  data,
  state,
  zoom = null,
  onZoom,
  onOpen,
  onAddAgent,
  onRetry,
  onSettled,
  look,
  highlightId = null,
}: KnowledgeMapHomeProps) {
  const t = useTranslations('duetApp.homeSurface')
  /* The island stands for the whole destination opening, which is what the
     shell's own bootstrap island says while the route is still arriving — one
     sentence for one wait, rather than a second phrasing of it here. */
  const tApp = useTranslations('duetApp')

  /* Whether the shape is still on the canvas, which outlives `state === 'loading'`
     by exactly the length of the dissolve below. Held here rather than left to
     an exit animation library: the whole handoff is one opacity on one element,
     and the only thing React has to be told is when to stop drawing it. */
  const [shape, setShape] = useState(state === 'loading')
  useEffect(() => {
    if (state === 'loading') {
      setShape(true)
      return
    }
    if (!shape) return
    const timer = setTimeout(() => setShape(false), HANDOFF_MS)
    return () => clearTimeout(timer)
  }, [shape, state])

  if (state === 'error') {
    return (
      <HomeState
        icon={<WarningCircle aria-hidden size={24} weight="duotone" />}
        title={t('errorTitle')}
        description={t('errorBody')}
        action={
          onRetry ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t('retry')}
            </Button>
          ) : undefined
        }
      />
    )
  }

  /* An empty ring is not an empty picture, and this surface used to answer it
     with a paragraph. Duet is never on the ring — `listAgents` has never
     returned it — so a drive with no agents still has its centre, the face
     standing on it, and the add slot asking for the first one. Drawing the map
     is both the truer answer and the one that teaches the surface: the reader
     whose roster is empty is the reader who has never seen it. */

  /* No padding on the page, and that is the point: the canvas is the page. It
     used to be inset `px-4 py-6`, which put sixteen pixels of page between the
     window and the map on the sides and twenty-four on the top — and then the
     unfolded surface added its own gap inside that, so the panels stood
     twenty-six pixels off one edge and thirty-four off another. Two frames,
     neither of them square, and the second one measured against the first. The
     map keeps itself off the window with the fade it already draws at its own
     edges, and the one number that spaces this surface is `--km-gap`. */
  return (
    /* The canvas box, and every measurement the map makes is of this element.
       That is the whole mechanism: the roster beside it changes this box's
       width, the map's own `ResizeObserver` sees it, and the camera re-solves
       into what is left. Nothing here has to be told about a roster, and the
       roster has to be told nothing about a camera.

       The `<main>`, the section heading and the roster column all moved out to
       `agents-section` — this destination is one of two that share them, and
       spelling them here made the canvas the owner of a frame it only borrows. */
    <div className="relative grid h-full min-h-0 min-w-0 place-items-center overflow-hidden">
      {/* Not the real map at seventy per cent, which is what stood here.

            The picture is made of three reads that answer independently, so a
            map drawn on the first of them is a map of a drive that does not
            exist: a ring whose agents carry nothing, framed by a camera that
            has solved for it. Then the fans land and it is wrong, and the jobs
            land and it is wrong again — twice re-framed, in front of somebody
            who has been looking at it since the first frame.

            So the shape of the map stands in until the drive is known, and the
            first thing drawn from data is the whole of it. `HomeLoadingIsland`
            is that shape, and it is solved from the same layout and framed by
            the same fit, so what replaces it is this composition with faces in
            it rather than a different picture. */}
      {state !== 'loading' && (
        <KnowledgeMap
          highlightId={highlightId}
          data={data}
          zoom={zoom}
          onZoom={onZoom}
          onOpen={onOpen}
          onAddAgent={onAddAgent}
          onSettled={onSettled}
          look={look}
          /* The map arrives *under* the shape it was standing behind, which
               is why it fades in rather than cutting: for one frame its camera
               has only the square viewBox every map is born with, and the fade
               is what that frame is spent on. */
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500"
        />
      )}
      {/* The shape leaves by dissolving into what replaced it, over the same
            half second, in the same place. Both are on the canvas at once and
            both are the same composition, so the plates do not travel — a face
            resolves where a blank one stood. A skeleton that unmounted on the
            frame the data landed is a picture *replacing* a picture, which is
            the flicker every loading state is trying not to be.

            `pointer-events-none` from the first frame of the handoff: it is on
            top for half a second, and a map you cannot click for half a second
            after it appears is a map that feels broken rather than smooth. */}
      {shape && (
        <div
          aria-hidden={state !== 'loading'}
          data-leaving={state !== 'loading'}
          className="pointer-events-none absolute inset-0 transition-opacity duration-500 data-[leaving=true]:opacity-0 motion-reduce:transition-none"
        >
          <HomeLoadingIsland label={tApp('loadingIslandLabel')} />
        </div>
      )}
    </div>
  )
}

function HomeState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  /* A div rather than a `<main>`, and an `h2` rather than an `h1`. This is
     drawn inside the agents section, which owns both the landmark and the
     section's heading for every destination under `/agents` — either one here
     would be the second on the page, and the section's claim to own them says
     "and nowhere under it". */
  return (
    <div className="grid h-full min-h-0 place-items-center bg-background px-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        <h2 className="font-serif text-lg font-normal italic tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
        {action}
      </div>
    </div>
  )
}
