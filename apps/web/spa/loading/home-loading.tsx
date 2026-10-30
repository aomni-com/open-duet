'use client'

/* The shape of the map, before the map.

   Not a spinner and not a grey rectangle: the same composition the drive is
   about to be drawn in — Duet on the core in the middle, faces around it on the
   ring, a trunk out to each one — with nobody's name on it yet. What arrives
   then is this picture with the drive's own faces in it, rather than a new one.

   Everything here is solved rather than drawn from memory. The positions come
   out of `build`, the trunks out of `routeEdge`, the plates out of `metrics`,
   and the fit out of the same `fitScale` the camera uses at rest — so the real
   ring lands where the placeholder was instead of sliding in from somewhere
   else. This file used to copy two numbers out of the layout by hand, and the
   ring moved once already without them.

   ⚠️ It stands in for a drive of **four** agents, because a placeholder cannot
   know the real count and four is the shape the map reads best at. A drive with
   more of them arrives with a wider ring; that is one re-solve of a camera that
   is already re-solving for every wave of the load — see `useMapCamera`.

   The shapes pulse themselves. A `Skeleton` laid over the top was sized to the
   container rather than to the ring, so once the map stopped being boxed into a
   square it became an 800px disc with a small diagram somewhere inside it. */
import { useEffect, useRef, useState } from 'react'

import { ROOT_AGENT_SCOPE } from '@repo/contract'

import { centre } from '../knowledge-map/box'
import { routeEdge } from '../knowledge-map/edge-route'
import { build, CX, CY, viewport } from '../knowledge-map/layout'
import {
  AGENT_NAME_Y,
  AGENT_PLATE_RADIUS,
  AVATAR_SIZE,
  APP_LABEL_Y,
  CORE_AVATAR_SIZE,
  CORE_AVATAR_Y,
  CORE_LABEL_Y,
  CORE_META_Y,
  M,
  tileRadius,
} from '../knowledge-map/metrics'
import type { MapData, MapNode } from '../knowledge-map/types'
import { CENTRED, fitScale } from '../knowledge-map/use-map-camera'
import { framedBox } from '../knowledge-map/use-map-motion'

/**
 * The drive this stands in for: four faces, one seat each, nothing named.
 *
 * The seat is not decoration. An agent carries a fan, the fan is what the ring
 * reserves radius for, and radius is the axis the camera pays for — so a
 * placeholder of bare faces framed itself half as far back as any real drive
 * with apps on it, and handed over by *shrinking* by a third. One seat apiece
 * puts the fit within a tenth of a loaded four-agent drive, which is what makes
 * the handover a dissolve rather than a zoom.
 */
const NOBODY: MapData = {
  duet: { id: ROOT_AGENT_SCOPE, name: '', avatarKey: ROOT_AGENT_SCOPE, jobs: [], apps: [] },
  coreMeta: '',
  agents: Array.from({ length: 4 }, (_, i) => ({
    id: `slot-${i}`,
    name: '',
    avatarKey: `slot-${i}`,
    jobs: [],
    apps: [{ id: `slot-${i}-seat`, title: '', when: '', state: 'connected' as const }],
  })),
}

/* Solved once at module scope: it takes no data and no props, so a placeholder
   that rebuilt a scene on every render would be doing the map's arithmetic
   while the map itself is what the machine is busy fetching. */
const SHAPE = build(NOBODY)
const SHAPE_BOX = framedBox(SHAPE, null)!
const SHAPE_MID = centre(SHAPE_BOX)
const DENSITY = { dense: SHAPE.geom.dense, crowded: SHAPE.geom.crowded }

/* A line of words, drawn as the bar standing where they will be.

   Given the text's own baseline rather than a top edge, because the baseline is
   what the map places captions from — so the bar and the caption that replaces
   it are positioned by the same fact, and a caption that moves takes its
   placeholder with it. */
const BAR_H = 9

function CaptionBar({ baseline, width }: { baseline: number; width: number }) {
  return (
    <rect
      x={-width / 2}
      y={baseline - BAR_H + 2}
      width={width}
      height={BAR_H}
      rx={4}
      className="fill-muted-foreground/10"
    />
  )
}

function ShapeNode({ node }: { node: MapNode }) {
  if (node.kind === 'core') {
    return (
      <g transform={`translate(${node.pos.x} ${node.pos.y})`}>
        <circle r={M.CORE_GLOW_R} className="fill-muted-foreground/[0.06]" />
        <circle r={M.CORE_R} className="fill-muted-foreground/[0.09]" />
        {/* Duet's own tile, the one square that is always on this map */}
        <rect
          x={-CORE_AVATAR_SIZE / 2}
          y={CORE_AVATAR_Y - CORE_AVATAR_SIZE / 2}
          width={CORE_AVATAR_SIZE}
          height={CORE_AVATAR_SIZE}
          rx={tileRadius(CORE_AVATAR_SIZE)}
          className="fill-muted-foreground/20"
        />
        {/* the drive's name, and under it what it holds — see `CoreBody` */}
        <CaptionBar baseline={CORE_LABEL_Y} width={132} />
        <CaptionBar baseline={CORE_META_Y} width={92} />
      </g>
    )
  }
  if (node.kind === 'app') {
    return (
      <g transform={`translate(${node.pos.x} ${node.pos.y})`}>
        <rect
          x={-M.APP_R}
          y={-M.APP_R}
          width={M.APP_R * 2}
          height={M.APP_R * 2}
          rx={tileRadius(M.APP_R * 2)}
          className="fill-muted-foreground/[0.13]"
        />
        <CaptionBar baseline={APP_LABEL_Y} width={40} />
      </g>
    )
  }
  if (node.kind === 'agent' || node.kind === 'add') {
    const side = node.kind === 'agent' ? AVATAR_SIZE : M.ADD_R * 2
    return (
      <g transform={`translate(${node.pos.x} ${node.pos.y})`}>
        <rect
          x={-side / 2}
          y={-side / 2}
          width={side}
          height={side}
          rx={node.kind === 'agent' ? AGENT_PLATE_RADIUS : tileRadius(side)}
          className={
            node.kind === 'agent' ? 'fill-muted-foreground/[0.16]' : 'fill-muted-foreground/[0.09]'
          }
        />
        <CaptionBar baseline={AGENT_NAME_Y} width={node.kind === 'agent' ? 64 : 84} />
      </g>
    )
  }
  return null
}

export function HomeLoadingIsland({ label }: { label: string }) {
  /* Measured, exactly as the map measures — the placeholder's whole job is for
     the real ring to land where it already was. A square box on a landscape
     window put these discs somewhere the map never draws, and every agent slid
     sideways the moment the data arrived. Square is the only honest guess before
     layout has happened, and it is corrected in the frame the element gets a
     size. */
  const ref = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState(() => viewport(1, 1))
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect) setView(viewport(rect.width, rect.height))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /* The camera at rest, without the camera: what it framed, centred and whole.
     `fitScale` rather than a `preserveAspectRatio` that would land near enough —
     near enough is a ring that steps sideways the moment the data arrives. */
  const scale = fitScale(SHAPE_BOX, view, CENTRED.margin)

  return (
    <div
      className="grid h-full min-h-0 place-items-center bg-background"
      /* Every page-level wait in the product carries this, named for the
         destination that owns it in `loading-route.ts`. One selector answers
         "is a reader waiting on a page right now", which is what rule 1 of
         `loading/README.md` claims and what the cache-continuity gate
         measures. */
      data-loading-view="agents-map"
      aria-busy="true"
      aria-label={label}
    >
      <div ref={ref} className="relative grid size-full min-h-0 place-items-center">
        <svg
          viewBox={view.box}
          className="size-full animate-pulse motion-reduce:animate-none"
          aria-hidden
        >
          <g
            transform={`translate(${CX - scale * SHAPE_MID.x} ${CY - scale * SHAPE_MID.y}) scale(${scale})`}
          >
            {/* Rim to rim, the way the map draws them: a line from the middle of
                the core would be a line drawn through Duet's face. */}
            {SHAPE.links.map(link => {
              const from = SHAPE.byId.get(link.from)
              const to = SHAPE.byId.get(link.to)
              if (from === undefined || to === undefined) return null
              return (
                <path
                  key={`${link.from}-${link.to}`}
                  d={routeEdge(from.pos, to.pos, from, to, DENSITY)}
                  className="stroke-muted-foreground/20"
                  strokeWidth={1.5}
                  strokeDasharray="2 6"
                  strokeLinecap="round"
                  fill="none"
                />
              )
            })}
            {SHAPE.nodes.map(node => (
              <ShapeNode key={node.id} node={node} />
            ))}
          </g>
        </svg>
      </div>
    </div>
  )
}
