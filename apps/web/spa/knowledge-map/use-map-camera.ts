'use client'

/* ============================================================================
   The camera nobody drives.

   There is no pan, no wheel-zoom, no drag. The map is always centred on what
   you are looking at and always whole — the reader chooses *what* is in focus
   by clicking, and the system decides where the eye goes. A picture you can
   shove off-screen is a picture that can be wrong; this one cannot be.

   So the entire surface is: give me a focus, I solve the box it needs and tween
   there. `frameTo` when the focus changes, `reframe` when the container does.

   That deletion took a lot of trouble with it. There is no drag threshold, so a
   click is never swallowed as a gesture. There is no `setPointerCapture`, which
   used to retarget the compatibility `click` to the <svg> and silently break
   every node's own handler. And there is no "the reader moved it" flag for a
   resize to have to respect.
   ========================================================================= */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'

import { centre as centreOf, height, same, width } from './box'
import type { Viewport } from './layout'
import type { Box, Scene, Vec } from './types'
import { flyTo, FLIGHT_MS, framedBox, type CameraState } from './use-map-motion'

/* The solve is clamped so a lone agent does not fill the screen with one face,
   and a crowded ring stays legible rather than shrinking without limit. */
export const MIN_SCALE = 0.34
/* A drive with one agent should sit in the middle of the frame with air around
   it, not fill it. At 1.9 a two-slot ring was 92% of the width and its captions
   were the first thing the edge took. */
export const MAX_SCALE = 1.45

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * The scale that holds `box` inside `view`, with `pad` to spare.
 *
 * Pure, and exported so the type floor can be proven against the scales the map
 * actually reaches rather than against a range somebody picked: what makes a
 * caption unreadable is the camera pulling back, so the two have to be tested
 * together or the promise is only made on paper.
 *
 * Each axis is fitted against its own side of the box. They used to share one
 * number, which was true only while the surface was square — on a wide one it
 * framed to the width the map did not have and cut the rest off.
 */
export function fitScale(box: Box, view: { w: number; h: number }, margin: number): number {
  /* The margin is a share of the short side rather than a number of view units,
     because a view unit means a different fraction of the surface on every
     window: a fixed 64 was a tenth of the room on a phone and a twentieth on a
     desktop, so the same solve left different amounts of air — and on the wide
     one it left less than the surface's own edge fade takes. */
  const air = Math.min(view.w, view.h) * margin
  return clamp(
    Math.min(
      (view.w - air * 2) / Math.max(width(box), 1),
      (view.h - air * 2) / Math.max(height(box), 1),
    ),
    MIN_SCALE,
    MAX_SCALE,
  )
}

/**
 * Where on the surface the framed nodes are put, and how much of it they get.
 *
 * The map is centred by default and that is the whole story at rest. It stops
 * being the whole story once a surface unfolds over the canvas: the thing you
 * flew *into* has to stay where you can see it, and the middle of the screen is
 * exactly where the panels are. So a framing can ask for a corner and for a
 * fraction of the room, and the agent's own face keeps standing in the gap the
 * panels leave for it rather than being replaced by a small copy in a card.
 *
 * Fractions of the surface rather than pixels, because the surface is whatever
 * shape the window is and the panels are laid out in fractions too.
 */
export type Framing = {
  /** where the framed box's centre lands, 0–1 across and down */
  at: Vec
  /** how much of the surface it has to fit inside, 0–1 */
  fit: Vec
  /** air around it, as a share of the surface's short side */
  margin: number
  /** frame the bodies alone, without the room their captions reserve */
  bare?: boolean
}

/* Nine per cent a side. The surface fades its outer 3.5% out under a mask, so
   anything less than that is not margin at all — it is the part of the picture
   the edge is already eating. The rest is composition: the map is a portrait,
   and a portrait wants a mount. */
export const CENTRED: Framing = { at: { x: 0.5, y: 0.5 }, fit: { x: 1, y: 1 }, margin: 0.09 }

type CameraArgs = {
  camera: RefObject<CameraState>
  scene: Scene
  /** the live viewBox, which tracks the container's shape */
  view: RefObject<Viewport>
  /** an instant cut instead of a flight */
  reduced: boolean
  /**
   * Ask the motion loop for frames.
   *
   * Required rather than optional, because a solve that nobody draws is the
   * worst kind of camera bug: the numbers are right, the picture is not, and
   * nothing in the code looks wrong. The loop parks when nothing is moving, and
   * a new target is exactly a thing it cannot see coming.
   */
  wake: () => void
}

export type CameraControls = {
  /** frame these nodes, or the whole scene when null */
  frameTo: (ids: readonly string[] | null, framing?: Framing, fly?: boolean) => void
  /** re-solve the current framing, for a container that changed shape */
  reframe: (fly?: boolean) => void
}

export function useMapCamera({ camera, scene, view, reduced, wake }: CameraArgs): CameraControls {
  const sceneRef = useRef(scene)
  sceneRef.current = scene
  const framed = useRef<{ ids: readonly string[] | null; framing: Framing }>({
    ids: null,
    framing: CENTRED,
  })
  /* The box the standing solve was made against, and the only thing that can
     say whether it still describes the map. Null until the host aims for the
     first time — see the effect below, which must not solve before it. */
  const solved = useRef<Box | null>(null)

  const solve = useCallback(
    (ids: readonly string[] | null, framing: Framing, fly: boolean): void => {
      const box = framedBox(sceneRef.current, ids, framing.bare)
      if (!box) return
      solved.current = box
      const cam = camera.current
      const mid = centreOf(box)
      const { w, h } = view.current
      const s = fitScale(box, { w: w * framing.fit.x, h: h * framing.fit.y }, framing.margin)
      /* The camera puts `cam.(x,y)` in the middle of the surface, so asking for
         a point that is not the middle is asking to look somewhere *else* by
         exactly the offset between them — measured on the surface and divided
         back through the scale to say it in world units. */
      const to = {
        s,
        x: mid.x - (w * (framing.at.x - 0.5)) / s,
        y: mid.y - (h * (framing.at.y - 0.5)) / s,
      }
      /* The middle of what was framed is what the reader is looking at, so it is
         what the flight is drawn around — see `advance`. */
      /* A resize is not a navigation. It re-solves what the reader was already
         looking at, so it arrives without a flight — half a second of camera
         motion for a window that changed shape is the map moving on its own. */
      flyTo(cam, to, mid, performance.now(), fly && !reduced ? FLIGHT_MS : 0)
      wake()
    },
    [camera, reduced, view, wake],
  )

  const frameTo = useCallback(
    (ids: readonly string[] | null, framing: Framing = CENTRED, fly = true): void => {
      framed.current = { ids, framing }
      solve(ids, framing, fly)
    },
    [solve],
  )

  const reframe = useCallback(
    (fly = true): void => solve(framed.current.ids, framed.current.framing, fly),
    [solve],
  )

  /* ---- the map arrives in waves, and the camera notices by itself ----

     A solve is a function of three things: the box it framed, the shape of the
     surface, and where on that surface the framing asked for it. Two of those
     move by somebody's hand — a click, a window — and each has an owner
     watching it. The third moves *under* the camera with nobody's hand on it:
     the map is drawn from three reads that answer independently, so a fresh
     session paints a bare ring, then fans hanging off it, then job rows under
     the fans. Each wave is larger than the one before, and a camera left where
     the first one put it stands too close for the third — the map clipped at
     the edges of a window with no pan and no zoom to go and look.

     It used to be watched from the host, on the agent count, which is one read
     of the three: the ring landing re-solved, the apps and the jobs landing did
     not. So the question is asked here instead, of the thing the solve is
     actually made of. A scene that redraws the same picture — the map's clock
     ticks once a minute, and every refetch hands the layout a new object — is
     not a change, or a reader halfway through a flight would have it re-solved
     under them on a timer.

     It flies rather than cutting. This is not a resize, where nothing about the
     picture changed and motion would be the map moving on its own; the picture
     itself grew, and the flight is what shows a reader their map opening out
     rather than jumping. Waves land while the last flight is still running, and
     `flyTo` sets off from wherever the camera has got to, so a session's worth
     of them reads as one continuous pull-back. */
  useEffect(() => {
    const was = solved.current
    if (was === null) return
    const now = framedBox(scene, framed.current.ids, framed.current.framing.bare)
    if (now === null || same(was, now)) return
    solve(framed.current.ids, framed.current.framing, true)
  }, [scene, solve])

  /* Memoised because `MapNodeView` is `memo`'d on callbacks that close over
     this object — returning a fresh one would re-render every node on every
     render of the map, which is exactly what that memo exists to prevent. */
  return useMemo(() => ({ frameTo, reframe }), [frameTo, reframe])
}
