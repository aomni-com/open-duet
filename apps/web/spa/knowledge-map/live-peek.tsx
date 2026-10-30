'use client'

/* ============================================================================
   What a working agent is actually doing, without going inside it.

   The ring says *that* something is happening — the trunk pulses, the plate
   wears a rim — and this is the one place on the map that says *what*, at the
   moment you point at the face. It is a peek and nothing more: no controls, no
   scroll, no links. Everything in it is one click away in the agent's own
   surface, which has room for all of it; a card that tried to be that surface in
   two hundred pixels would be a worse copy of a thing you can already open.

   ---- it is HTML, and it is outside the canvas ----
   The map is SVG and its captions are drawn into the scene, which is right for a
   name on a picture and wrong for a paragraph: `<text>` does not wrap, does not
   ellipsize, and cannot hold a progress bar. And a card drawn *inside* the
   camera group would be scaled by the camera along with everything else, so a
   twelve-agent ring would set this in seven-pixel type, and it would be clipped
   by the edge of the canvas exactly where the ring is closest to it — which is
   where cards are needed most.

   So it is a sibling of the canvas, positioned against the map's own box, and
   the one thing it borrows from the scene is where the face it belongs to
   currently is.
   ========================================================================= */
import { useEffect, useRef, type RefObject } from 'react'

import { liveWork } from './live'
import { M } from './metrics'
import type { Agent } from './types'

/** Already translated by the map, because a pure module cannot ask for words. */
export type PeekWords = {
  /** `2 running` — the count in the header, beside the name */
  running: (count: number) => string
  /** the sessions this card had no room for */
  more: (count: number) => string
  /** stopped, and waiting on you */
  asking: (count: number) => string
  /** running, but asleep until its alarm goes off */
  onClock: (count: number) => string
}

/* Three, and then a count. Four running sessions is a normal Tuesday and a card
   that lists all of them is taller than the map it is floating over — at which
   point it stops being a peek and starts being a panel that happens to have no
   scrollbar. */
const MAX_ROWS = 3

/** Clear air between the plate and the card, and between the card and the frame. */
const GAP = 14
const EDGE = 10

export type LivePeekProps = {
  agent: Agent
  words: PeekWords
  /** the map's own box: the card is placed inside it, never outside */
  rootRef: RefObject<HTMLElement | null>
  /** where the faces currently are — the card is placed off the one it is about */
  nodeRefs: RefObject<Map<string, SVGGElement>>
}

export function LivePeek({ agent, words, rootRef, nodeRefs }: LivePeekProps) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  usePeekPlacement(cardRef, rootRef, nodeRefs, agent.id)

  const work = liveWork(agent)
  const shown = work.jobs.slice(0, MAX_ROWS)
  const hidden = work.jobs.length - shown.length
  const waiting = [
    work.asking > 0 ? words.asking(work.asking) : null,
    work.onClock > 0 ? words.onClock(work.onClock) : null,
  ].filter(line => line !== null)

  return (
    /* Hidden from assistive technology on purpose. Nothing in here is reachable
       any other way than by pointing at a face, everything in it is stated again
       inside the agent, and the node itself already says in its own label how
       many sessions are running. A live region that fires every time a pointer
       crosses the ring would be the opposite of an accessibility win. */
    <div ref={cardRef} className="km-peek" aria-hidden="true">
      <p className="km-peek-head">
        <span className="km-peek-live" />
        <span className="km-peek-who">{agent.name}</span>
        <span className="km-peek-count">{words.running(work.jobs.length)}</span>
      </p>
      <ul className="km-peek-jobs">
        {shown.map(job => (
          <li key={job.id} className="km-peek-job">
            <div className="km-peek-lead">
              <p className="km-peek-title">{job.title}</p>
              {job.step === undefined && job.progress === undefined && (
                <span className="km-peek-when">{job.when}</span>
              )}
            </div>
            {job.step !== undefined && <p className="km-peek-step">{job.step}</p>}
            {(job.step !== undefined || job.progress !== undefined) && (
              <p className="km-peek-foot">
                {/* The bar is drawn only when the relay actually reported a
                    fraction. A bar at nought for a job that never reports one
                    reads as a job that has not started. */}
                {job.progress !== undefined && (
                  <span className="km-peek-bar">
                    <span
                      className="km-peek-fill"
                      style={{ width: `${Math.round(clamp01(job.progress) * 100)}%` }}
                    />
                  </span>
                )}
                <span className="km-peek-when">{job.when}</span>
              </p>
            )}
          </li>
        ))}
      </ul>
      {(hidden > 0 || waiting.length > 0) && (
        /* What is *not* in flight, counted rather than listed — a card about
           what is happening should not be mostly a list of what is not. */
        <p className="km-peek-rest">
          {[hidden > 0 ? words.more(hidden) : null, ...waiting].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  )
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Which side of the face the card stands on. */
type Side = 'left' | 'right'

function flip(side: Side): Side {
  return side === 'left' ? 'right' : 'left'
}

/**
 * Keep the card beside the face it belongs to.
 *
 * The face's position is not in React — it is a transform the motion loop
 * writes each frame — so the card follows it the same way, off a ref, rather
 * than through state it would re-render sixty times a second to read.
 *
 * `getScreenCTM` rather than the node's bounding rect: a node's rect is its
 * plate *and its caption*, so it is as wide as the agent's name and half again
 * as tall, and a card hung off the side of it drifts left as the name gets
 * longer. The CTM gives the node's own origin and the scale it is drawn at, so
 * the card is placed off the plate — which is the thing the reader is pointing
 * at.
 *
 * The loop runs for as long as the card is open and then stops dead. That is a
 * deliberate exception to the rule that governs the map's own loop: parking
 * matters there because a map left open all afternoon must cost nothing, and a
 * card is open for as long as a pointer rests on a face. One matrix and one
 * rect a frame, for two seconds.
 */
function usePeekPlacement(
  cardRef: RefObject<HTMLDivElement | null>,
  rootRef: RefObject<HTMLElement | null>,
  nodeRefs: RefObject<Map<string, SVGGElement>>,
  agentId: string,
): void {
  useEffect(() => {
    const card = cardRef.current
    const root = rootRef.current
    if (card === null || root === null) return

    let raf = 0
    const place = (): void => {
      raf = requestAnimationFrame(place)
      const node = nodeRefs.current?.get(agentId)
      const ctm = node?.getScreenCTM()
      const box = root.getBoundingClientRect()
      if (!ctm || box.width < 1) return

      const x = ctm.e - box.left
      const y = ctm.f - box.top
      /* The plate at the scale it is currently drawn at, which is the camera's
         business and changes with the size of the fleet. */
      const reach = M.AGENT_R * ctm.a + GAP

      /* The card stands on whichever side of the face has more room, which for a
         ring means the side facing the middle of the map: an agent is near the
         frame by definition — that is where the ring is — and the canvas it
         leaves free is on the other side of it. Then the flip, for the case the
         rule gets wrong, and if neither side fits the preference stands and the
         clamp below is what keeps the card on the map. */
      const fits = (side: Side): boolean =>
        side === 'left'
          ? x - reach - card.offsetWidth >= EDGE
          : x + reach + card.offsetWidth <= box.width - EDGE
      const want: Side = x >= box.width / 2 ? 'left' : 'right'
      const side = fits(want) ? want : fits(flip(want)) ? flip(want) : want

      card.dataset.side = side
      card.style.setProperty(
        '--km-peek-x',
        `${(side === 'left' ? x - reach : x + reach).toFixed(1)}px`,
      )
      /* Centred on the face, then held inside the frame — a card that hangs off
         the bottom is a card whose last row is the one you wanted. */
      const half = card.offsetHeight / 2
      const top = Math.min(
        Math.max(y, half + EDGE),
        Math.max(half + EDGE, box.height - half - EDGE),
      )
      card.style.setProperty('--km-peek-y', `${top.toFixed(1)}px`)
    }

    place()
    return () => cancelAnimationFrame(raf)
  }, [agentId, cardRef, nodeRefs, rootRef])
}
