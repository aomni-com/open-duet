'use client'

/* ============================================================================
   The one animation loop, and the camera it drives.

   React owns what exists on the map. It does not own where anything is: node
   positions and the camera are written straight onto `transform` attributes
   from a single requestAnimationFrame loop, and edge paths are recomputed in
   the same frame so a line never trails the node it joins.

   That split is the whole reason this is fast. A scene of sixty nodes tweening
   at 60 Hz through React state would be 3,600 renders a second; through refs it
   is zero. React re-renders only when the *scene* changes — a navigation, or
   data arriving — which is a handful of times a minute.

   The easing is per-millisecond rather than per-frame, so 60 Hz and 120 Hz feel
   identical.

   ---- and the loop really does park ----
   It used to say it did while re-scheduling itself forever; what it skipped was
   the DOM writes, which is a different and much smaller saving. On a landing
   page that is left open all afternoon the difference is the whole cost. So
   `draw` reports whether anything moved and `step` stops asking for frames when
   nothing did.

   Parking is only safe if every way the map can start moving again also wakes
   it, so this returns the one way in and hands it out. There are three: a new
   scene (React put different nodes on the map), a tab coming back to the
   foreground, and a new camera target — which is why `useMapCamera` *requires*
   this function rather than being trusted to remember. The scene used to change
   identity whenever the focus did, so the camera got its frames for free; once
   the ring stopped being rebuilt around what you were looking at, a flight
   would start and then park half way there, leaving the map at a scale nobody
   had asked for. One wake is enough: a moving camera keeps asking for the next
   frame by itself.
   ========================================================================= */
import { useCallback, useEffect, useRef, type RefObject } from 'react'

import { unionAll, at as boxAt } from './box'
import { routeEdge } from './edge-route'
import { linkKey, sparkKey, SPARKS, VIEW } from './layout'
import { bodyBox, labelScale, size } from './metrics'
import type { Box, MapNode, Scene, Vec } from './types'

export type CameraState = {
  /** where it is */
  s: number
  x: number
  y: number
  /** where it is going */
  ts: number
  tx: number
  ty: number
  /** where it set off from */
  fs: number
  fx: number
  fy: number
  /** the world point the eye is following across the flight */
  anchor: Vec
  /** when this flight began, on the same clock rAF is stamped with */
  t0: number
  /** how long it takes. Zero means "be there already". */
  dur: number
}

export function restingCamera(centre: Vec): CameraState {
  return {
    s: 1,
    x: centre.x,
    y: centre.y,
    ts: 1,
    tx: centre.x,
    ty: centre.y,
    fs: 1,
    fx: centre.x,
    fy: centre.y,
    anchor: centre,
    t0: 0,
    dur: 0,
  }
}

/**
 * How long the flight takes.
 *
 * Short enough that clicking a face feels like the answer to the click, long
 * enough that the eye can stay on the face the whole way. Under about 400ms the
 * ring reads as a cut rather than as a move; past about 700ms you are waiting
 * for a picture you have already understood.
 */
export const FLIGHT_MS = 520

/* Starts still, ends still, and does most of the distance in the middle. The
   camera used to ease exponentially, which is the opposite shape: fastest on
   the very first frame — a jump cut — and then a long asymptotic crawl that
   never quite lands. That is what made the map read as being yanked. */
function ease(u: number): number {
  return u * u * (3 - 2 * u)
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Whether a flight is still running.
 *
 * Asked by whoever is about to re-aim, because "re-solve the framing" and "cut
 * to it" are two decisions and only the first of them belongs to a caller that
 * has merely re-measured. Flying into an agent solves twice within a frame or
 * two — once when the surface mounts and once when the viewBox lands as state —
 * and the second solve used to arrive as a cut, so the flight was killed a
 * heartbeat after it started. Flying back out solves once and was never cut,
 * which is why leaving felt smooth and arriving felt abrupt.
 */
export function flying(cam: CameraState, now: number): boolean {
  return cam.dur > 0 && now - cam.t0 < cam.dur
}

/** Point this camera at a solved framing, following `anchor` as it goes. */
export function flyTo(
  cam: CameraState,
  to: { s: number; x: number; y: number },
  anchor: Vec,
  now: number,
  dur: number,
): void {
  cam.fs = cam.s
  cam.fx = cam.x
  cam.fy = cam.y
  cam.ts = to.s
  cam.tx = to.x
  cam.ty = to.y
  cam.anchor = anchor
  cam.t0 = now
  cam.dur = dur
}

/**
 * One frame of the flight. Returns whether it is still going.
 *
 * Two things make it calm rather than dizzying.
 *
 * The zoom is interpolated in log space, because scale is multiplicative: a
 * straight lerp from 0.6 to 1.4 spends most of its time near the far end and
 * then rushes the last, which the eye reads as the world lunging at it.
 *
 * And the pan is solved *backwards* from the anchor. What the reader is
 * following is one point — the face — so that point is put on a straight line
 * across the screen and the camera goes wherever that requires. Tweening the
 * camera's own x, y and scale directly is three separate races to the same
 * finish line, and the face swings through an arc while they run.
 */
export function advance(cam: CameraState, now: number, instant: boolean): boolean {
  const u = instant || cam.dur <= 0 ? 1 : (now - cam.t0) / cam.dur
  if (u >= 1) {
    cam.s = cam.ts
    cam.x = cam.tx
    cam.y = cam.ty
    return false
  }
  const e = ease(u < 0 ? 0 : u)
  const s = Math.exp(lerp(Math.log(cam.fs), Math.log(cam.ts), e))
  /* Where the anchor sits on screen at each end, in screen units off centre. */
  const x0 = (cam.anchor.x - cam.fx) * cam.fs
  const x1 = (cam.anchor.x - cam.tx) * cam.ts
  const y0 = (cam.anchor.y - cam.fy) * cam.fs
  const y1 = (cam.anchor.y - cam.ty) * cam.ts
  cam.s = s
  cam.x = cam.anchor.x - lerp(x0, x1, e) / s
  cam.y = cam.anchor.y - lerp(y0, y1, e) / s
  return true
}

type MotionArgs = {
  scene: Scene
  /** the map's own element, which is where the type scale is declared */
  rootRef: RefObject<HTMLElement | null>
  camRef: RefObject<SVGGElement | null>
  nodeRefs: RefObject<Map<string, SVGGElement>>
  edgeRefs: RefObject<Map<string, SVGPathElement>>
  camera: RefObject<CameraState>
  centre: Vec
  reduced: boolean
  /** set once the first frame has settled, so a screenshot never lands mid-tween */
  onSettled?: () => void
}

/* How coarsely the caption counter-scale is written. See the write site: this
   number is the difference between one style recalc a flight and a hundred. */
const HOLD_STEP = 0.05

const NODE_EASE = 0.115
const STILL = 0.05
/* A wake holds the loop open for a beat even if the first frame it draws
   reports nothing moving — a target set a microsecond before the frame runs has
   not moved anything yet. */
const AWAKE_MS = 400

/* ---- the watchdog ----
   Frames are not owed to anybody. A tab that is backgrounded, throttled, or
   never composited at all gets none of them, or a handful and then nothing, and
   the map has to be a correct drawing in every one of those cases. A half-eased
   map is not a paused animation — it is wrong: a node is born at its parent, so
   an app that stopped a third of the way is an app sitting *on* the face it
   hangs off, with its caption under the agent's name.

   That is what shipped. The watchdog only ever asked "has a frame arrived?",
   which covers the tab that never gets one and misses the tab whose frames stop
   halfway — measured live at `translate(1056.73,700)` for a node whose place is
   `translate(1164,700)`, with the fan maths perfectly correct. So the question
   it asks now is the one that matters: is anything still travelling with nobody
   left to move it? */
export type WatchdogSeen = {
  /** a frame was drawn since the last time this was asked */
  drew: boolean
  /** something is still short of where the scene says it belongs */
  travelling: boolean
}

/** `land` snaps the layout by hand; `rest` stops watching until the next wake. */
export type WatchdogAction = 'watch' | 'land' | 'rest'

export function watchdogAction({ drew, travelling }: WatchdogSeen): WatchdogAction {
  if (drew) return 'watch'
  return travelling ? 'land' : 'rest'
}

const WATCHDOG_MS = 250

export function useMapMotion({
  scene,
  rootRef,
  camRef,
  nodeRefs,
  edgeRefs,
  camera,
  centre,
  reduced,
  onSettled,
}: MotionArgs): () => void {
  /* The loop reads these through refs rather than closing over them, so a new
     scene does not restart the animation mid-flight. */
  const sceneRef = useRef(scene)
  sceneRef.current = scene
  const settledRef = useRef(false)
  const settleRef = useRef(onSettled)
  settleRef.current = onSettled

  /* Where each node currently *is*, as opposed to where the scene says it
     belongs. Survives re-renders; new nodes are born at their parent. */
  const live = useRef(new Map<string, Vec>())

  /* The one way back in once the loop has parked. Held on a ref because the
     effect below owns it and everything else only ever calls it. */
  const wake = useRef<() => void>(undefined)

  useEffect(() => {
    const positions = live.current
    /* Say out loud whether the loop is parked. `onSettled` fires once per
       settle, which suits a caller waiting for the opening tween — but a
       resize re-aims the camera and settles it again, and anything watching
       from outside the page has no way to ask "is it moving now?". Without an
       answer the only test available is "two readings a beat apart agreed",
       which certifies the previous viewport's framing whenever the re-aim has
       not started yet, and reports the result as geometry: a face overlapping
       a name by 26px on a different shape each run. */
    const announceSettled = (settled: boolean): void => {
      document.body.dataset.knowledgeMapSettled = settled ? 'true' : 'false'
    }
    let raf = 0
    let last = 0
    /** a frame has been drawn since the watchdog last looked */
    let ticked = false
    /** something is short of where it belongs, so somebody still has to move it */
    let travelling = true
    let awakeUntil = 0
    /** the counter-scale the captions are currently held at */
    let heldText = ''
    /** and how many pixels a world unit is worth, for the DOM beside them */
    let heldScreen = ''
    /* What was last written to each element, keyed on the element itself.
       "Has the position changed?" is the wrong test for "does the DOM need
       writing?": a node that starts at its target never moves, and an element
       React has just re-created has no transform but has not moved either — so
       both get skipped forever. Keying the memo on the element makes a fresh one
       always get written, which is exactly the distinction that matters. This is
       what put the core — the one node born at its own target — at the origin,
       off-canvas, with everything else correct around it. */
    const written = new WeakMap<Element, string>()
    /* The CSS property, not the SVG presentation attribute of the same name.
       They mean the same transform and they cost very different things: the
       attribute goes through SVG's own layout path and re-rasterises the
       subtree, while `style.transform` is the property browsers hardware-
       accelerate and composite. Measured on the open-a-branch flight, the
       attribute spent 986ms in RasterTask across two seconds.

       `transform-box` defaults to `view-box` and `transform-origin` to `0 0` on
       SVG elements, so `translate(Xpx,Ypx)` here is the same user-space move
       the attribute expressed — the px unit is a user unit, not a screen one. */
    const move = (el: SVGElement, value: string): void => {
      if (written.get(el) === value) return
      el.style.transform = value
      written.set(el, value)
    }

    /* Path data has no CSS equivalent worth using, so this stays an attribute
       write — and it is the expensive half of this loop for exactly the reason
       the transform above was moved off it: `d` re-tessellates the path. */
    const put = (el: Element, attr: string, value: string): void => {
      if (written.get(el) === value) return
      el.setAttribute(attr, value)
      written.set(el, value)
    }

    /* Animation is an enhancement, never the thing that makes the map correct.
       A tab that is throttled, backgrounded or simply never granted a frame gets
       no rAF at all — and the old shape of this loop left the map frozen part
       way through its opening tween, which looks like a layout bug rather than a
       paused animation. `settle` is one instant frame: same code, k = 1.

       Returns whether anything is still travelling, which is what decides
       whether there is any point asking for another frame. */
    const draw = (dtms: number, instant: boolean, now: number): boolean => {
      const dt = Math.min(dtms, 64)
      const k = instant || reduced ? 1 : 1 - Math.pow(1 - NODE_EASE, dt / 16.7)

      const current = sceneRef.current
      const cam = camera.current
      const ctx = { dense: current.geom.dense, crowded: current.geom.crowded }
      let moving = false

      for (const node of current.nodes) {
        const el = nodeRefs.current.get(node.id)
        if (!el) continue
        let pos = positions.get(node.id)
        if (!pos) {
          const parent = node.parent ? positions.get(node.parent) : undefined
          pos = { x: parent?.x ?? centre.x, y: parent?.y ?? centre.y }
          positions.set(node.id, pos)
        }
        const dx = node.pos.x - pos.x
        const dy = node.pos.y - pos.y
        if (Math.abs(dx) > STILL || Math.abs(dy) > STILL) {
          pos.x += dx * k
          pos.y += dy * k
          moving = true
        } else {
          pos.x = node.pos.x
          pos.y = node.pos.y
        }
        move(el, `translate(${pos.x.toFixed(2)}px,${pos.y.toFixed(2)}px)`)
      }

      if (advance(cam, now, instant || reduced)) moving = true
      const camEl = camRef.current
      if (camEl) {
        move(
          camEl,
          `translate(${(centre.x - cam.s * cam.x).toFixed(2)}px,${(centre.y - cam.s * cam.y).toFixed(2)}px) ` +
            `scale(${cam.s.toFixed(4)})`,
        )
      }

      /* The words do not travel with the picture. Everything under the camera
         group is scaled by it, which is right for a drawing and wrong for a name
         — so the type scale is handed the inverse and the stylesheet multiplies
         every tier by it. One custom property a frame rather than a transform
         per caption, and it is written on the map's own element rather than on
         the camera group because that is where the tiers are declared: a custom
         property is substituted where it is *computed*, so setting it further
         down would change nothing. */
      const holdEl = rootRef.current
      if (holdEl) {
        /* Quantised, because this one number invalidates the style of every
           caption on the map: the tiers are `calc(var(--km-t2) * var(--km-hold))`
           and font-size is a layout property, so a fresh value each frame is a
           full style recalc plus a text re-measure, 155 times a flight. Five
           per cent steps are invisible on eleven-pixel type in motion and cut
           the invalidations by an order of magnitude. */
        const hold = (Math.round(labelScale(cam.s) / HOLD_STEP) * HOLD_STEP).toFixed(2)
        if (hold !== heldText) {
          holdEl.style.setProperty('--km-hold', hold)
          heldText = hold
        }
        /* How many screen pixels one world unit is worth, right now. The
           surface that unfolds sets the agent's name in the DOM, and that name
           is standing on this canvas beside captions the camera *is* scaling —
           on a 2560 the app under the face was set half again larger than the
           agent it belongs to. One number a frame, and the DOM can be set in
           the map's own tiers.

           The viewBox is `VIEW` on its short side whatever shape the map is, so
           a world unit is worth `height / VIEW` pixels and the width cancels. */
        const screen = (
          Math.round((cam.s * holdEl.clientHeight) / VIEW / HOLD_STEP) * HOLD_STEP
        ).toFixed(2)
        if (screen !== heldScreen) {
          holdEl.style.setProperty('--km-screen', screen)
          heldScreen = screen
        }
      }

      /* Edges last, in the same frame, so a line never trails the node it joins.
         The routing is recomputed every frame and the write is what gets
         skipped — cheap, and it means a re-created path cannot keep a stale `d`
         the way the nodes could keep a missing transform. */
      for (const link of current.links) {
        const path = edgeRefs.current.get(linkKey(link))
        const a = positions.get(link.from)
        const b = positions.get(link.to)
        const fromNode = current.byId.get(link.from)
        const toNode = current.byId.get(link.to)
        if (!path || !a || !b || !fromNode || !toNode) continue
        const d = routeEdge(a, b, fromNode, toNode, ctx)
        put(path, 'd', d)
        /* Every comet rides the wire it belongs to, so the line is solved once
           and written to all of them. Travelling it is the stylesheet's
           business — this only owns the line they travel along. */
        for (const index of SPARKS) {
          const spark = edgeRefs.current.get(sparkKey(link, index))
          if (spark) put(spark, 'd', d)
        }
      }

      if (!moving && !settledRef.current) {
        settledRef.current = true
        announceSettled(true)
        settleRef.current?.()
      }
      if (moving && settledRef.current) {
        settledRef.current = false
        announceSettled(false)
      }
      return moving
    }

    const step = (now: number): void => {
      ticked = true
      travelling = draw(last ? now - last : 16.7, false, now)
      last = now
      /* Parked, until someone calls `start` again. `raf = 0` is what tells
         `start` there is no frame already in flight. */
      raf = travelling || now < awakeUntil ? requestAnimationFrame(step) : 0
    }

    /* Re-armed rather than repeating, so a map at rest is holding no timer. It
       stops itself: an instant draw lands everything, so the check after one
       always answers `rest`. */
    let guard = 0
    const watch = (): void => {
      if (guard !== 0) return
      guard = window.setTimeout(() => {
        guard = 0
        const action = watchdogAction({ drew: ticked, travelling })
        ticked = false
        if (action === 'rest') return
        if (action === 'land') travelling = draw(16.7, true, performance.now())
        watch()
      }, WATCHDOG_MS)
    }

    const start = (): void => {
      awakeUntil = performance.now() + AWAKE_MS
      watch()
      if (raf !== 0) return
      /* A fresh `last` — the gap since the loop parked is not a frame time. */
      last = 0
      raf = requestAnimationFrame(step)
    }
    wake.current = start

    /* A tab that comes back from the background has a stale in-between layout on
       screen and a `last` from minutes ago; land it before resuming. */
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      last = 0
      draw(16.7, true, performance.now())
      start()
    }
    document.addEventListener('visibilitychange', onVisible)

    watch()
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(guard)
      wake.current = undefined
      document.removeEventListener('visibilitychange', onVisible)
      delete document.body.dataset.knowledgeMapSettled
    }
    /* centre and reduced are the only inputs that would change the loop itself;
       everything else is read through a ref on purpose. */
  }, [camRef, camera, centre, edgeRefs, nodeRefs, reduced, rootRef])

  /* A new scene: React has just put different elements on the map, and an
     element it re-created carries no transform at all until this loop writes
     one. */
  useEffect(() => {
    wake.current?.()
  }, [scene])

  /* Drop remembered positions for nodes that have left, or the map slowly
     accumulates one entry per agent ever added. */
  useEffect(() => {
    const alive = new Set(scene.nodes.map(n => n.id))
    for (const id of live.current.keys()) if (!alive.has(id)) live.current.delete(id)
  }, [scene])

  /* Stable, because the camera closes over it and every node on the map is
     memoised on the identity of what the camera hands down. */
  return useCallback(() => wake.current?.(), [])
}

/**
 * The box the camera has to fit: the union of what these nodes paint into.
 *
 * `bare` drops the caption reserve and frames the bodies alone. Holding the
 * whole map means holding its words; flying into one face means putting that
 * face somewhere, and a reserve that is twice as wide as the plate and hangs
 * below it lands the face high and left of the gap it was aimed at.
 */
export function framedBox(scene: Scene, ids: readonly string[] | null, bare = false): Box | null {
  const wanted = ids ? scene.nodes.filter(inSet(ids)) : scene.nodes
  const nodes: readonly MapNode[] = wanted.length ? wanted : scene.nodes
  const density = { dense: scene.geom.dense, crowded: scene.geom.crowded }
  const box = (n: MapNode): Box => (bare ? bodyBox(n) : size(n, density))
  return unionAll(nodes.map(n => boxAt(box(n), n.pos)))
}

/** A membership test that is not quadratic in the number of nodes. */
function inSet(ids: readonly string[]): (n: MapNode) => boolean {
  const set = new Set(ids)
  return n => set.has(n.id)
}
