'use client'

import './knowledge-map.css'

import { useTranslations } from 'next-intl'
/* ============================================================================
   KnowledgeMap — a portrait of a workspace, rather than a list of it.

     <KnowledgeMap data={data} zoom={zoom} onZoom={setZoom}>{surface}</KnowledgeMap>

   Your core knowledge sits at the centre with Duet standing on it, your agents
   ring it, and every agent carries the apps it can reach — three of them, and
   then one node for however many are left. That is the whole ring: nothing
   opens, nothing fans out, nothing grows sideways.

   Everything else about an agent is *inside* it. Click a face and the camera
   flies into it and the agent's own surface unfolds over the canvas — its jobs
   by state, its skills, its files, and the one conversation that deploys them.
   Clicking the core does the same for Duet. It is one canvas and one motion;
   there is no route change and no second page.

   ---- how the work is divided ----
     layout.ts                  data -> a scene. Pure, tested, no DOM.
     palette.ts / kinds.ts      the two colour axes, each single-sourced.
     map-node.tsx               what a node of each kind looks like.
     use-map-motion.ts          where things are: one rAF loop, refs, no state.
     use-map-camera.ts          the solved fit. Nobody drives it.

   React owns what exists; the motion loop owns where it is. A scene of sixty
   nodes tweening through React state would be thousands of renders a second.
   ========================================================================= */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { usePrefersReducedMotion } from '@repo/ui/hooks/use-prefers-reduced-motion'

import { leavesAgent } from './keys'
import {
  build,
  carriedBy,
  CORE_ID,
  CX,
  CY,
  familyIds,
  linkKey,
  sparkKey,
  SPARKS,
  viewport,
  nearestDrawnNode,
} from './layout'
import { agentIsLive, pulseStyle } from './live'
import { LivePeek, type PeekWords } from './live-peek'
import { MapNodeView, type NodeContext } from './map-node'
import type { Agent, AppItem, Job, Link, MapData, MapNode } from './types'
import { CENTRED, useMapCamera, type Framing } from './use-map-camera'
import { restingCamera, useMapMotion } from './use-map-motion'
import { useRefRegistry } from './use-ref-registry'

/* What the host is told when something on the ring is opened. Apps are the only
   thing on the ring that leads anywhere else — an agent and the core lead
   *inward*, and that is `zoom`, not this. Still a tagged shape rather than a
   bare pair, so the day a second kind of node earns a place out here the
   consumers narrow on `kind` instead of being rewritten. */
export type KnowledgeMapOpen =
  | { kind: 'apps'; agent: Agent; app: AppItem }
  /* One agent's work in flight. `job` is null for the hub and for the mark that
     stands for the rest: both of them mean the whole list. */
  | { kind: 'jobs'; agent: Agent; job: Job | null }

/**
 * Who you are looking inside. The core is Duet; it is not a ring member.
 *
 * There used to be a third variant — `jobs`, which moved the camera onto one
 * agent's work without unfolding anything. It was the first half of a two-step
 * that no longer exists: work opens in one click now, inside the agent. See the
 * spec's *Reversals*.
 */
export type KnowledgeMapZoom = { kind: 'core' } | { kind: 'agent'; agent: Agent }

export type KnowledgeMapProps = {
  data: MapData
  /** who is unfolded. Controlled, because the surface inside it is the host's. */
  zoom?: KnowledgeMapZoom | null
  onZoom?: (zoom: KnowledgeMapZoom | null) => void
  /** the built-in mascot. Defaults to the same path `AgentAvatar` uses. */
  duetAvatarSrc?: string
  /** an app was clicked. The map does not decide what that opens. */
  onOpen?: (event: KnowledgeMapOpen) => void
  /**
   * the add slot was clicked. Which *kind* of agent — hired or written — is
   * the host's question to ask, and it asks it in a dialog: the map draws one
   * seat because the drive gains one seat either way.
   */
  onAddAgent?: () => void
  /** fires once the opening animation has come to rest and nothing is moving */
  onSettled?: () => void
  /**
   * Which finish the map wears. A finish, not a layout: no look moves a node,
   * changes what a colour means, or adds anything to the scene — see the
   * `data-look` block in the stylesheet.
   *
   * `laser` is the default because the drive is an instrument, and ground the
   * ring is measured against says that better than an empty field does.
   */
  look?: 'signal' | 'aurora' | 'laser'
  className?: string
  /**
   * An agent pointed at from off the map — the rail's rows.
   *
   * Kept apart from this component's own `hover`, which is the pointer on the
   * ring and drives captions. A row three hundred pixels away pointing at a
   * face is a different claim and earns a louder mark.
   */
  highlightId?: string | null
}

const DUET_AVATAR = '/icons/duet-avatar.png'

/* The product's own hover-card timings — see `relay-status.tsx`. Long enough
   that sweeping the pointer across the ring opens nothing, short enough that
   stopping on a face feels like the answer to stopping. The close is shorter
   than the open so leaving is never sticky. */
const PEEK_IN_MS = 150
const PEEK_OUT_MS = 120

export function KnowledgeMap({
  data,
  zoom = null,
  onZoom,
  duetAvatarSrc = DUET_AVATAR,
  onOpen,
  onAddAgent,
  onSettled,
  look = 'laser',
  highlightId = null,
  className,
}: KnowledgeMapProps) {
  const t = useTranslations('duetApp.knowledgeMap')
  /* Hover is deliberately *not* part of the navigation state. It changes on
     every pointer move across the ring, and while it lived in the same object
     the scene memo saw a new focus each time and rebuilt the whole layout to
     light up a caption. It drives one class name, so it is kept on its own. */
  const [hover, setHover] = useState<string | null>(null)
  /* Which working agent has a card open. Separate from `hover` above for the
     same reason `hover` is separate from the scene: it changes on a timer rather
     than on a pointer move, and only a handful of faces can ever set it. */
  const [peekId, setPeekId] = useState<string | null>(null)
  const peekTimer = useRef<number | undefined>(undefined)
  const reduced = usePrefersReducedMotion()

  /* Two memos, not one, and the split is a performance contract rather than
     tidiness: `build` depends on the data alone, so opening a branch re-places
     six nodes and returns the other hundred and fifty *by reference*. Folding
     the open id into `build` measured 0% node identity across the toggle, which
     means every memoised view on the map re-rendered — including twenty faces
     and a dozen duotone icons — for an interaction that moved six dots. */
  const resting = useMemo(() => build(data), [data])
  const scene = resting
  const focusId = zoom === null ? null : zoom.kind === 'core' ? CORE_ID : zoom.agent.id
  /* Every zoom unfolds a surface over the canvas now, so every one of them
     waits for a hole to be measured. The exception was the branch, which was
     drawn *on* the canvas rather than over it. */
  const unfolded = zoom !== null

  /* The map is drawn into whatever shape it is given, so the viewBox is measured
     rather than declared. It starts square because that is the only honest guess
     before layout has happened; the observer corrects it in the same frame the
     element gets a size, and the camera re-solves for the new shape. */
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState(() => viewport(1, 1))
  const viewRef = useRef(view)
  viewRef.current = view

  /* The hole the surface leaves for the face, once the surface has laid it out.
     The tick is what tells the framing effect a different element is in play —
     a ref alone changes nothing React can see. */
  /* Where the camera was last aimed, and at whom. A ref rather than a local,
     because the effect that aims is re-created on every viewBox change and
     "have I already flown into this agent" has to outlive that. */
  const aimed = useRef<{ focus: string | null; framing: Framing | null }>({
    focus: null,
    framing: null,
  })

  const camGroupRef = useRef<SVGGElement | null>(null)
  const nodeRefs = useRef(new Map<string, SVGGElement>())
  const edgeRefs = useRef(new Map<string, SVGPathElement>())
  const registerNode = useRefRegistry(nodeRefs)
  const registerEdge = useRefRegistry(edgeRefs)
  const centre = useMemo(() => ({ x: CX, y: CY }), [])
  const camera = useRef(restingCamera(centre))

  const wake = useMapMotion({
    scene,
    rootRef,
    camRef: camGroupRef,
    nodeRefs,
    edgeRefs,
    camera,
    centre,
    reduced,
    onSettled,
  })
  const cam = useMapCamera({ camera, scene, view: viewRef, reduced, wake })

  /* What an opened branch frames: the Jobs seat, the jobs under it, and the
     agent the whole thing hangs off — the reader needs to see whose work this
     is. Memoised so a data tick that changes nothing about the branch does not
     hand the framing effect a new array and make it look like a navigation. */
  const framed = useMemo(
    () => (focusId === null || unfolded ? null : [...(familyIds(scene, focusId) ?? [])]),
    [focusId, scene, unfolded],
  )

  /* The camera re-solves when the *focus* changes and at no other time. Framing
     the focused node alone rather than its family is what makes the flight read
     as going inside something: the ring keeps travelling outwards past the edge
     while the surface unfolds, instead of politely shrinking to fit.

     And it is not framed into the middle. The surface that unfolds leaves a hole
     of clear canvas for exactly this — so the face you flew
     into is still the face you are looking at, with its own trunk running off
     under the glass towards the core. A small copy of it in a card would be a
     picture of the agent; this is the agent.

     A resize re-aims rather than re-navigating: the hole moves, the camera
     follows it, and the reader keeps their place. */
  const { frameTo, reframe } = cam
  useEffect(() => {
    if (focusId === null) {
      /* Nothing is aimed at any more, so the next agent starts a fresh flight —
         including the one you just left, which you are entitled to fly back
         into. */
      aimed.current = { focus: null, framing: null }
      frameTo(null)
      return
    }
    /* One framing for every focus, and it arrives without a flight.

       There used to be two: an opened branch framed centred, and an unfolded
       agent aimed at a *hole* the surface left for it — the camera measured
       that gap through a ref and flew the clicked face into it. The surface
       draws its own portrait now, so there is no gap to measure, nothing to
       fly, and no second case. What is left is what the branch always did. */
    aimed.current = { focus: focusId, framing: CENTRED }
    frameTo(framed, CENTRED, false)
  }, [focusId, frameTo, framed])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setView(prev => {
        const next = viewport(rect.width, rect.height)
        return Math.abs(next.w - prev.w) < 0.5 && Math.abs(next.h - prev.h) < 0.5 ? prev : next
      })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /* A resize arrives rather than flies — nobody navigated, the window changed
     shape, and half a second of camera travel for that is the map moving on its
     own. Inside an agent the hole is what the camera aims at and the observer
     above is already watching it, so this only answers for the ring at rest.

     ⚠️ It re-solves for a **view** change and nothing else, and the guard is the
     whole point rather than an optimisation. `focusId` used to be a dependency,
     so leaving a zoom ran this in the same commit as the flight home — and
     `reframe(false)` means *arrive*, so it cut the camera to the destination on
     the first frame. Measured: the flight in took 45 frames and 555ms, and the
     flight out took one frame and 50ms. Going in flew, coming out snapped, and
     the two had not looked alike since the effect was written. */
  const reframedFor = useRef(view)
  useEffect(() => {
    if (reframedFor.current === view) return
    reframedFor.current = view
    if (focusId === null) reframe(false)
  }, [view, reframe, focusId])

  /* Nothing here watches the data for the camera. The map arrives in waves —
     the ring, then the fans, then the job rows, from three reads that answer
     independently — and a host counting agents only ever saw the first of them.
     `useMapCamera` watches the box it framed instead, which is every wave and
     nothing else. */

  const close = useCallback(() => onZoom?.(null), [onZoom])

  /* Escape is the way out of anything that covers the page, and the surface
     inside is full of controls that would otherwise swallow the click that
     closes it.

     Bubble phase, and `leavesAgent` is why: a layer opened inside the surface
     answers Escape first, and the map must only fly out when none did. See
     `keys.ts` — this listener staying on bubble is what makes that check able to
     see the answer at all. */
  useEffect(() => {
    if (focusId === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (leavesAgent(event)) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, focusId])

  const hit = useCallback(
    (node: MapNode) => {
      switch (node.kind) {
        case 'core':
          onZoom?.({ kind: 'core' })
          return
        case 'agent':
          onZoom?.({ kind: 'agent', agent: node.data })
          return
        case 'app':
          onOpen?.({ kind: 'apps', agent: node.agent, app: node.data })
          return
        case 'more':
          /* The rest of the apps live on the agent, so this opens the agent.
             Anywhere else would be a screen that does not exist — and Duet's own
             overflow opens Duet, which is the core rather than a ring member. */
          onZoom?.(
            node.parent === CORE_ID ? { kind: 'core' } : { kind: 'agent', agent: node.agent },
          )
          return
        /* One click, straight to the work. There used to be two — the first
           flew the camera onto the branch so the row could lay itself out with
           titles, the second opened the dialog — and it cost a click on every
           route to the only thing the branch leads to. The intermediate state
           was never a destination: the dialog holds the same list better, with
           all four buckets and the conversation beside it.

           The seat and the overflow both mean the whole list, so neither names
           a row; a bead names its own. What "no row" resolves to is the host's
           business, not the map's — see the route. */
        case 'jobs':
        case 'jobsMore':
          onOpen?.({ kind: 'jobs', agent: node.agent, job: null })
          return
        case 'job':
          onOpen?.({ kind: 'jobs', agent: node.agent, job: node.data })
          return
        case 'add':
          onAddAgent?.()
      }
    },
    [onAddAgent, onOpen, onZoom],
  )

  /* Pointing at a working face opens its card, and pointing anywhere else shuts
     it — both on a delay, so crossing the ring on the way somewhere else opens
     nothing. One timer, because the two are the same decision arriving twice. */
  const onHover = useCallback((node: MapNode | null) => {
    setHover(node ? (node.parent ?? node.id) : null)
    const id = node !== null && node.kind === 'agent' && agentIsLive(node.data) ? node.id : null
    window.clearTimeout(peekTimer.current)
    peekTimer.current = window.setTimeout(
      () => setPeekId(id),
      id === null ? PEEK_OUT_MS : PEEK_IN_MS,
    )
  }, [])

  useEffect(() => () => window.clearTimeout(peekTimer.current), [])

  /* Inside an agent the card would be a small copy of the surface it is standing
     under, in front of the surface it is standing under. */
  useEffect(() => {
    if (focusId !== null) setPeekId(null)
  }, [focusId])

  /* Required to be stable: MapNodeView is memoised on it. */
  const ctx = useMemo<NodeContext>(
    () => ({
      dense: scene.geom.dense,
      crowded: scene.geom.crowded,
      jobTitles: scene.geom.jobTitles,
      duetAvatarSrc,
      say: {
        addAgent: t('addAgent'),
        more: count => t('moreApps', { count }),
        openAgent: name => t('openAgent', { name }),
        /* The card an agent's rim promises is a picture, so what it says has to
           be said in the label too — an indicator only half the readers can
           perceive is not an indicator. */
        openLiveAgent: (name, count) => t('openLiveAgent', { name, count }),
        openApp: title => t('openApp', { title }),
        jobs: t('jobs'),
        moreJobs: t('moreJobs'),
        openJobs: name => t('openJobs', { name }),
        openJob: title => t('openJob', { title }),
      },
    }),
    [scene.geom.crowded, scene.geom.dense, scene.geom.jobTitles, duetAvatarSrc, t],
  )

  const peekWords = useMemo<PeekWords>(
    () => ({
      running: count => t('peek.running', { count }),
      more: count => t('peek.more', { count }),
      asking: count => t('peek.asking', { count }),
      onClock: count => t('peek.onClock', { count }),
    }),
    [t],
  )

  /* What the rail is pointing at, resolved to something the ring actually
     drew. The list shows every app and every job; this seats three and five and
     folds the rest, so a row can name work that has no node — and the mark it
     hides behind is the honest place to point instead. */
  const flagged =
    highlightId === null ? null : nearestDrawnNode(highlightId, id => scene.byId.has(id))
  const peeked = peekId === null ? undefined : scene.byId.get(peekId)
  const peekAgent = peeked?.kind === 'agent' && focusId === null ? peeked.data : null

  /* What the surface grew out of stays lit behind it; dimming all of it would
     make the flight look like a page swap. The face itself is never in
     question, because it is the thing you flew into. */
  const family = useMemo(() => new Set(familyIds(scene, focusId) ?? []), [scene, focusId])
  /* The branch that is put away while you are inside it — the nodes, and every
     limb with an end in them. Read once here rather than per edge, because
     `carriedBy` asks each node who owns it and there are sixty of them. */
  const gone = useMemo(
    () => new Set(scene.nodes.filter(n => carriedBy(n, focusId)).map(n => n.id)),
    [scene, focusId],
  )

  return (
    <div
      ref={rootRef}
      className={`knowledge-map${className ? ` ${className}` : ''}`}
      data-dense={scene.geom.dense ? 'true' : 'false'}
      data-look={look}
      data-level={focusId ? '1' : '0'}
    >
      <svg
        viewBox={view.box}
        tabIndex={0}
        role="application"
        aria-label={t('canvas')}
        className="km-svg"
        onClick={close}
      >
        <defs>
          {/* warm-neutral, and no state colour at all: the core is where every
              agent's knowledge sits, not something that is doing anything */}
          <radialGradient id="km-core-glow" cx="50%" cy="46%" r="62%">
            <stop offset="0%" stopColor="var(--km-fg)" stopOpacity="0.05" />
            <stop offset="46%" stopColor="var(--km-core-in)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--km-core-out)" stopOpacity="1" />
          </radialGradient>
        </defs>

        <g ref={camGroupRef}>
          <g className="km-edges">
            {scene.links.map(link => (
              <path
                key={linkKey(link)}
                ref={registerEdge(linkKey(link))}
                className={edgeClass(link, family, focusId, gone)}
              />
            ))}
          </g>

          {/* The sparks are their own layer rather than a sibling of each wire:
              they are the brightest thing on the canvas and they must never be
              painted over by whichever trunk happens to be drawn after them.

              `pathLength` is what makes one duration mean one speed. The dash
              pattern is declared in fractions of the line it travels, so a spark
              crosses a trunk in the same beat whatever the fleet size did to the
              ring's radius — and the stylesheet never has to be told a length. */}
          <g className="km-sparks" aria-hidden="true">
            {scene.links
              .filter(link => link.live === true)
              .map(link => (
                /* One group per trunk, carrying that agent's own place in the
                   beat — see `pulseStyle`. Every comet on this wire and the
                   flare waiting at the end of it read their clock from here, so
                   a lead, its echo, and the ring they strike can never drift
                   apart from each other while the ring drifts apart from its
                   neighbours. */
                <g key={linkKey(link)} style={pulseStyle(link.to)}>
                  {SPARKS.map(index => (
                    <path
                      key={index}
                      ref={registerEdge(sparkKey(link, index))}
                      pathLength={1}
                      className={sparkClass(link, index, family, focusId)}
                    />
                  ))}
                </g>
              ))}
          </g>

          <g className="km-nodes">
            {scene.nodes.map(node => (
              <MapNodeView
                key={node.id}
                node={node}
                ctx={ctx}
                className={nodeClass(node, family, focusId, hover, flagged)}
                registerRef={registerNode(node.id)}
                onHit={hit}
                onHover={onHover}
              />
            ))}
          </g>
        </g>
      </svg>

      {/* A sibling of the canvas rather than a portal: it has to be positioned
          against the map's own box. Keyed on the focus so going from one agent
          straight to another replays the unfold instead of swapping the words
          inside a panel that never moved.

          The entrance is CSS, and the panel's own half of it moves nothing but
          `transform`. Animation is an enhancement here exactly as it is in the
          motion loop: a throttled tab, a backgrounded one, or anything else that
          stops the frames must leave a panel you can read. A tween that owns
          `opacity` cannot promise that — it leaves the surface at whatever
          fraction of itself it had reached. The scrim behind it fades, because a
          scrim that never arrives is just a sharper picture. */}
      {/* Keyed on the agent so moving from one working face to another replays
          the card's own entrance rather than swapping the words inside a panel
          that slides across the map. */}
      {peekAgent !== null && (
        <LivePeek
          key={peekAgent.id}
          agent={peekAgent}
          words={peekWords}
          rootRef={rootRef}
          nodeRefs={nodeRefs}
        />
      )}
    </div>
  )
}

/* Three depths, and then a fourth thing that is not a depth: the focused node
   stays lit, the rest of the ring drops out of the way *and* stops taking
   pointer events, and the apps that agent carries are not drawn at all. A node
   you cannot properly see is never one you can accidentally click. */
function nodeClass(
  node: MapNode,
  family: ReadonlySet<string>,
  focus: string | null,
  hover: string | null,
  /* Pointed at from somewhere else on screen — the rail's rows. Not folded into
     `hover`: that one is this map's own pointer and drives captions, and a row
     three hundred pixels away is a different claim that deserves a louder mark. */
  highlight: string | null,
): string {
  const classes = ['km-n']
  if (focus !== null && !family.has(node.id)) classes.push('km-dim')
  if (node.id === focus) classes.push('km-on')
  if (carriedBy(node, focus)) classes.push('km-gone')
  /* Pointing at an agent brings the names of its own apps back, and nobody
     else's. Past seven agents that is the only way to read one. */
  if (focus === null && hover !== null && (node.id === hover || node.parent === hover)) {
    classes.push('km-cap')
  }
  if (highlight !== null && node.id === highlight) classes.push('km-flag', 'km-cap')
  return classes.join(' ')
}

function edgeClass(
  link: Link,
  family: ReadonlySet<string>,
  focus: string | null,
  gone: ReadonlySet<string>,
): string {
  const classes = ['km-edge', `km-${link.kind}`]
  if (link.dashed === true) classes.push('km-dashed')
  /* The wire an agent is working on is tinted, not lit: the spark above it is
     the saturated half of the pair, and a dozen radii at full strength would be
     a starburst rather than a map. */
  if (link.live === true) classes.push('km-live')
  if (focus !== null && !(family.has(link.from) && family.has(link.to))) classes.push('km-faint')
  /* A limb joins an agent to something it carries, so a limb anywhere inside the
     branch you are standing in is a line to a node that is no longer drawn. It
     goes with them rather than being left pointing into the glass. Both ends are
     tested, not just the near one: a job hangs off the Jobs seat, so its limb
     leaves a node that is itself already gone. */
  if (link.kind === 'limb' && (gone.has(link.from) || gone.has(link.to))) classes.push('km-gone')
  return classes.join(' ')
}

/* The comet steps back with its wire, but not as far. Under the glass this is
   the one thing on the canvas still saying the agent you are reading about is
   working while you read — a trunk at a sixth of its ink is a hairline, and a
   comet at a sixth of its is nothing at all.
 *
 * Everything after the first is an echo: the same comet, smaller, a beat behind.
 * Which one an element is decides only how it is painted, so it is a class
 * rather than a second element type. */
function sparkClass(
  link: Link,
  spark: number,
  family: ReadonlySet<string>,
  focus: string | null,
): string {
  const classes = ['km-spark']
  if (spark > 0) classes.push('km-spark-echo')
  if (focus !== null && !(family.has(link.from) && family.has(link.to))) classes.push('km-faint')
  return classes.join(' ')
}
